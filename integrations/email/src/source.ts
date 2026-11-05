/**
 * The email event source. One IMAP connection per watched folder: IDLE when
 * the server has it, polling when it doesn't. Each folder keeps a mark of the
 * highest UID handed to workflows, so restarts neither repeat nor backfill.
 */
import type {
  EventSource,
  EventSourceFactory,
  SourceContext,
  SourceStatus,
} from "@sling/connector-sdk";
import type { ImapFlow, MailboxObject } from "imapflow";
import { type Backoff, backoffDelay, DEFAULT_BACKOFF, errorMessage, sleep } from "./backoff.ts";
import { closeImap, imapClient, imapErrorMessage } from "./clients.ts";
import { parseEmail } from "./parse.ts";
import { type EmailConfig, type EmailCredentials, RECEIVED_EVENT } from "./schemas.ts";

type Ctx = SourceContext<EmailCredentials, EmailConfig>;

export interface EmailSourceOptions {
  /** How often to check for mail when the server has no IDLE. */
  pollIntervalMs?: number;
  /** Use IDLE when the server supports it. Off forces polling. */
  idle?: boolean;
  /** Quiet time before the client starts IDLE after its last command. */
  autoIdleDelayMs?: number;
  /** IDLE is restarted this often, so a silently dropped connection gets noticed. */
  maxIdleTimeMs?: number;
  backoff?: Backoff;
}

/** Bytes of a message downloaded at most. The body text comes first, attachments later. */
export const SOURCE_LIMIT = 10 * 1024 * 1024;

export interface UidMark {
  uidValidity: string;
  uid: number;
}

export function markKey(folder: string): string {
  return `uid:${folder}`;
}

export function dedupeKey(folder: string, uidValidity: string, uid: number): string {
  return `${folder}:${uidValidity}:${uid}`;
}

function parseMark(raw: string | null): UidMark | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UidMark>;
    if (typeof value.uidValidity === "string" && Number.isInteger(value.uid)) {
      return { uidValidity: value.uidValidity, uid: value.uid as number };
    }
  } catch {}
  return null;
}

export function createEmailSource(
  options: EmailSourceOptions = {},
): EventSourceFactory<EmailCredentials, EmailConfig> {
  return {
    async start(ctx): Promise<EventSource> {
      const controller = new AbortController();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const folders = [...new Set(ctx.config.folders?.length ? ctx.config.folders : ["INBOX"])];
      const board = new StatusBoard(ctx, folders);
      const watchers = folders.map((folder) =>
        watchFolder(ctx, folder, options, signal, (status, detail) =>
          board.update(folder, status, detail),
        ).catch((error: unknown) => {
          ctx.log.error("Email watcher stopped unexpectedly", {
            folder,
            error: errorMessage(error),
          });
          board.update(folder, "error", errorMessage(error));
        }),
      );
      return {
        async stop() {
          controller.abort();
          await Promise.all(watchers);
        },
      };
    },
  };
}

/** Folds per-folder status into one installation status. */
class StatusBoard {
  private readonly ctx: Ctx;
  private readonly states = new Map<string, { status: SourceStatus; detail?: string }>();
  private last = "";

  constructor(ctx: Ctx, folders: string[]) {
    this.ctx = ctx;
    for (const folder of folders) this.states.set(folder, { status: "connecting" });
  }

  update(folder: string, status: SourceStatus, detail?: string) {
    this.states.set(folder, { status, detail });
    const all = [...this.states.entries()];
    const failed = all.filter(([, s]) => s.status === "error");
    let next: { status: SourceStatus; detail?: string };
    if (failed.length > 0) {
      next = {
        status: "error",
        detail: failed
          .map(([f, s]) => (all.length > 1 ? `${f}: ${s.detail}` : s.detail))
          .join("; "),
      };
    } else if (all.some(([, s]) => s.status === "connecting")) {
      next = { status: "connecting" };
    } else {
      next = {
        status: "connected",
        detail: all.length > 1 ? `Watching ${all.map(([f]) => f).join(", ")}` : detail,
      };
    }
    const key = `${next.status}\n${next.detail ?? ""}`;
    if (key === this.last) return;
    this.last = key;
    this.ctx.setStatus(next.status, next.detail);
  }
}

/** Keeps one folder watched until the signal aborts, reconnecting with backoff. */
async function watchFolder(
  ctx: Ctx,
  folder: string,
  options: EmailSourceOptions,
  signal: AbortSignal,
  report: (status: SourceStatus, detail?: string) => void,
) {
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  let failures = 0;
  while (!signal.aborted) {
    report("connecting");
    const client = imapClient(ctx.credentials, {
      disableAutoIdle: options.idle === false,
      autoIdleDelay: options.autoIdleDelayMs ?? 2_000,
      maxIdleTime: options.maxIdleTimeMs ?? 5 * 60_000,
    });
    // Without a listener, an 'error' event would crash the process.
    let lastError: Error | null = null;
    client.on("error", (error: Error) => {
      lastError = error;
    });
    const onAbort = () => void closeImap(client);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await watchConnection(ctx, client, folder, options, signal, () => {
        failures = 0;
        report("connected", `Watching ${folder}`);
      });
    } catch (error) {
      if (!signal.aborted) {
        const message = imapErrorMessage(lastError ?? error);
        ctx.log.warn("Email connection failed", { folder, error: message });
        report("error", message);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      await closeImap(client);
    }
    if (signal.aborted) break;
    failures += 1;
    await sleep(backoffDelay(failures, backoff), signal);
  }
}

/** One connection: open the folder, settle the mark, then hand over new mail until it drops. */
async function watchConnection(
  ctx: Ctx,
  client: ImapFlow,
  folder: string,
  options: EmailSourceOptions,
  signal: AbortSignal,
  onConnected: () => void,
) {
  let wake: (() => void) | null = null;
  let pending = true;
  let closed = false;
  const poke = () => {
    pending = true;
    wake?.();
  };
  client.on("exists", poke);
  client.on("close", () => {
    closed = true;
    poke();
  });
  signal.addEventListener("abort", poke, { once: true });

  await client.connect();
  const mailbox = await client.mailboxOpen(folder, { readOnly: true });
  const uidValidity = String(mailbox.uidValidity);
  const key = markKey(folder);
  let mark = parseMark(await ctx.state.get(key));
  if (!mark || mark.uidValidity !== uidValidity) {
    // First start, or the server renumbered the folder: start from what's there now.
    const highest = await highestUid(client, mailbox);
    if (mark) {
      ctx.log.info("Folder UIDVALIDITY changed, starting from the newest message", { folder });
    }
    mark = { uidValidity, uid: highest };
    await ctx.state.set(key, JSON.stringify(mark));
  }
  onConnected();

  const polling = options.idle === false || !client.capabilities.has("IDLE");
  const timer = polling ? setInterval(poke, options.pollIntervalMs ?? 60_000) : null;
  try {
    while (!signal.aborted && !closed) {
      if (!pending) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
        continue;
      }
      pending = false;
      mark = await deliverNew(ctx, client, folder, mark, signal);
    }
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener("abort", poke);
  }
  if (closed && !signal.aborted) throw new Error("The IMAP server closed the connection");
}

/** Everything below UIDNEXT is already there; new mail gets a UID at or above it. */
async function highestUid(client: ImapFlow, mailbox: MailboxObject): Promise<number> {
  if (mailbox.uidNext > 0) return mailbox.uidNext - 1;
  // Some servers leave UIDNEXT out of SELECT. Ask for the newest message's UID instead.
  if (mailbox.exists === 0) return 0;
  const newest = await client.fetchOne("*", { uid: true });
  return newest ? newest.uid : 0;
}

/** Emits every message above the mark, oldest first. The mark moves only after each emit lands. */
async function deliverNew(
  ctx: Ctx,
  client: ImapFlow,
  folder: string,
  start: UidMark,
  signal: AbortSignal,
): Promise<UidMark> {
  let mark = start;
  const found = await client.search({ uid: `${mark.uid + 1}:*` }, { uid: true });
  // "n:*" always matches the newest message, even when its UID is below n.
  const uids = (Array.isArray(found) ? found : [])
    .filter((u) => u > mark.uid)
    .sort((a, b) => a - b);
  for (const uid of uids) {
    if (signal.aborted) break;
    const id = dedupeKey(folder, mark.uidValidity, uid);
    // False when the message was deleted since the search.
    const message =
      (await client.fetchOne(
        String(uid),
        { uid: true, internalDate: true, source: { maxLength: SOURCE_LIMIT } },
        { uid: true },
      )) || null;
    if (message?.source) {
      let email: Awaited<ReturnType<typeof parseEmail>> | null = null;
      try {
        email = await parseEmail(message.source, {
          id,
          folder,
          internalDate: message.internalDate,
        });
      } catch (error) {
        ctx.log.warn("Skipping an email that couldn't be parsed", {
          folder,
          uid,
          error: errorMessage(error),
        });
      }
      // A failed emit throws, which reconnects and retries from the same mark.
      if (email) await ctx.emit({ type: RECEIVED_EVENT, payload: email, dedupeKey: id });
    }
    mark = { uidValidity: mark.uidValidity, uid };
    await ctx.state.set(markKey(folder), JSON.stringify(mark));
  }
  return mark;
}
