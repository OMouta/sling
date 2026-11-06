import type {
  AnyConnector,
  CatalogEntry,
  CatalogVersion,
  ExtensionDescription,
  ExtensionManifest,
  ExtensionPermissions,
} from "@sling/connector-sdk";
import { ExtensionManifestSchema, SDK_VERSION } from "@sling/connector-sdk";
import {
  checkDescription,
  compareVersions,
  describePermissions,
  diffPermissions,
  formatFingerprint,
  kindsOf,
  satisfiesRange,
} from "@sling/connector-sdk/host";
import type {
  CatalogView,
  ConnectorView,
  DiscoverEntryView,
  ExtensionContents,
  ExtensionDetailView,
  ExtensionKind,
  ExtensionPreview,
  ExtensionSource,
  ExtensionStatus,
  ExtensionView,
  PublisherView,
} from "@sling/core";
import { newId } from "@sling/core";
import { schema } from "@sling/db";
import {
  type ExtensionPackage,
  fileText,
  PackageError,
  readPackage,
  unpackTo,
} from "@sling/extension-package";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { type AuditEntry, audit } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { liveSandboxCount } from "../sandboxes/routes.ts";
import { parseTemplate, type Template } from "../workflows/templates.ts";
import type { WorkflowRow } from "../workflows/views.ts";
import { UnpackCache } from "./cache.ts";
import { type CatalogState, CatalogStore } from "./catalogs.ts";
import {
  checkRequirements,
  contentsOf,
  hostOf,
  type Missing,
  type NameIndex,
  nameClashes,
  namespaceOf,
  nodeTypeProblems,
  permissionsKey,
} from "./checks.ts";
import { DISABLED_MESSAGE, standInConnectors } from "./disabled.ts";
import { ExtensionError } from "./errors.ts";
import { buildWorkflowPackage } from "./export.ts";
import type { ExtensionRuntime } from "./runtime.ts";
import { assessTrust, PublisherStore, type TrustResult } from "./trust.ts";
import {
  type ExtensionRow,
  extensionRef,
  type InstalledExtension,
  installableVersions,
  toCatalogView,
  toExtensionView,
  unavailableReason,
  updateFor,
} from "./views.ts";

export const DIGEST_MISMATCH = "The stored package doesn't match its digest";
const MISSING_PACKAGE = "The stored package is missing";
const STAGING_MS = 15 * 60 * 1000;
/** Each can hold a 20 MB package, so only a few are kept. */
const MAX_STAGED = 8;
const SWEEP_EVERY_MS = 60 * 1000;
const EMPTY_HOSTS: ReadonlySet<string> = new Set();

interface Actor {
  userId: string;
  workspaceId: string;
}

/** The installed version's package row. */
interface StoredPackage {
  version: string;
  digest: string;
  size: number;
  archive: Uint8Array;
  manifest: Record<string, unknown>;
  description: Record<string, unknown> | null;
}

/** A package waiting for its confirm. */
interface Staged {
  stagingId: string;
  expiresAt: number;
  bytes: Uint8Array;
  pkg: ExtensionPackage;
  source: ExtensionSource;
  catalogId: string | null;
  catalogPublisher: string | null;
  description: ExtensionDescription | null;
  templates: Template[];
  /** Problems that can't change before the confirm. */
  fixedProblems: string[];
  permissionsKey: string;
  /** Where it was unpacked to read what it adds. */
  dir: string | null;
}

/** Where an extension's package comes from when it's (re)loaded. */
type PackageSource =
  /** The stored archive, checked against its digest. */
  | { kind: "stored"; stored: StoredPackage | null }
  /** A package just previewed, already checked and possibly unpacked. */
  | { kind: "staged"; staged: Staged }
  /** Nothing changes but the row, as when disabling. */
  | { kind: "same"; from: InstalledExtension };

/** An extension ready to register: package checked, and unpacked if its code will run. */
interface Prepared {
  row: ExtensionRow;
  manifest: ExtensionManifest;
  digest: string;
  size: number;
  description: ExtensionDescription | null;
  contents: ExtensionContents;
  readme: string | null;
  icon: { bytes: Uint8Array; type: string } | null;
  templates: Template[];
  intact: boolean;
  status: ExtensionStatus;
  detail: string | null;
  /** The code runs, from `dir`. */
  live: boolean;
  dir: string | null;
  /** What stand-in nodes fail with when the code doesn't run. */
  reason: string;
}

interface Usage {
  installations: { id: string; name: string; connectorId: string }[];
  workflows: { id: string; name: string; enabled: boolean; types: string[] }[];
}

/** Installations and workflows, by the extension they use. */
type UsedBy = Map<string, Usage>;

export interface StartTimings {
  /** Rows, catalogs, publishers, and the cache directory. */
  loadMs: number;
  /** Digest checks and unpacking, concurrently. */
  prepareMs: number;
  /** Activating in the runtime and registering connectors. */
  registerMs: number;
  totalMs: number;
  extensions: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One line for a parse failure: zod issues by path, or the error's message. */
function parseError(err: unknown): string {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .slice(0, 3)
      .map((i) => `${i.path.map(String).join(".") || "value"}: ${i.message}`)
      .join("; ");
  }
  return errorText(err);
}

/** A manifest from the stored JSON, for packages that can't be read any more. */
function storedManifest(row: ExtensionRow, raw: unknown): ExtensionManifest {
  const parsed = ExtensionManifestSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return {
    format: "sling.extension/v1",
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    publisher: row.publisherName ?? "Unknown",
    sdk: `^${SDK_VERSION}`,
    templates: [],
    permissions: row.granted,
    requires: { extensions: {}, connectors: [] },
    memoryMb: 256,
  };
}

function iconOf(manifest: ExtensionManifest, files: Map<string, Uint8Array>) {
  const bytes = manifest.icon ? files.get(manifest.icon) : undefined;
  if (!manifest.icon || !bytes) return null;
  // A copy, so the rest of the unpacked package can be freed.
  return {
    bytes: bytes.slice(),
    type: manifest.icon.endsWith(".svg") ? "image/svg+xml" : "image/png",
  };
}

/**
 * Installs, updates, and removes extensions, keeps catalogs and trusted
 * publishers, and registers what installed extensions add.
 */
export class ExtensionService {
  readonly #ctx: AppContext;
  readonly runtime: ExtensionRuntime;
  readonly catalogs: CatalogStore;
  readonly publishers: PublisherStore;
  readonly cache: UnpackCache;
  readonly #installed = new Map<string, InstalledExtension>();
  /** Connector ID to the extension that registered it. */
  readonly #owners = new Map<string, string>();
  readonly #configHosts = new Map<string, ReadonlySet<string>>();
  readonly #staged = new Map<string, Staged>();
  #templates: Template[] = [];
  #lock: Promise<unknown> = Promise.resolve();
  #statusQueue: Promise<void> = Promise.resolve();
  #sweep: NodeJS.Timeout | null = null;
  startTimings: StartTimings | null = null;

  constructor(ctx: AppContext, runtime: ExtensionRuntime) {
    this.#ctx = ctx;
    this.runtime = runtime;
    this.catalogs = new CatalogStore(ctx);
    this.publishers = new PublisherStore(ctx);
    this.cache = new UnpackCache(ctx.config.extensionCacheDir);
  }

  // ------------------------------------------------------------- lifecycle

  /** Loads installed extensions and registers what they add. Starts no processes. */
  async start(): Promise<void> {
    const t0 = performance.now();
    this.runtime.setEvents({
      onStatus: (id, status, detail) => this.#onRuntimeStatus(id, status, detail),
      onCrash: (id, reason) => this.#onCrash(id, reason),
    });
    this.catalogs.onRefreshed = (state) => this.#serial(() => this.#applyRevocations(state, null));
    const [rows] = await Promise.all([
      this.#ctx.db
        .select({
          ext: schema.extensions,
          pkg: {
            version: schema.extensionPackages.version,
            digest: schema.extensionPackages.digest,
            size: schema.extensionPackages.size,
            archive: schema.extensionPackages.archive,
            manifest: schema.extensionPackages.manifest,
            description: schema.extensionPackages.description,
          },
        })
        .from(schema.extensions)
        .leftJoin(
          schema.extensionPackages,
          and(
            eq(schema.extensionPackages.extensionId, schema.extensions.id),
            eq(schema.extensionPackages.version, schema.extensions.version),
          ),
        ),
      this.cache.open(),
      this.publishers.load(),
      this.catalogs.start(),
    ]);
    const t1 = performance.now();
    const prepared = await Promise.all(
      rows.map((r) => this.#prepare(r.ext, { kind: "stored", stored: r.pkg })),
    );
    const t2 = performance.now();
    for (const p of prepared) await this.#commit(p, { replace: true });
    const t3 = performance.now();
    await Promise.all([
      ...prepared.map((p) => this.#persistStatus(p.row)),
      this.#refreshConfigHosts(),
    ]);
    this.#rebuildTemplates();
    for (const c of this.catalogs.list()) await this.#applyRevocations(c, null);
    this.#sweep = setInterval(() => this.#sweepStaged(), SWEEP_EVERY_MS);
    this.#sweep.unref();
    const t4 = performance.now();
    this.startTimings = {
      loadMs: t1 - t0,
      prepareMs: t2 - t1,
      registerMs: t3 - t2,
      totalMs: t4 - t0,
      extensions: rows.length,
    };
    if (rows.length > 0) {
      this.#ctx.log.info({ extensions: rows.length, ms: Math.round(t4 - t0) }, "extensions loaded");
    }
  }

  async stop(): Promise<void> {
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
    await this.catalogs.stop();
    await this.#lock.catch(() => {});
    await this.runtime.stopAll();
    await this.#statusQueue;
    this.#staged.clear();
    await this.cache.close();
  }

  /** Runs changes one at a time, so two installs never race on the registry. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(fn, fn);
    this.#lock = run.catch(() => {});
    return run;
  }

  async requireOwner(actor: Actor): Promise<void> {
    const [m] = await this.#ctx.db
      .select({ role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, actor.workspaceId),
          eq(schema.workspaceMembers.userId, actor.userId),
        ),
      );
    if (m?.role !== "owner") {
      throw new ExtensionError("Only the workspace owner can change extensions.", 403);
    }
  }

  // ------------------------------------------------------------- loading

  #readTemplates(
    manifest: ExtensionManifest,
    files: Map<string, Uint8Array>,
  ): { templates: Template[]; problems: string[] } {
    const templates: Template[] = [];
    const problems: string[] = [];
    for (const key of manifest.templates) {
      try {
        const t = parseTemplate(
          fileText(files, `templates/${key}/template.json`) ?? "",
          fileText(files, `templates/${key}/workflow.json`) ?? "",
          key,
        );
        templates.push({
          view: {
            ...t.view,
            key: `${manifest.id}/${key}`,
            builtIn: false,
            extension: {
              id: manifest.id,
              name: manifest.name,
              version: manifest.version,
              hasIcon: manifest.icon !== undefined,
            },
          },
          definition: t.definition,
        });
      } catch (err) {
        problems.push(`Template ${key} isn't valid: ${parseError(err)}.`);
      }
    }
    templates.sort((a, b) => a.view.name.localeCompare(b.view.name));
    return { templates, problems };
  }

  /** Checks the package and decides what should run. Unpacks it when its code will. */
  async #prepare(row: ExtensionRow, source: PackageSource): Promise<Prepared> {
    let pkg: ExtensionPackage | null = null;
    let problem: string | null = null;
    let manifest: ExtensionManifest;
    let description: ExtensionDescription | null;
    let size: number;
    let digest: string;
    let readme: string | null = null;
    let icon: Prepared["icon"] = null;
    let templates: Template[] = [];
    let dir: string | null = null;

    if (source.kind === "same") {
      const x = source.from;
      ({ manifest, description, size, digest, readme, icon, templates } = x);
      if (!x.intact) problem = x.row.statusDetail ?? DIGEST_MISMATCH;
    } else if (source.kind === "staged") {
      const s = source.staged;
      pkg = s.pkg;
      manifest = pkg.manifest;
      description = s.description;
      size = s.bytes.length;
      digest = pkg.digest;
      dir = s.dir;
    } else {
      const stored = source.stored;
      description = (stored?.description ?? null) as ExtensionDescription | null;
      size = stored?.size ?? 0;
      digest = stored?.digest ?? "";
      if (!stored) problem = MISSING_PACKAGE;
      else {
        try {
          const read = readPackage(stored.archive);
          const same =
            read.digest === stored.digest &&
            read.manifest.id === row.id &&
            read.manifest.version === stored.version;
          if (same) pkg = read;
          else problem = DIGEST_MISMATCH;
        } catch {
          problem = DIGEST_MISMATCH;
        }
      }
      manifest = pkg?.manifest ?? storedManifest(row, stored?.manifest);
    }
    if (pkg) {
      readme = fileText(pkg.files, "README.md");
      icon = iconOf(manifest, pkg.files);
      templates =
        source.kind === "staged"
          ? source.staged.templates
          : this.#readTemplates(manifest, pkg.files).templates;
    }

    let status: ExtensionStatus;
    let detail: string | null = null;
    let live = false;
    let reason = DISABLED_MESSAGE;
    const unsupported = this.runtime.unsupportedReason;
    if (problem) {
      status = "error";
      detail = reason = problem;
    } else if (!row.enabled) {
      status = "disabled";
      detail = row.revokedReason;
    } else if (!manifest.main) {
      status = "stopped";
    } else if (unsupported) {
      status = "unsupported";
      detail = reason = unsupported;
    } else if (!description) {
      status = "error";
      detail = reason = "The package's code never said what it adds";
    } else {
      status = "stopped";
      live = true;
    }

    if (live) {
      try {
        if (dir) dir = await this.cache.adopt(dir, row.id, row.version);
        else if (pkg) dir = await this.cache.unpack(pkg.files, row.id, row.version);
        else throw new Error("the package isn't loaded");
      } catch (err) {
        live = false;
        status = "error";
        detail = reason = `Couldn't unpack the package: ${errorText(err)}`;
      }
    } else if (!live && dir) {
      await this.cache.remove(dir);
      dir = null;
    }

    return {
      row,
      manifest,
      digest,
      size,
      description,
      contents: contentsOf(
        description,
        templates.map((t) => ({ key: t.view.key, name: t.view.name })),
      ),
      readme,
      icon,
      templates,
      intact: problem === null,
      status,
      detail,
      live,
      dir,
      reason,
    };
  }

  /**
   * Activates the code (or builds stand-ins) and swaps the extension's
   * connectors in the registry. With `replace`, an active extension moves to
   * the new code and its calls in flight finish on the old; without, it's
   * turned off and on.
   */
  async #commit(p: Prepared, opts: { replace: boolean }) {
    const id = p.row.id;
    const old = this.#installed.get(id);
    const registry = this.#ctx.registry;
    let status = p.status;
    let detail = p.detail;
    let connectors: AnyConnector[] = [];
    let active = false;

    if (p.live && p.dir && p.description) {
      if (old?.active && !opts.replace) {
        await this.runtime.deactivate(id);
        old.active = false;
      }
      try {
        connectors = this.runtime.activate({
          id,
          version: p.row.version,
          digest: p.digest,
          dir: p.dir,
          manifest: p.manifest,
          description: p.description,
          granted: p.row.granted as ExtensionPermissions,
          configHosts: () => this.#configHosts.get(id) ?? EMPTY_HOSTS,
        });
        active = true;
      } catch (err) {
        status = "error";
        detail = `The extension didn't start: ${errorText(err)}`;
        connectors = standInConnectors(p.description, detail);
      }
    } else if (p.description) {
      connectors = standInConnectors(p.description, p.reason);
    }

    for (const cid of old?.connectorIds ?? []) {
      registry.unregisterConnector(cid);
      this.#owners.delete(cid);
    }
    const registered: string[] = [];
    for (const c of connectors) {
      try {
        registry.registerConnector(c);
        registered.push(c.id);
      } catch (err) {
        for (const cid of registered) registry.unregisterConnector(cid);
        registered.length = 0;
        status = "error";
        detail = `Another connector already uses its names: ${errorText(err)}`;
        if (active) {
          await this.runtime.deactivate(id);
          active = false;
        }
        break;
      }
    }
    for (const cid of registered) this.#owners.set(cid, id);

    const next: InstalledExtension = {
      row: { ...p.row, status, statusDetail: detail },
      manifest: p.manifest,
      digest: p.digest,
      size: p.size,
      description: p.description,
      contents: p.contents,
      readme: p.readme,
      icon: p.icon,
      templates: p.templates,
      intact: p.intact,
      dir: active ? p.dir : null,
      active,
      connectorIds: registered,
    };
    if (!active && p.dir) await this.cache.remove(p.dir);
    this.#installed.set(id, next);
    return { next, old };
  }

  /** Registers a prepared extension and brings sources, hosts, and templates in line. */
  async #apply(p: Prepared, opts: { replace: boolean }): Promise<InstalledExtension> {
    const { next, old } = await this.#commit(p, opts);
    await this.#refreshConfigHosts([next.row.id]);
    const ids = new Set([...(old?.connectorIds ?? []), ...next.connectorIds]);
    if (ids.size > 0) await this.#ctx.connectors.restartConnectors(ids);
    if (old?.active && !next.active) await this.runtime.deactivate(next.row.id);
    await this.#persistStatus(p.row);
    this.#rebuildTemplates();
    return next;
  }

  /** Writes the in-memory status when it differs from `stored`. */
  #persistStatus(stored: Pick<ExtensionRow, "id" | "status" | "statusDetail">): Promise<void> {
    const x = this.#installed.get(stored.id);
    if (!x || (x.row.status === stored.status && x.row.statusDetail === stored.statusDetail)) {
      return Promise.resolve();
    }
    return this.#writeStatus(stored.id);
  }

  /** Status writes go through one queue, so the last one written is the latest. */
  #writeStatus(id: string): Promise<void> {
    const run = this.#statusQueue.then(async () => {
      const x = this.#installed.get(id);
      if (!x) return;
      await this.#ctx.db
        .update(schema.extensions)
        .set({ status: x.row.status, statusDetail: x.row.statusDetail, updatedAt: x.row.updatedAt })
        .where(eq(schema.extensions.id, id));
    });
    this.#statusQueue = run.catch((err) =>
      this.#ctx.log.error({ err, extensionId: id }, "couldn't save an extension's status"),
    );
    return this.#statusQueue;
  }

  async #storedPackage(id: string, version: string): Promise<StoredPackage | null> {
    const [row] = await this.#ctx.db
      .select({
        version: schema.extensionPackages.version,
        digest: schema.extensionPackages.digest,
        size: schema.extensionPackages.size,
        archive: schema.extensionPackages.archive,
        manifest: schema.extensionPackages.manifest,
        description: schema.extensionPackages.description,
      })
      .from(schema.extensionPackages)
      .where(
        and(
          eq(schema.extensionPackages.extensionId, id),
          eq(schema.extensionPackages.version, version),
        ),
      );
    return row ?? null;
  }

  #rebuildTemplates(): void {
    this.#templates = [...this.#installed.values()]
      .filter((x) => x.row.enabled && x.intact)
      .flatMap((x) => x.templates);
  }

  // ------------------------------------------------------------- what others read

  /** Templates of enabled extensions, keyed `<extension>/<key>`. */
  templates(): Template[] {
    return this.#templates;
  }

  /** The extension that registered a connector. */
  ownerOf(connectorId: string): InstalledExtension | undefined {
    const id = this.#owners.get(connectorId);
    return id ? this.#installed.get(id) : undefined;
  }

  /** The view of an extension's connector, from what it described at install. Null for built-ins. */
  connectorView(connectorId: string): ConnectorView | null {
    const x = this.ownerOf(connectorId);
    const d = x?.description?.connectors.find((c) => c.id === connectorId);
    if (!x || !d) return null;
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      setupHelp: d.setupHelp,
      credentialsSchema: d.credentialsSchema,
      secretFields: d.secretFields,
      configSchema: d.configSchema,
      nodeTypes: d.nodes.map((n) => n.type),
      isExecutionProvider: d.isExecutionProvider,
      hasSource: d.hasSource,
      extension: extensionRef(x),
    };
  }

  icon(id: string): { bytes: Uint8Array; type: string } | null {
    return this.#installed.get(id)?.icon ?? null;
  }

  /** The installed package's digest, for caching what's served from it. */
  digestOf(id: string): string | null {
    return this.#installed.get(id)?.digest ?? null;
  }

  /**
   * Recomputes the hosts an extension may reach from its installations'
   * config. Called when an installation of one of its connectors changes.
   */
  async installationsChanged(connectorId: string): Promise<void> {
    const id = this.#owners.get(connectorId);
    if (!id) return;
    try {
      await this.#refreshConfigHosts([id]);
    } catch (err) {
      this.#ctx.log.error({ err, extensionId: id }, "couldn't refresh an extension's config hosts");
    }
  }

  /** One query for every extension whose permissions name config fields. */
  async #refreshConfigHosts(ids?: string[]): Promise<void> {
    const targets: InstalledExtension[] = [];
    for (const id of ids ?? [...this.#installed.keys()]) {
      const x = this.#installed.get(id);
      if (x && x.row.granted.network.configHosts.length > 0 && x.connectorIds.length > 0) {
        targets.push(x);
      } else this.#configHosts.delete(id);
    }
    if (targets.length === 0) return;
    const rows = await this.#ctx.db
      .select({
        connectorId: schema.connectorInstallations.connectorId,
        config: schema.connectorInstallations.config,
      })
      .from(schema.connectorInstallations)
      .where(
        inArray(
          schema.connectorInstallations.connectorId,
          targets.flatMap((x) => x.connectorIds),
        ),
      );
    const next = new Map(targets.map((x) => [x.row.id, new Set<string>()]));
    for (const r of rows) {
      const id = this.#owners.get(r.connectorId);
      const set = id ? next.get(id) : undefined;
      const x = id ? this.#installed.get(id) : undefined;
      if (!set || !x) continue;
      for (const field of x.row.granted.network.configHosts) {
        const host = hostOf(r.config[field]);
        if (host) set.add(host);
      }
    }
    for (const [id, set] of next) this.#configHosts.set(id, set);
  }

  /** The hosts from installation config an extension may reach. */
  configHosts(id: string): ReadonlySet<string> {
    return this.#configHosts.get(id) ?? EMPTY_HOSTS;
  }

  // ------------------------------------------------------------- views

  /** Installations and workflows in a workspace, with the node types each workflow uses. */
  async #usage(workspaceId: string): Promise<Usage> {
    const [installations, workflows] = await Promise.all([
      this.#ctx.db
        .select({
          id: schema.connectorInstallations.id,
          name: schema.connectorInstallations.name,
          connectorId: schema.connectorInstallations.connectorId,
        })
        .from(schema.connectorInstallations)
        .where(eq(schema.connectorInstallations.workspaceId, workspaceId)),
      this.#ctx.db.execute<{ id: string; name: string; enabled: boolean; types: string[] }>(sql`
        select w.id, w.name, w.enabled,
          coalesce(
            (select array_agg(distinct n->>'type')
               from jsonb_array_elements(
                 coalesce(w.draft->'nodes', '[]'::jsonb) || coalesce(v.definition->'nodes', '[]'::jsonb)
               ) n),
            '{}'
          ) as types
        from ${schema.workflows} w
        left join ${schema.workflowVersions} v on v.id = w.active_version_id
        where w.workspace_id = ${workspaceId}
        order by w.name
      `),
    ]);
    return { installations, workflows: workflows.rows };
  }

  /** What in the workspace uses each extension. */
  #usedBy(usage: Usage): UsedBy {
    const byConnector = new Map<string, string>();
    const byNode = new Map<string, string>();
    for (const x of this.#installed.values()) {
      for (const c of x.contents.connectors) byConnector.set(c.id, x.row.id);
      for (const n of x.contents.nodes) byNode.set(n.type, x.row.id);
    }
    const out: UsedBy = new Map();
    const entry = (id: string) => {
      let e = out.get(id);
      if (!e) {
        e = { installations: [], workflows: [] };
        out.set(id, e);
      }
      return e;
    };
    for (const i of usage.installations) {
      const id = byConnector.get(i.connectorId);
      if (id) entry(id).installations.push(i);
    }
    for (const w of usage.workflows) {
      const ids = new Set<string>();
      for (const t of w.types) {
        const id = byNode.get(t);
        if (id) ids.add(id);
      }
      for (const id of ids) entry(id).workflows.push(w);
    }
    return out;
  }

  #toView(x: InstalledExtension, used: UsedBy): ExtensionView {
    const u = used.get(x.row.id);
    return toExtensionView(x, {
      publisher: x.row.publisherKeyId
        ? this.publishers.ref(x.row.publisherKeyId, x.row.publisherName ?? x.row.publisherKeyId)
        : null,
      update: x.row.catalogId ? updateFor(x, this.catalogs.get(x.row.catalogId)) : null,
      usedBy: { installations: u?.installations.length ?? 0, workflows: u?.workflows.length ?? 0 },
    });
  }

  async list(workspaceId: string): Promise<ExtensionView[]> {
    const used = this.#usedBy(await this.#usage(workspaceId));
    return [...this.#installed.values()]
      .sort((a, b) => a.row.name.localeCompare(b.row.name))
      .map((x) => this.#toView(x, used));
  }

  async view(workspaceId: string, id: string): Promise<ExtensionView | null> {
    const x = this.#installed.get(id);
    if (!x) return null;
    return this.#toView(x, this.#usedBy(await this.#usage(workspaceId)));
  }

  async detail(workspaceId: string, id: string): Promise<ExtensionDetailView | null> {
    const x = this.#installed.get(id);
    if (!x) return null;
    const used = this.#usedBy(await this.#usage(workspaceId));
    const u = used.get(id);
    const catalog = x.row.catalogId ? this.catalogs.get(x.row.catalogId) : undefined;
    const entry =
      x.row.source === "upload"
        ? undefined
        : catalog?.document?.extensions.find((e) => e.id === id);
    return {
      ...this.#toView(x, used),
      readme: x.readme,
      manifest: x.manifest as unknown as Record<string, unknown>,
      digest: x.digest,
      versions: [...(entry?.versions ?? [])]
        .sort((a, b) => compareVersions(b.version, a.version))
        .map((v) => ({
          version: v.version,
          publishedAt: v.publishedAt ?? null,
          revoked: v.revoked,
        })),
      log: this.runtime.log(id).map((l) => ({
        at: l.at.toISOString(),
        level: l.level,
        message: l.message,
      })),
      installations: (u?.installations ?? []).map((i) => ({
        id: i.id,
        name: i.name,
        connectorId: i.connectorId,
      })),
      workflows: (u?.workflows ?? []).map((w) => ({ id: w.id, name: w.name, enabled: w.enabled })),
    };
  }

  discover(filter: { q?: string; kind?: ExtensionKind } = {}): DiscoverEntryView[] {
    const q = filter.q?.trim().toLowerCase();
    const out: DiscoverEntryView[] = [];
    for (const c of this.catalogs.list()) {
      if (!c.enabled || !c.document) continue;
      const names = new Map(c.document.publishers.map((p) => [p.keyId, p.name]));
      for (const e of c.document.extensions) {
        if (filter.kind && !e.kinds.includes(filter.kind)) continue;
        if (q && ![e.id, e.name, e.description].some((s) => s.toLowerCase().includes(q))) continue;
        const latest = installableVersions(e)[0] ?? null;
        const installed = this.#installed.get(e.id);
        out.push({
          catalogId: c.id,
          catalogName: c.name,
          id: e.id,
          name: e.name,
          description: e.description,
          publisher:
            c.included || !e.publisher
              ? null
              : this.publishers.ref(e.publisher, names.get(e.publisher) ?? e.publisher),
          kinds: e.kinds,
          homepage: e.homepage ?? null,
          latest: latest
            ? {
                version: latest.version,
                size: latest.size,
                permissions: describePermissions(latest.permissions),
                publishedAt: latest.publishedAt ?? null,
              }
            : null,
          unavailable: latest ? null : unavailableReason(e),
          installed: installed
            ? {
                version: installed.row.version,
                updateAvailable:
                  installed.row.catalogId === c.id &&
                  installed.row.source !== "upload" &&
                  latest !== null &&
                  compareVersions(latest.version, installed.row.version) > 0,
              }
            : null,
        });
      }
    }
    return out;
  }

  listCatalogs(): CatalogView[] {
    return this.catalogs.list().map(toCatalogView);
  }

  listPublishers(): PublisherView[] {
    const pinned = new Map<string, string[]>();
    for (const x of this.#installed.values()) {
      const key = x.row.publisherKeyId;
      if (!key) continue;
      const list = pinned.get(key) ?? [];
      list.push(x.row.id);
      pinned.set(key, list);
    }
    return this.publishers.list(pinned);
  }

  /** Sends the extension's view to every workspace with a browser open. */
  async #publish(x: InstalledExtension): Promise<void> {
    for (const ws of this.#ctx.hub.workspaces()) {
      try {
        const used = this.#usedBy(await this.#usage(ws));
        this.#ctx.hub.publish(ws, { type: "extension.updated", extension: this.#toView(x, used) });
      } catch (err) {
        this.#ctx.log.warn({ err, extensionId: x.row.id }, "couldn't publish an extension update");
      }
    }
  }

  // ------------------------------------------------------------- preview

  #parse(bytes: Uint8Array, what: string): ExtensionPackage {
    try {
      return readPackage(bytes);
    } catch (err) {
      if (err instanceof PackageError) {
        throw new ExtensionError(`The ${what} isn't a valid package: ${err.message}.`, 422);
      }
      throw err;
    }
  }

  /** Previews a package from a catalog, or uploaded bytes. Nothing is installed yet. */
  async preview(
    actor: Actor,
    input: { catalogId: string; extensionId: string; version: string } | { bytes: Uint8Array },
  ): Promise<ExtensionPreview> {
    await this.requireOwner(actor);
    if ("bytes" in input) {
      const pkg = this.#parse(input.bytes, "file");
      return this.#stage({
        bytes: input.bytes,
        pkg,
        source: "upload",
        catalogId: null,
        catalogPublisher: null,
        revoked: null,
      });
    }
    const catalog = this.catalogs.get(input.catalogId);
    if (!catalog) throw new ExtensionError("No such catalog.", 404);
    if (!catalog.document) {
      throw new ExtensionError(
        `${catalog.name} hasn't been fetched yet.${catalog.error ? ` ${catalog.error}` : ""}`,
        409,
      );
    }
    const entry = catalog.document.extensions.find((e) => e.id === input.extensionId);
    const version = entry?.versions.find((v) => v.version === input.version);
    if (!entry || !version) {
      throw new ExtensionError(
        `${catalog.name} doesn't list ${input.extensionId} ${input.version}.`,
        404,
      );
    }
    return this.#previewFromCatalog(catalog, entry, version);
  }

  async #previewFromCatalog(
    catalog: CatalogState,
    entry: CatalogEntry,
    version: CatalogVersion,
  ): Promise<ExtensionPreview> {
    const bytes = await this.catalogs.download(catalog, version);
    const pkg = this.#parse(bytes, "download");
    if (pkg.digest !== version.digest) {
      throw new ExtensionError("The download doesn't match the digest in the catalog.", 422);
    }
    if (pkg.manifest.id !== entry.id || pkg.manifest.version !== version.version) {
      throw new ExtensionError(
        `The download is ${pkg.manifest.id} ${pkg.manifest.version}, but the catalog lists ${entry.id} ${version.version}.`,
        422,
      );
    }
    return this.#stage({
      bytes,
      pkg,
      source: catalog.included ? "included" : "catalog",
      catalogId: catalog.id,
      catalogPublisher: entry.publisher,
      revoked: version.revoked,
    });
  }

  /** Previews an update from the catalog the extension came from: `version`, or the newest. */
  async previewUpdate(actor: Actor, id: string, version?: string): Promise<ExtensionPreview> {
    await this.requireOwner(actor);
    const x = this.#installed.get(id);
    if (!x) throw new ExtensionError("No such extension.", 404);
    if (x.row.source === "upload" || !x.row.catalogId) {
      throw new ExtensionError(
        `${x.row.name} was uploaded, so there's no catalog to update it from. Upload the new version instead.`,
        409,
      );
    }
    const catalog = this.catalogs.get(x.row.catalogId);
    if (!catalog?.document) {
      throw new ExtensionError(`The catalog ${x.row.name} came from isn't available.`, 409);
    }
    const target = version ?? updateFor(x, catalog)?.version;
    if (!target) throw new ExtensionError(`${x.row.name} is up to date.`, 409);
    const entry = catalog.document.extensions.find((e) => e.id === id);
    const listed = entry?.versions.find((v) => v.version === target);
    if (!entry || !listed)
      throw new ExtensionError(`${catalog.name} doesn't list ${id} ${target}.`, 404);
    return this.#previewFromCatalog(catalog, entry, listed);
  }

  #trust(s: Pick<Staged, "source" | "pkg" | "catalogPublisher">): TrustResult {
    const installed = this.#installed.get(s.pkg.manifest.id);
    return assessTrust({
      source: s.source,
      pkg: s.pkg,
      catalogPublisher: s.catalogPublisher,
      allowUnsigned: this.#ctx.config.allowUnsignedExtensions === true,
      isTrusted: (k) => this.publishers.isTrusted(k),
      pinnedKeyId: installed?.row.publisherKeyId ?? null,
      installed: installed !== undefined,
    });
  }

  #nameIndex(): NameIndex {
    const connectors = new Map<string, string | null>();
    const namespaces = new Map<string, string | null>();
    for (const c of this.#ctx.registry.connectors()) {
      const owner = this.#owners.get(c.id) ?? null;
      connectors.set(c.id, owner);
      namespaces.set(namespaceOf(c.id), owner);
    }
    for (const s of this.#ctx.registry.specs()) {
      const ns = namespaceOf(s.type);
      if (!namespaces.has(ns)) {
        namespaces.set(ns, s.connector ? (this.#owners.get(s.connector) ?? null) : null);
      }
    }
    return { connectors, namespaces };
  }

  /** The first enabled catalog with an installable version of `id` in `range`. */
  #findInCatalogs(id: string, range: string): string | null {
    for (const c of this.catalogs.list()) {
      const entry = c.enabled ? c.document?.extensions.find((e) => e.id === id) : undefined;
      if (entry && installableVersions(entry).some((v) => satisfiesRange(v.version, range))) {
        return c.id;
      }
    }
    return null;
  }

  /** Problems that depend on what's installed and trusted right now. */
  #evaluate(s: Staged): { trust: TrustResult; missing: Missing; problems: string[] } {
    const m = s.pkg.manifest;
    const trust = this.#trust(s);
    const installed = new Map([...this.#installed.values()].map((x) => [x.row.id, x.row.version]));
    const req = checkRequirements(m, {
      installed,
      hasConnector: (id) => this.#ctx.registry.connector(id) !== undefined,
      findInCatalogs: (id, range) => this.#findInCatalogs(id, range),
    });
    return {
      trust,
      missing: req.missing,
      problems: [
        ...trust.problems,
        ...nameClashes(m.id, s.description, this.#nameIndex()),
        ...req.problems,
      ],
    };
  }

  async #stage(input: {
    bytes: Uint8Array;
    pkg: ExtensionPackage;
    source: ExtensionSource;
    catalogId: string | null;
    catalogPublisher: string | null;
    revoked: { reason: string } | null;
  }): Promise<ExtensionPreview> {
    this.#sweepStaged();
    const { pkg } = input;
    const m = pkg.manifest;
    const fixed: string[] = [];
    if (input.revoked) fixed.push(`The catalog revoked this version: ${input.revoked.reason}`);
    if (!satisfiesRange(SDK_VERSION, m.sdk)) {
      fixed.push(`It needs SDK ${m.sdk}, and this server has ${SDK_VERSION}.`);
    }
    const read = this.#readTemplates(m, pkg.files);
    fixed.push(...read.problems);

    const stagingId = newId("stg");
    let description: ExtensionDescription | null = null;
    let dir: string | null = null;
    let described = !m.main;
    if (m.main) {
      const unsupported = this.runtime.unsupportedReason;
      if (unsupported) fixed.push(`Extension code can't run on this server: ${unsupported}`);
      else if (fixed.length === 0 && this.#trust(input).problems.length === 0) {
        // Only code that passed every integrity check is started, even isolated.
        dir = this.cache.stagingDir(stagingId);
        try {
          await unpackTo(pkg.files, dir);
          description = await this.runtime.describe({
            id: m.id,
            version: m.version,
            digest: pkg.digest,
            dir,
            manifest: m,
          });
          described = true;
        } catch (err) {
          fixed.push(`The package's code didn't load: ${errorText(err)}`);
        }
      }
    }
    if (described) {
      fixed.push(...checkDescription(m, description), ...nodeTypeProblems(description));
    }

    const staged: Staged = {
      stagingId,
      expiresAt: Date.now() + STAGING_MS,
      bytes: input.bytes,
      pkg,
      source: input.source,
      catalogId: input.catalogId,
      catalogPublisher: input.catalogPublisher,
      description,
      templates: read.templates,
      fixedProblems: fixed,
      permissionsKey: permissionsKey(m.permissions),
      dir,
    };
    this.#staged.set(stagingId, staged);
    while (this.#staged.size > MAX_STAGED) {
      const oldest = this.#staged.values().next().value;
      if (oldest) this.#dropStaged(oldest);
    }
    return this.#previewView(staged);
  }

  #previewView(s: Staged): ExtensionPreview {
    const { trust, missing, problems } = this.#evaluate(s);
    const m = s.pkg.manifest;
    const installed = this.#installed.get(m.id);
    return {
      stagingId: s.stagingId,
      expiresAt: new Date(s.expiresAt).toISOString(),
      id: m.id,
      name: m.name,
      description: m.description,
      version: m.version,
      digest: s.pkg.digest,
      size: s.bytes.length,
      source: s.source,
      catalogId: s.catalogId,
      publisher: trust.signer
        ? this.publishers.ref(trust.signer.keyId, trust.signer.publisher)
        : null,
      signed: trust.signed,
      kinds: kindsOf(m, s.description),
      contents: contentsOf(
        s.description,
        s.templates.map((t) => ({ key: t.view.key, name: t.view.name })),
      ),
      permissions: describePermissions(m.permissions),
      permissionsKey: s.permissionsKey,
      diff: installed
        ? {
            fromVersion: installed.row.version,
            ...diffPermissions(installed.row.granted, m.permissions),
          }
        : null,
      missing,
      problems: [...s.fixedProblems, ...problems],
      readme: fileText(s.pkg.files, "README.md"),
    };
  }

  #dropStaged(s: Staged): void {
    this.#staged.delete(s.stagingId);
    if (s.dir) {
      const dir = s.dir;
      s.dir = null;
      void this.cache.remove(dir).catch(() => {});
    }
  }

  #sweepStaged(): void {
    const now = Date.now();
    for (const s of [...this.#staged.values()]) if (s.expiresAt < now) this.#dropStaged(s);
  }

  // ------------------------------------------------------------- changes

  /** Confirms a preview: the staging ID, digest, and permissions must be what was shown. */
  async install(
    actor: Actor,
    body: { stagingId: string; digest: string; permissions: string; trustPublisher?: boolean },
  ): Promise<ExtensionView> {
    await this.requireOwner(actor);
    return this.#serial(async () => {
      const staged = this.#staged.get(body.stagingId);
      if (!staged || staged.expiresAt < Date.now()) {
        if (staged) this.#dropStaged(staged);
        throw new ExtensionError("That preview expired. Preview the package again.", 410);
      }
      if (staged.pkg.digest !== body.digest || staged.permissionsKey !== body.permissions) {
        throw new ExtensionError(
          "The package or its permissions changed since the preview. Preview it again.",
          409,
        );
      }
      const m = staged.pkg.manifest;
      const { trust, problems } = this.#evaluate(staged);
      const all = [...staged.fixedProblems, ...problems];
      if (all.length > 0)
        throw new ExtensionError(`${m.name} can't be installed. ${all.join(" ")}`, 409);
      if (trust.needsTrust && trust.signer) {
        const fp = formatFingerprint(trust.signer.keyId);
        if (!body.trustPublisher) {
          throw new ExtensionError(
            `Trust ${trust.signer.publisher} (${fp}) to install this package.`,
            409,
          );
        }
        if (await this.publishers.trust(trust.signer, actor.userId)) {
          await audit(this.#ctx, {
            ...this.#by(actor),
            verb: "publisher.trusted",
            subjectType: "publisher",
            subjectId: trust.signer.keyId,
            details: { name: trust.signer.publisher, fingerprint: fp },
          });
        }
      }
      this.#staged.delete(staged.stagingId);

      const old = this.#installed.get(m.id);
      const row = await this.#writeInstall(actor, staged, trust, old);
      let next: InstalledExtension;
      try {
        next = await this.#apply(await this.#prepare(row, { kind: "staged", staged }), {
          replace: true,
        });
      } finally {
        staged.dir = null;
      }
      await audit(this.#ctx, {
        ...this.#by(actor),
        verb: old ? "extension.updated" : "extension.installed",
        subjectType: "extension",
        subjectId: m.id,
        details: {
          version: m.version,
          ...(old ? { fromVersion: old.row.version } : {}),
          source: staged.source,
          catalogId: staged.catalogId,
          digest: staged.pkg.digest,
          publisherKeyId: trust.signer?.keyId ?? null,
          permissions: describePermissions(m.permissions).map((l) => l.key),
        },
      });
      await this.#publish(next);
      return (await this.view(actor.workspaceId, m.id)) as ExtensionView;
    });
  }

  async #writeInstall(
    actor: Actor,
    s: Staged,
    trust: TrustResult,
    old: InstalledExtension | undefined,
  ): Promise<ExtensionRow> {
    const m = s.pkg.manifest;
    const now = new Date();
    // An update moves a revoked extension off its revoked version, so it can run again.
    const enabled = old ? old.row.enabled || old.row.revokedReason !== null : true;
    const fields = {
      name: m.name,
      description: m.description,
      version: m.version,
      source: s.source,
      catalogId: s.catalogId,
      publisherKeyId: trust.signer?.keyId ?? null,
      publisherName: trust.signer?.publisher ?? null,
      signed: trust.signed,
      enabled,
      status: (enabled ? "stopped" : "disabled") as ExtensionStatus,
      statusDetail: null,
      granted: m.permissions,
      revokedReason: null,
      updatedAt: now,
    };
    const contents = contentsOf(
      s.description,
      s.templates.map((t) => ({ key: t.view.key, name: t.view.name })),
    );
    return this.#ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.extensions)
        .values({ id: m.id, ...fields, installedBy: actor.userId, installedAt: now })
        .onConflictDoUpdate({ target: schema.extensions.id, set: fields })
        .returning();
      const pkgFields = {
        digest: s.pkg.digest,
        size: s.bytes.length,
        archive: s.bytes,
        manifest: m as unknown as Record<string, unknown>,
        description: s.description as unknown as Record<string, unknown> | null,
        contents,
        signature: s.pkg.signature as unknown as Record<string, unknown> | null,
      };
      await tx
        .insert(schema.extensionPackages)
        .values({ extensionId: m.id, version: m.version, ...pkgFields })
        .onConflictDoUpdate({
          target: [schema.extensionPackages.extensionId, schema.extensionPackages.version],
          set: pkgFields,
        });
      // Keep the installed version and the one before it.
      const keep = [...new Set([m.version, old?.row.version].filter((v): v is string => !!v))];
      await tx
        .delete(schema.extensionPackages)
        .where(
          and(
            eq(schema.extensionPackages.extensionId, m.id),
            notInArray(schema.extensionPackages.version, keep),
          ),
        );
      if (!row) throw new Error("the extension row wasn't written");
      return row;
    });
  }

  async setEnabled(actor: Actor, id: string, enabled: boolean): Promise<ExtensionView> {
    await this.requireOwner(actor);
    return this.#serial(async () => {
      const x = this.#installed.get(id);
      if (!x) throw new ExtensionError("No such extension.", 404);
      if (enabled && x.row.revokedReason) {
        throw new ExtensionError(
          `The catalog revoked ${x.row.name} ${x.row.version}: ${x.row.revokedReason} Update it to another version instead.`,
          409,
        );
      }
      // Turning an extension in error on again retries it.
      if (x.row.enabled === enabled && !(enabled && x.row.status === "error")) {
        return (await this.view(actor.workspaceId, id)) as ExtensionView;
      }
      const [row] = await this.#ctx.db
        .update(schema.extensions)
        .set({ enabled, updatedAt: new Date() })
        .where(eq(schema.extensions.id, id))
        .returning();
      if (!row) throw new ExtensionError("No such extension.", 404);
      // Enabling reads the stored package again, so a changed one is caught here too.
      const source: PackageSource = enabled
        ? { kind: "stored", stored: await this.#storedPackage(id, row.version) }
        : { kind: "same", from: x };
      const next = await this.#apply(await this.#prepare(row, source), { replace: false });
      await audit(this.#ctx, {
        ...this.#by(actor),
        verb: enabled ? "extension.enabled" : "extension.disabled",
        subjectType: "extension",
        subjectId: id,
        details: { version: row.version },
      });
      await this.#publish(next);
      return (await this.view(actor.workspaceId, id)) as ExtensionView;
    });
  }

  /**
   * Removes an extension, its installations in every workspace, and their
   * credentials. Workflows that use it stay, and fail on its node types.
   */
  async remove(actor: Actor, id: string): Promise<void> {
    await this.requireOwner(actor);
    await this.#serial(async () => {
      const x = this.#installed.get(id);
      if (!x) throw new ExtensionError("No such extension.", 404);
      const connectorIds = x.contents.connectors.map((c) => c.id);
      const installs =
        connectorIds.length > 0
          ? await this.#ctx.db
              .select({
                id: schema.connectorInstallations.id,
                name: schema.connectorInstallations.name,
                connectorId: schema.connectorInstallations.connectorId,
                credentialId: schema.connectorInstallations.credentialId,
              })
              .from(schema.connectorInstallations)
              .where(inArray(schema.connectorInstallations.connectorId, connectorIds))
          : [];
      const providers = new Set(
        x.contents.connectors.filter((c) => c.isExecutionProvider).map((c) => c.id),
      );
      for (const inst of installs) {
        if (!providers.has(inst.connectorId)) continue;
        const live = await liveSandboxCount(this.#ctx, inst.id);
        if (live > 0) {
          throw new ExtensionError(
            `${inst.name} still has ${live} ${live === 1 ? "sandbox" : "sandboxes"}. Destroy ${live === 1 ? "it" : "them"} on the Sandboxes page first.`,
            409,
          );
        }
      }

      for (const cid of x.connectorIds) {
        this.#ctx.registry.unregisterConnector(cid);
        this.#owners.delete(cid);
      }
      this.#installed.delete(id);
      this.#configHosts.delete(id);
      this.#rebuildTemplates();
      if (connectorIds.length > 0) {
        await this.#ctx.connectors.restartConnectors(new Set(connectorIds));
      }
      if (x.active) await this.runtime.deactivate(id);
      await this.#ctx.db.transaction(async (tx) => {
        if (installs.length > 0) {
          await tx.delete(schema.connectorInstallations).where(
            inArray(
              schema.connectorInstallations.id,
              installs.map((i) => i.id),
            ),
          );
          const creds = installs.map((i) => i.credentialId).filter((c): c is string => !!c);
          if (creds.length > 0) {
            await tx.delete(schema.credentials).where(inArray(schema.credentials.id, creds));
          }
        }
        await tx.delete(schema.extensions).where(eq(schema.extensions.id, id));
      });
      if (x.dir) await this.cache.remove(x.dir);
      await audit(this.#ctx, {
        ...this.#by(actor),
        verb: "extension.removed",
        subjectType: "extension",
        subjectId: id,
        details: { version: x.row.version, installations: installs.length },
      });
      for (const ws of this.#ctx.hub.workspaces()) {
        this.#ctx.hub.publish(ws, { type: "extension.removed", id });
      }
    });
  }

  // ------------------------------------------------------------- catalogs and publishers

  async addCatalog(actor: Actor, url: string): Promise<CatalogView> {
    await this.requireOwner(actor);
    const state = await this.catalogs.add(url, actor.userId);
    await audit(this.#ctx, {
      ...this.#by(actor),
      verb: "catalog.added",
      subjectType: "catalog",
      subjectId: state.id,
      details: { url: state.url, name: state.name },
    });
    await this.#serial(() => this.#applyRevocations(state, actor));
    return toCatalogView(state);
  }

  async refreshCatalog(actor: Actor, id: string): Promise<CatalogView> {
    await this.requireOwner(actor);
    const state = await this.catalogs.refresh(id);
    await this.#serial(() => this.#applyRevocations(state, actor));
    return toCatalogView(state);
  }

  async removeCatalog(actor: Actor, id: string): Promise<void> {
    await this.requireOwner(actor);
    const state = await this.catalogs.remove(id);
    await audit(this.#ctx, {
      ...this.#by(actor),
      verb: "catalog.removed",
      subjectType: "catalog",
      subjectId: id,
      details: { url: state.url, name: state.name },
    });
  }

  /** Installed extensions keep running, but no new install or update can use the key. */
  async removePublisher(actor: Actor, keyId: string): Promise<void> {
    await this.requireOwner(actor);
    const row = await this.publishers.remove(keyId);
    if (!row) throw new ExtensionError("That publisher isn't trusted.", 404);
    await audit(this.#ctx, {
      ...this.#by(actor),
      verb: "publisher.removed",
      subjectType: "publisher",
      subjectId: keyId,
      details: { name: row.name, fingerprint: formatFingerprint(keyId) },
    });
  }

  /** Disables installed versions the catalog revokes, with its reason. */
  async #applyRevocations(state: CatalogState, actor: Actor | null): Promise<void> {
    if (!state.document) return;
    for (const x of [...this.#installed.values()]) {
      if (x.row.catalogId !== state.id || x.row.source === "upload") continue;
      const entry = state.document.extensions.find((e) => e.id === x.row.id);
      const reason = entry?.versions.find((v) => v.version === x.row.version)?.revoked?.reason;
      if (reason && x.row.revokedReason !== reason) {
        const [row] = await this.#ctx.db
          .update(schema.extensions)
          .set({ enabled: false, revokedReason: reason, updatedAt: new Date() })
          .where(eq(schema.extensions.id, x.row.id))
          .returning();
        if (!row) continue;
        const next = await this.#apply(await this.#prepare(row, { kind: "same", from: x }), {
          replace: false,
        });
        const entryAudit = {
          verb: "extension.revoked",
          subjectType: "extension",
          subjectId: x.row.id,
          details: { version: x.row.version, reason, catalogId: state.id },
        };
        if (actor) await audit(this.#ctx, { ...this.#by(actor), ...entryAudit });
        else await this.#auditAll(entryAudit);
        this.#ctx.log.warn(
          { extensionId: x.row.id, reason },
          "catalog revoked an installed version",
        );
        await this.#publish(next);
      } else if (!reason && x.row.revokedReason) {
        // The catalog took the revocation back. The extension stays off until someone turns it on.
        await this.#ctx.db
          .update(schema.extensions)
          .set({ revokedReason: null })
          .where(eq(schema.extensions.id, x.row.id));
        x.row = { ...x.row, revokedReason: null };
        await this.#publish(x);
      }
    }
  }

  // ------------------------------------------------------------- export

  /** Builds an unsigned workflow package from a workflow's active version, or its draft. */
  async exportWorkflow(
    actor: Actor,
    wf: WorkflowRow,
    input: { id: string; version: string; name: string },
  ): Promise<{ bytes: Uint8Array; filename: string }> {
    const detail = await this.#ctx.workflows.detail(wf);
    const [installs, [user]] = await Promise.all([
      this.#ctx.db
        .select({
          id: schema.connectorInstallations.id,
          connectorId: schema.connectorInstallations.connectorId,
        })
        .from(schema.connectorInstallations)
        .where(eq(schema.connectorInstallations.workspaceId, wf.workspaceId)),
      this.#ctx.db
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, actor.userId)),
    ]);
    const registry = this.#ctx.registry;
    const out = buildWorkflowPackage({
      definition: detail.active ?? detail.draft,
      ...input,
      publisher: user?.name?.trim() || "Sling",
      installations: new Map(installs.map((i) => [i.id, { connectorId: i.connectorId }])),
      spec: (type, version) => registry.get(type, version) ?? null,
      connectorName: (id) => registry.connector(id)?.name ?? id,
      extensionOf: (connectorId) => {
        const x = this.ownerOf(connectorId);
        return x ? { id: x.row.id, version: x.row.version } : null;
      },
    });
    return { bytes: out.bytes, filename: `${input.id}-${input.version}.slx` };
  }

  // ------------------------------------------------------------- runtime events

  #onRuntimeStatus(id: string, status: ExtensionStatus, detail: string | null): void {
    const x = this.#installed.get(id);
    // A disabled or replaced extension's process reporting in doesn't change its row.
    if (!x?.active || !x.row.enabled) return;
    if (x.row.status === status && x.row.statusDetail === detail) return;
    x.row = { ...x.row, status, statusDetail: detail };
    void this.#writeStatus(id);
    void this.#publish(x);
  }

  #onCrash(id: string, reason: string): void {
    this.#ctx.log.warn({ extensionId: id, reason }, "extension process crashed");
    void this.#auditAll({
      verb: "extension.crashed",
      subjectType: "extension",
      subjectId: id,
      details: { reason, version: this.#installed.get(id)?.row.version ?? null },
    });
  }

  #by(actor: Actor): Pick<AuditEntry, "workspaceId" | "actorType" | "actorId"> {
    return { workspaceId: actor.workspaceId, actorType: "user", actorId: actor.userId };
  }

  /** Extensions belong to the server, so events nobody caused are logged in every workspace. */
  async #auditAll(entry: Omit<AuditEntry, "workspaceId" | "actorType">): Promise<void> {
    try {
      const workspaces = await this.#ctx.db
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces);
      for (const ws of workspaces) {
        await audit(this.#ctx, { ...entry, workspaceId: ws.id, actorType: "system" });
      }
    } catch (err) {
      this.#ctx.log.error({ err, entry }, "audit write failed");
    }
  }
}
