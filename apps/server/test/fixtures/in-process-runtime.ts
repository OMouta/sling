/**
 * An extension runtime for tests that loads each bundle into the test
 * process. Nothing is isolated, so it's only for packages the tests build
 * themselves. Set SLING_TEST_EXTENSION_RUNTIME=process to run the same tests
 * on the real process runtime.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AnyConnector, ExtensionDefinition } from "@sling/connector-sdk";
import type { ExtensionStatus } from "@sling/core";
import { ProcessRuntime } from "../../src/extensions/process-runtime.ts";
import type {
  ActiveExtension,
  ExtensionLogLine,
  ExtensionRuntime,
  RuntimeEvents,
  UnpackedExtension,
} from "../../src/extensions/runtime.ts";

// Node's own loader: it loads a bundle in milliseconds, and synchronously, which
// `activate` needs. Vitest's `import()` would transform the whole bundle first.
const load = createRequire(import.meta.url);

/**
 * Definitions by package digest. Every unpack is a new directory, so the same
 * code is never loaded from a stale path, and a server restarted in the same
 * process reuses what's loaded, as the real runtime starts nothing on start.
 */
const definitions = new Map<string, ExtensionDefinition>();

function definitionOf(pkg: UnpackedExtension): ExtensionDefinition {
  const hit = definitions.get(pkg.digest);
  if (hit) return hit;
  if (!pkg.manifest.main) throw new Error(`${pkg.id} has no code`);
  const mod = load(join(pkg.dir, pkg.manifest.main)) as { default?: ExtensionDefinition };
  const def = mod.default;
  if (!def || typeof def.describe !== "function") {
    throw new Error("The bundle doesn't default-export defineExtension(...)");
  }
  definitions.set(pkg.digest, def);
  return def;
}

export class InProcessRuntime implements ExtensionRuntime {
  readonly unsupportedReason: string | null = null;
  readonly calls = { describe: 0, activate: 0, deactivate: 0 };
  readonly #active = new Map<string, ActiveExtension>();
  readonly #logs = new Map<string, ExtensionLogLine[]>();
  #events: RuntimeEvents | null = null;

  setEvents(events: RuntimeEvents): void {
    this.#events = events;
  }

  async describe(pkg: UnpackedExtension) {
    this.calls.describe++;
    return definitionOf(pkg).describe();
  }

  activate(ext: ActiveExtension): AnyConnector[] {
    this.calls.activate++;
    const connectors = definitionOf(ext).connectors;
    this.#active.set(ext.id, ext);
    this.#log(ext.id, "info", `activated ${ext.version}`);
    return connectors;
  }

  async deactivate(extensionId: string): Promise<void> {
    this.calls.deactivate++;
    if (this.#active.delete(extensionId)) this.#log(extensionId, "info", "deactivated");
  }

  log(extensionId: string): ExtensionLogLine[] {
    return [...(this.#logs.get(extensionId) ?? [])];
  }

  async stopAll(): Promise<void> {
    this.#active.clear();
  }

  /** What the extension service handed over, to check grants and config hosts. */
  active(extensionId: string): ActiveExtension | undefined {
    return this.#active.get(extensionId);
  }

  /** Reports a status as a process runtime would. */
  emitStatus(extensionId: string, status: ExtensionStatus, detail: string | null = null): void {
    this.#events?.onStatus(extensionId, status, detail);
  }

  emitCrash(extensionId: string, reason: string): void {
    this.#events?.onCrash(extensionId, reason);
  }

  #log(id: string, level: ExtensionLogLine["level"], message: string) {
    const lines = this.#logs.get(id) ?? [];
    lines.push({ at: new Date(), level, message });
    if (lines.length > 200) lines.shift();
    this.#logs.set(id, lines);
  }
}

/** The runtime end-to-end tests run on: in-process unless SLING_TEST_EXTENSION_RUNTIME=process. */
export function testRuntime(): ExtensionRuntime {
  return process.env.SLING_TEST_EXTENSION_RUNTIME === "process"
    ? new ProcessRuntime()
    : new InProcessRuntime();
}
