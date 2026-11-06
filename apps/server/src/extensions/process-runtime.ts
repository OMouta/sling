import type { AnyConnector, ExtensionDescription } from "@sling/connector-sdk";
import { type BrokerOptions, NetworkBroker } from "./broker.ts";
import {
  DEFAULT_DEADLINES,
  DEFAULT_TIMINGS,
  type Deadlines,
  ExtensionHost,
  ExtensionProcess,
  type HostLogger,
  type HostTimings,
} from "./host.ts";
import { buildConnectors, parseDescription } from "./proxy.ts";
import type {
  ActiveExtension,
  ExtensionLogLine,
  ExtensionRuntime,
  RuntimeEvents,
  UnpackedExtension,
} from "./runtime.ts";

export interface ProcessRuntimeOptions {
  /** Server log. Extension lines, refusals, and crashes go here tagged with the extension. */
  log?: HostLogger;
  timings?: Partial<HostTimings>;
  deadlines?: Partial<Deadlines>;
  /** Network settings, such as a resolver for tests. */
  network?: Omit<BrokerOptions, "log" | "onRefusal">;
}

const quiet: HostLogger = { info() {}, warn() {}, error() {} };

/**
 * Whether this Node can deny a process the network. Node 24's permission
 * model can't, so extensions there would have the server's network.
 */
export function canDenyNetwork(): boolean {
  return process.allowedNodeEnvironmentFlags.has("--allow-net");
}

/** Runs each extension in its own Node process under the permission model. */
export class ProcessRuntime implements ExtensionRuntime {
  readonly unsupportedReason: string | null;
  readonly #log: HostLogger;
  readonly #timings: HostTimings;
  readonly #deadlines: Deadlines;
  readonly #broker: NetworkBroker;
  readonly #hosts = new Map<string, ExtensionHost>();
  #events: RuntimeEvents | null = null;

  constructor(opts: ProcessRuntimeOptions = {}) {
    this.unsupportedReason = canDenyNetwork()
      ? null
      : `Extensions need Node 26 or later. This server runs Node ${process.versions.node}.`;
    this.#log = opts.log ?? quiet;
    this.#timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.#deadlines = { ...DEFAULT_DEADLINES, ...opts.deadlines };
    this.#broker = new NetworkBroker({
      ...opts.network,
      log: this.#log,
      onRefusal: (policy, message) => {
        // The broker already logged it on the server; this is for the extension's own log.
        this.#hosts.get(policy.extensionId)?.addLine("error", message);
      },
    });
  }

  setEvents(events: RuntimeEvents): void {
    this.#events = events;
  }

  /** The host for an extension ID, for tests and measurements. */
  host(extensionId: string): ExtensionHost | undefined {
    return this.#hosts.get(extensionId);
  }

  async describe(pkg: UnpackedExtension): Promise<ExtensionDescription> {
    if (this.unsupportedReason) throw new Error(this.unsupportedReason);
    if (!pkg.manifest.main) throw new Error("The package has no code to describe");
    const stderr: string[] = [];
    const proc = await ExtensionProcess.start({
      extensionId: pkg.id,
      dir: pkg.dir,
      main: pkg.manifest.main,
      memoryMb: pkg.manifest.memoryMb,
      timings: this.#timings,
      hooks: {
        onRequest: async (_p, method) => {
          throw new TypeError(
            `Sling refused ${method}: an extension can't reach the network or Sling while it's being described`,
          );
        },
        onNote: () => {},
        onStderr: (line) => {
          if (stderr.length < 20) stderr.push(line);
        },
        onExit: () => {},
      },
    }).catch((err: unknown) => {
      const detail = stderr.length > 0 ? `\n${stderr.join("\n")}` : "";
      throw new Error(`${err instanceof Error ? err.message : String(err)}${detail}`);
    });
    try {
      return parseDescription(await proc.call("describe", {}, this.#deadlines.describe));
    } finally {
      await proc.stop();
    }
  }

  activate(ext: ActiveExtension): AnyConnector[] {
    let host = this.#hosts.get(ext.id);
    if (!host) {
      host = new ExtensionHost({
        id: ext.id,
        timings: this.#timings,
        deadlines: this.#deadlines,
        broker: this.#broker,
        log: this.#log,
        events: () => this.#events,
        unsupportedReason: this.unsupportedReason,
      });
      this.#hosts.set(ext.id, host);
    }
    return buildConnectors(host, host.activate(ext));
  }

  async deactivate(extensionId: string): Promise<void> {
    await this.#hosts.get(extensionId)?.disable();
  }

  log(extensionId: string): ExtensionLogLine[] {
    return this.#hosts.get(extensionId)?.log() ?? [];
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#hosts.values()].map((h) => h.disable("stopped")));
    await this.#broker.close();
  }
}
