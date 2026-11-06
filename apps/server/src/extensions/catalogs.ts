/**
 * Catalogs: static JSON files that list extension packages. Sling keeps the
 * last good copy of each, refreshes them on demand and every six hours, and
 * reads the catalog that ships with it from a directory.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Catalog, CatalogSchema, type CatalogVersion } from "@sling/connector-sdk";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import { LIMITS } from "@sling/extension-package";
import { asc, eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { ExtensionError } from "./errors.ts";

export const INCLUDED_CATALOG_ID = "included";
/** The repo's `extensions/dist`, which `pnpm extensions:build` fills. */
export const INCLUDED_DIR = fileURLToPath(new URL("../../../../extensions/dist/", import.meta.url));

export const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = LIMITS.maxCompressed;
const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;
/** How often to look for catalogs due a refresh. Survives restarts, unlike a 6-hour timer. */
const CHECK_EVERY_MS = 15 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 30_000;
const PACKAGE_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

const MB = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/**
 * Catalogs and packages come over HTTPS. Plain HTTP to this machine is
 * allowed for developing a catalog, but only while the server allows
 * unsigned packages.
 */
export function checkSourceUrl(raw: string, allowLoopback: boolean, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new ExtensionError("That isn't a URL.");
  }
  if (url.username || url.password) throw new ExtensionError("Leave credentials out of the URL.");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopback(url.hostname)) {
    if (allowLoopback) return url;
    throw new ExtensionError(
      "Catalogs must use HTTPS. Plain HTTP to this machine works only while the server runs with SLING_ALLOW_UNSIGNED_EXTENSIONS=1.",
    );
  }
  throw new ExtensionError("Catalogs must use HTTPS.");
}

/** Reads a response body, refusing more than `max` bytes. */
export async function readCapped(res: Response, max: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    throw new ExtensionError(`The ${what} is over ${MB(max)}.`, 422);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new ExtensionError(`The ${what} is over ${MB(max)}.`, 422);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** GET with redirects followed by hand, so every hop passes the same URL rules. */
async function fetchChecked(
  start: URL,
  headers: Record<string, string>,
  allowLoopback: boolean,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = start;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { headers, redirect: "manual", signal });
    } catch (err) {
      const cause = (err as { cause?: { message?: string } }).cause?.message;
      const timedOut = (err as { name?: string }).name === "TimeoutError";
      throw new ExtensionError(
        timedOut
          ? `${url.host} didn't answer in time.`
          : `Couldn't reach ${url.host}${cause ? `: ${cause}` : ""}.`,
        502,
      );
    }
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (!location) return res;
    if (hop >= MAX_REDIRECTS)
      throw new ExtensionError(`${start.host} redirected too many times.`, 502);
    url = checkSourceUrl(location, allowLoopback, url);
  }
}

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "catalog"}: ${i.message}`)
    .join("; ");
}

export function parseCatalog(text: string): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ExtensionError("The catalog isn't valid JSON.", 422);
  }
  const parsed = CatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExtensionError(`The catalog isn't valid: ${issues(parsed.error)}.`, 422);
  }
  return parsed.data;
}

const EMPTY_INCLUDED: Catalog = {
  format: "sling.catalog/v1",
  name: "Included with Sling",
  publishers: [],
  extensions: [],
};

export interface CatalogState {
  id: string;
  url: string | null;
  name: string;
  enabled: boolean;
  included: boolean;
  fetchedAt: Date | null;
  error: string | null;
  etag: string | null;
  /** The last good copy. */
  document: Catalog | null;
  /** When a fetch was last tried, successful or not. */
  attemptedAt: number;
}

type CatalogRow = typeof schema.extensionCatalogs.$inferSelect;

function stateOf(row: CatalogRow): CatalogState {
  const parsed = row.document ? CatalogSchema.safeParse(row.document) : null;
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    enabled: row.enabled,
    included: false,
    fetchedAt: row.fetchedAt,
    error: row.error,
    etag: row.etag,
    document: parsed?.success ? parsed.data : null,
    attemptedAt: row.fetchedAt?.getTime() ?? 0,
  };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The catalog that ships with Sling: `catalog.json` in `dir`, with package
 * URLs relative to it. A missing directory is an empty catalog.
 */
export async function readIncludedCatalog(dir: string): Promise<CatalogState> {
  const state: CatalogState = {
    id: INCLUDED_CATALOG_ID,
    url: null,
    name: EMPTY_INCLUDED.name,
    enabled: true,
    included: true,
    fetchedAt: new Date(),
    error: null,
    etag: null,
    document: EMPTY_INCLUDED,
    attemptedAt: Date.now(),
  };
  let text: string;
  try {
    text = await readFile(join(dir, "catalog.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") state.error = errorText(err);
    return state;
  }
  try {
    const doc = parseCatalog(text);
    state.document = doc;
    state.name = doc.name;
  } catch (err) {
    state.error = errorText(err);
  }
  return state;
}

export class CatalogStore {
  readonly #ctx: AppContext;
  readonly #dir: string;
  #catalogs = new Map<string, CatalogState>();
  #timer: NodeJS.Timeout | null = null;
  #background: Promise<void> = Promise.resolve();
  /** Called after a background refresh, to apply the catalog's revocations. */
  onRefreshed: (state: CatalogState) => Promise<void> = async () => {};

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
    this.#dir = ctx.config.includedExtensionsDir ?? INCLUDED_DIR;
  }

  get #allowLoopback(): boolean {
    return this.#ctx.config.allowUnsignedExtensions === true;
  }

  async start(): Promise<void> {
    const [rows, included] = await Promise.all([
      this.#ctx.db
        .select()
        .from(schema.extensionCatalogs)
        .orderBy(asc(schema.extensionCatalogs.createdAt)),
      readIncludedCatalog(this.#dir),
    ]);
    this.#catalogs = new Map([[included.id, included]]);
    for (const row of rows) this.#catalogs.set(row.id, stateOf(row));
    this.#timer = setInterval(() => {
      this.#background = this.#background.then(() => this.#refreshDue());
    }, CHECK_EVERY_MS);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#background;
  }

  /** The included catalog first, then the others in the order they were added. */
  list(): CatalogState[] {
    return [...this.#catalogs.values()];
  }

  get(id: string): CatalogState | undefined {
    return this.#catalogs.get(id);
  }

  async add(rawUrl: string, userId: string): Promise<CatalogState> {
    const url = checkSourceUrl(rawUrl.trim(), this.#allowLoopback);
    const href = url.toString();
    for (const c of this.#catalogs.values()) {
      if (c.url === href) throw new ExtensionError("That catalog is already added.", 409);
    }
    const fetched = await this.#fetch(url, null);
    if (!fetched.document) throw new ExtensionError("The catalog didn't send a document.", 502);
    const [row] = await this.#ctx.db
      .insert(schema.extensionCatalogs)
      .values({
        id: newId("cat"),
        url: href,
        name: fetched.document.name,
        fetchedAt: new Date(),
        etag: fetched.etag,
        document: fetched.document as unknown as Record<string, unknown>,
        addedBy: userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ExtensionError("That catalog is already added.", 409);
    const state = stateOf(row);
    this.#catalogs.set(state.id, state);
    return state;
  }

  /** Fetches the catalog again. Failures are kept on the catalog, with its last good copy. */
  async refresh(id: string): Promise<CatalogState> {
    const state = this.#catalogs.get(id);
    if (!state) throw new ExtensionError("No such catalog.", 404);
    if (state.included) {
      const fresh = await readIncludedCatalog(this.#dir);
      this.#catalogs.set(id, fresh);
      return fresh;
    }
    state.attemptedAt = Date.now();
    let changed = false;
    try {
      // Checked again: the server may no longer allow plain HTTP to this machine.
      const url = checkSourceUrl(state.url as string, this.#allowLoopback);
      const fetched = await this.#fetch(url, state.etag);
      if (fetched.document) {
        state.document = fetched.document;
        state.name = fetched.document.name;
        state.etag = fetched.etag;
        changed = true;
      }
      state.fetchedAt = new Date();
      state.error = null;
    } catch (err) {
      state.error = errorText(err);
    }
    await this.#ctx.db
      .update(schema.extensionCatalogs)
      .set({
        name: state.name,
        fetchedAt: state.fetchedAt,
        etag: state.etag,
        error: state.error,
        ...(changed ? { document: state.document as unknown as Record<string, unknown> } : {}),
      })
      .where(eq(schema.extensionCatalogs.id, id));
    return state;
  }

  async remove(id: string): Promise<CatalogState> {
    const state = this.#catalogs.get(id);
    if (!state) throw new ExtensionError("No such catalog.", 404);
    if (state.included) {
      throw new ExtensionError("The catalog that ships with Sling can't be removed.", 409);
    }
    await this.#ctx.db.delete(schema.extensionCatalogs).where(eq(schema.extensionCatalogs.id, id));
    this.#catalogs.delete(id);
    return state;
  }

  async #refreshDue(): Promise<void> {
    const now = Date.now();
    for (const c of this.#catalogs.values()) {
      if (c.included || !c.enabled || now - c.attemptedAt < REFRESH_EVERY_MS) continue;
      try {
        await this.onRefreshed(await this.refresh(c.id));
      } catch (err) {
        this.#ctx.log.warn({ err, catalogId: c.id }, "catalog refresh failed");
      }
    }
  }

  /** A null document means the catalog hasn't changed since `etag`. */
  async #fetch(
    url: URL,
    etag: string | null,
  ): Promise<{ document: Catalog | null; etag: string | null }> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (etag) headers["if-none-match"] = etag;
    const res = await fetchChecked(url, headers, this.#allowLoopback, CATALOG_TIMEOUT_MS);
    if (res.status === 304) {
      await res.body?.cancel();
      return { document: null, etag };
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ExtensionError(`The catalog answered ${res.status}.`, 502);
    }
    const bytes = await readCapped(res, MAX_CATALOG_BYTES, "catalog");
    return {
      document: parseCatalog(new TextDecoder().decode(bytes)),
      etag: res.headers.get("etag"),
    };
  }

  /** Downloads one version's package, capped at the package size limit. */
  async download(state: CatalogState, version: CatalogVersion): Promise<Uint8Array> {
    if (state.included) return this.#readIncludedPackage(version.url);
    const url = checkSourceUrl(version.url, this.#allowLoopback, new URL(state.url as string));
    const res = await fetchChecked(url, {}, this.#allowLoopback, PACKAGE_TIMEOUT_MS);
    if (!res.ok) {
      await res.body?.cancel();
      throw new ExtensionError(`The package download answered ${res.status}.`, 502);
    }
    return readCapped(res, MAX_PACKAGE_BYTES, "package");
  }

  async #readIncludedPackage(path: string): Promise<Uint8Array> {
    const file = resolve(this.#dir, path);
    const rel = relative(this.#dir, file);
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || rel.startsWith("..") || isAbsolute(rel)) {
      throw new ExtensionError("The included catalog points outside its directory.", 422);
    }
    try {
      const info = await stat(file);
      if (info.size > MAX_PACKAGE_BYTES) {
        throw new ExtensionError(`The package is over ${MB(MAX_PACKAGE_BYTES)}.`, 422);
      }
      return new Uint8Array(await readFile(file));
    } catch (err) {
      if (err instanceof ExtensionError) throw err;
      throw new ExtensionError(`The included package ${path} is missing.`, 404);
    }
  }
}
