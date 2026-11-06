import type { AppContext } from "../context.ts";
import type { ExtensionRuntime } from "./runtime.ts";

/**
 * Installs, updates, and removes extensions, keeps catalogs and trusted
 * publishers, and registers what installed extensions add.
 */
export class ExtensionService {
  readonly #ctx: AppContext;
  readonly runtime: ExtensionRuntime;

  constructor(ctx: AppContext, runtime: ExtensionRuntime) {
    this.#ctx = ctx;
    this.runtime = runtime;
  }

  /** Loads installed extensions and registers what they add. Starts no processes. */
  async start(): Promise<void> {
    void this.#ctx;
  }

  async stop(): Promise<void> {
    await this.runtime.stopAll();
  }
}
