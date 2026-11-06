/**
 * How the control plane runs extension code. `ProcessRuntime` runs each
 * extension in its own restricted Node process; tests can swap in another.
 */
import type {
  AnyConnector,
  ExtensionDescription,
  ExtensionManifest,
  ExtensionPermissions,
} from "@sling/connector-sdk";
import type { ExtensionStatus } from "@sling/core";

/** A package unpacked on disk, with its digest already checked. */
export interface UnpackedExtension {
  id: string;
  version: string;
  digest: string;
  /** Holds the package's files. The extension's process may read this directory and nothing else of the server's. */
  dir: string;
  manifest: ExtensionManifest;
}

/** An installed, enabled extension with code. */
export interface ActiveExtension extends UnpackedExtension {
  description: ExtensionDescription;
  /** What the owner approved. The runtime enforces exactly this. */
  granted: ExtensionPermissions;
  /**
   * Hostnames from installation config fields named in
   * `granted.network.configHosts`, across every installation of this
   * extension's connectors. Called on each network request, so it must be
   * cheap: the extension service keeps it up to date.
   */
  configHosts(): ReadonlySet<string>;
}

export interface ExtensionLogLine {
  at: Date;
  level: "info" | "warn" | "error";
  message: string;
}

export interface RuntimeEvents {
  /** The process for an extension started, stopped, or failed. */
  onStatus(extensionId: string, status: ExtensionStatus, detail: string | null): void;
  /** The process crashed, ran out of memory, or was killed for not answering. */
  onCrash(extensionId: string, reason: string): void;
}

export interface ExtensionRuntime {
  /** Null when this server can isolate extension code. Otherwise, why not. */
  readonly unsupportedReason: string | null;
  setEvents(events: RuntimeEvents): void;
  /**
   * Starts the package in a fresh restricted process, reads what it adds with
   * `describe()`, and stops the process. Throws when the code fails to load.
   */
  describe(pkg: UnpackedExtension): Promise<ExtensionDescription>;
  /**
   * Connectors for the server to register. Their functions call into the
   * extension's process, which starts on the first call. Activating the same
   * ID again replaces the previous version: new calls go to the new code, and
   * the old process stops once its calls finish.
   */
  activate(ext: ActiveExtension): AnyConnector[];
  /** Stops the process. Calls still in flight fail with "the extension is disabled". */
  deactivate(extensionId: string): Promise<void>;
  /** The last lines the extension's process logged, oldest first. */
  log(extensionId: string): ExtensionLogLine[];
  stopAll(): Promise<void>;
}
