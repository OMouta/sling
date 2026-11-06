import type { AnyConnector, ExtensionDescription } from "@sling/connector-sdk";
import type {
  ActiveExtension,
  ExtensionLogLine,
  ExtensionRuntime,
  RuntimeEvents,
  UnpackedExtension,
} from "./runtime.ts";

/** Runs each extension in its own Node process under the permission model. */
export class ProcessRuntime implements ExtensionRuntime {
  readonly unsupportedReason: string | null = "Extension processes aren't built yet";

  setEvents(_events: RuntimeEvents): void {}

  async describe(_pkg: UnpackedExtension): Promise<ExtensionDescription> {
    throw new Error(this.unsupportedReason ?? "unsupported");
  }

  activate(_ext: ActiveExtension): AnyConnector[] {
    return [];
  }

  async deactivate(_extensionId: string): Promise<void> {}

  log(_extensionId: string): ExtensionLogLine[] {
    return [];
  }

  async stopAll(): Promise<void> {}
}
