import { randomBytes } from "node:crypto";
import { schema } from "@sling/db";
import {
  create,
  type Envelope,
  EnvelopeSchema,
  type FileReadResult,
  type FileSearchResult,
} from "@sling/runner-protocol";
import { and, eq, isNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import type { RunnerSession } from "../runners/gateway.ts";

/** Most hits one search returns. */
export const FILE_SEARCH_MAX = 50;
/** Most of a file one read returns. */
export const FILE_READ_MAX_BYTES = 256 * 1024;
/** A machine searches for 2 seconds at most; past this it isn't answering. */
const SEARCH_WAIT_MS = 10_000;
const READ_WAIT_MS = 15_000;

export interface FileHit {
  machine: string;
  folder: string;
  /** Relative to the folder. */
  path: string;
  line: number;
  snippet: string;
}

export interface FileSearchAnswer {
  hits: FileHit[];
  /** More hits than it returned, or a machine ran out of time. */
  truncated: boolean;
  /** Machines that couldn't search, and why, such as being offline or having `files off`. */
  errors: { machine: string; error: string }[];
}

export interface FileReadAnswer {
  machine: string;
  folder: string;
  path: string;
  content: string;
  truncated: boolean;
  /** The whole file's size in bytes. */
  size: number;
}

/** Why a search or a read didn't happen, in words for the assistant. */
export class FileError extends Error {}

export interface FileService {
  /**
   * Searches shared folders: on one machine when `machine` is set, or on
   * every online machine that shares any. `folder` narrows it to one.
   */
  search(
    workspaceId: string,
    opts: {
      query: string;
      machine?: string;
      folder?: string;
      maxResults?: number;
      signal?: AbortSignal;
    },
  ): Promise<FileSearchAnswer>;
  /** Reads one text file in a shared folder. Throws FileError with what the machine said. */
  read(
    workspaceId: string,
    opts: { machine: string; folder: string; path: string; signal?: AbortSignal },
  ): Promise<FileReadAnswer>;
  /** A machine's answer to a FileSearch. */
  searchResult(session: RunnerSession, result: FileSearchResult): void;
  /** A machine's answer to a FileRead. */
  readResult(session: RunnerSession, result: FileReadResult): void;
}

interface Machine {
  id: string;
  name: string;
  folders: string[];
  files: boolean;
  online: boolean;
}

interface Pending<T> {
  runnerId: string;
  resolve: (r: T) => void;
}

const newRequestId = () => `fil_${randomBytes(12).toString("hex")}`;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function names(list: string[]): string {
  return list.length ? list.join(", ") : "none";
}

/**
 * Files in the folders machines share. Only the machine knows where a folder
 * is, so every search and read runs there, and the machine refuses anything
 * outside the folders it shares.
 */
export class Files implements FileService {
  readonly #ctx: AppContext;
  readonly #searches = new Map<string, Pending<FileSearchResult>>();
  readonly #reads = new Map<string, Pending<FileReadResult>>();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  async #machines(workspaceId: string): Promise<Machine[]> {
    const rows = await this.#ctx.db
      .select({
        id: schema.runners.id,
        name: schema.runners.name,
        folders: schema.runners.folders,
        files: schema.runners.files,
      })
      .from(schema.runners)
      .where(
        and(
          eq(schema.runners.workspaceId, workspaceId),
          eq(schema.runners.ephemeral, false),
          isNull(schema.runners.revokedAt),
        ),
      );
    return rows.map((r) => ({ ...r, online: this.#ctx.runners.isOnline(r.id) }));
  }

  /** The machine a request names, by name or ID. */
  #pick(all: Machine[], want: string): Machine {
    const m = all.find((x) => x.id === want.trim() || same(x.name, want));
    if (m) return m;
    const sharing = all.filter((x) => x.folders.length > 0).map((x) => x.name);
    throw new FileError(
      `No machine named ${want}. Machines that share folders: ${names(sharing)}.`,
    );
  }

  /** Why a machine can't take a request now, or null when it can. */
  #unavailable(m: Machine): string | null {
    if (!m.online) return `${m.name} is offline, so its files can't be searched or read now.`;
    if (!m.files) {
      return `Files are off on ${m.name}. The owner turns them on there with \`sling-runner config set files on\`.`;
    }
    return null;
  }

  #ask<T>(
    pending: Map<string, Pending<T>>,
    runnerId: string,
    requestId: string,
    envelope: Envelope,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<T | "timeout" | "unreachable"> {
    return new Promise((resolve) => {
      const done = (r: T | "timeout" | "unreachable") => {
        clearTimeout(timer);
        pending.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const timer = setTimeout(() => done("timeout"), waitMs);
      const onAbort = () => done("timeout");
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.set(requestId, { runnerId, resolve: done });
      if (!this.#ctx.runners.send(runnerId, envelope)) done("unreachable");
    });
  }

  async search(
    workspaceId: string,
    opts: {
      query: string;
      machine?: string;
      folder?: string;
      maxResults?: number;
      signal?: AbortSignal;
    },
  ): Promise<FileSearchAnswer> {
    const query = opts.query.trim();
    if (!query) throw new FileError("There's nothing to search for.");
    const max = Math.max(1, Math.min(opts.maxResults ?? FILE_SEARCH_MAX, FILE_SEARCH_MAX));
    const all = await this.#machines(workspaceId);
    let targets = opts.machine
      ? [this.#pick(all, opts.machine)]
      : all.filter((m) => m.folders.length > 0);
    if (targets.length === 0 || targets.every((m) => m.folders.length === 0)) {
      throw new FileError(
        opts.machine
          ? `${targets[0]?.name ?? opts.machine} shares no folders. The owner shares one there with \`sling-runner folder add <path>\`.`
          : "No machine shares a folder with Sling. The owner shares one on the machine with `sling-runner folder add <path>`.",
      );
    }
    const folder = opts.folder?.trim();
    if (folder) {
      const having = targets.filter((m) => m.folders.some((f) => same(f, folder)));
      if (having.length === 0) {
        const shared = targets.flatMap((m) => m.folders.map((f) => `${f} on ${m.name}`));
        throw new FileError(
          `No machine shares a folder named ${folder}. Shared: ${names(shared)}.`,
        );
      }
      targets = having;
    }

    const errors: FileSearchAnswer["errors"] = [];
    const answers = await Promise.all(
      targets.map(async (m) => {
        const why = this.#unavailable(m);
        if (why) {
          errors.push({ machine: m.name, error: why });
          return null;
        }
        const folders = folder ? m.folders.filter((f) => same(f, folder)) : [];
        const requestId = newRequestId();
        const r = await this.#ask(
          this.#searches,
          m.id,
          requestId,
          create(EnvelopeSchema, {
            body: { case: "fileSearch", value: { requestId, query, folders, maxResults: max } },
          }),
          SEARCH_WAIT_MS,
          opts.signal,
        );
        if (r === "timeout") {
          errors.push({ machine: m.name, error: `${m.name} didn't answer in time.` });
          return null;
        }
        if (r === "unreachable") {
          errors.push({ machine: m.name, error: `${m.name} is offline.` });
          return null;
        }
        if (r.error) {
          errors.push({ machine: m.name, error: r.error.slice(0, 500) });
          return null;
        }
        return { machine: m, result: r };
      }),
    );

    const hits: FileHit[] = [];
    let truncated = false;
    for (const a of answers) {
      if (!a) continue;
      truncated ||= a.result.truncated;
      for (const h of a.result.hits) {
        if (hits.length >= max) {
          truncated = true;
          break;
        }
        hits.push({
          machine: a.machine.name,
          folder: h.folder.slice(0, 120),
          path: h.path.slice(0, 1000),
          line: h.line,
          snippet: h.snippet.slice(0, 300),
        });
      }
    }
    return { hits, truncated, errors };
  }

  async read(
    workspaceId: string,
    opts: { machine: string; folder: string; path: string; signal?: AbortSignal },
  ): Promise<FileReadAnswer> {
    const m = this.#pick(await this.#machines(workspaceId), opts.machine);
    const why = this.#unavailable(m);
    if (why) throw new FileError(why);
    const folder = m.folders.find((f) => same(f, opts.folder));
    if (!folder) {
      throw new FileError(
        `${m.name} doesn't share a folder named ${opts.folder}. It shares ${names(m.folders)}.`,
      );
    }
    const requestId = newRequestId();
    const r = await this.#ask(
      this.#reads,
      m.id,
      requestId,
      create(EnvelopeSchema, {
        body: {
          case: "fileRead",
          value: { requestId, folder, path: opts.path, maxBytes: FILE_READ_MAX_BYTES },
        },
      }),
      READ_WAIT_MS,
      opts.signal,
    );
    if (r === "timeout") throw new FileError(`${m.name} didn't answer in time.`);
    if (r === "unreachable") throw new FileError(`${m.name} is offline.`);
    if (r.error) throw new FileError(r.error.slice(0, 500));
    return {
      machine: m.name,
      folder,
      path: opts.path,
      content: r.content.slice(0, FILE_READ_MAX_BYTES),
      truncated: r.truncated,
      size: Number(r.size),
    };
  }

  searchResult(session: RunnerSession, result: FileSearchResult): void {
    const p = this.#searches.get(result.requestId);
    // Only the machine a request went to may answer it.
    if (p?.runnerId === session.runnerId) p.resolve(result);
  }

  readResult(session: RunnerSession, result: FileReadResult): void {
    const p = this.#reads.get(result.requestId);
    if (p?.runnerId === session.runnerId) p.resolve(result);
  }
}
