/** `RailwayApi` on the real `railway` SDK, whose sandbox API is in beta. The version is pinned. */
import { Sandbox, SandboxFileNotFoundError, SandboxNotFoundError } from "railway";
import type { RailwayApi, RailwaySandbox } from "./api.ts";
import type { RailwayCredentials } from "./schemas.ts";

function connection(credentials: RailwayCredentials) {
  return {
    token: credentials.apiToken,
    authType:
      credentials.tokenType === "project" ? ("project-token" as const) : ("bearer" as const),
    environmentId: credentials.environmentId,
  };
}

function wrap(sandbox: Sandbox): RailwaySandbox {
  return {
    get id() {
      return sandbox.id;
    },
    get status() {
      return sandbox.status;
    },
    get region() {
      return sandbox.region;
    },

    async exec(command, options = {}) {
      const result = await sandbox.exec(command, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.timeoutSec ? { timeoutSec: options.timeoutSec } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        // Launch output is small; cap it anyway so a chatty pull can't grow memory.
        maxOutputBytes: 64 * 1024,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    },

    async execDetached(command, options = {}) {
      const handle = sandbox.exec(command, {
        captureOutput: false,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      // The handle settles when it detaches; nothing else waits on it.
      handle.catch(() => {});
      await handle.sessionName;
      return handle.detach();
    },

    async writeFile(path, content, mode) {
      await sandbox.files.write(path, content, mode === undefined ? undefined : { mode });
    },

    async readFile(path) {
      try {
        return await sandbox.files.read(path);
      } catch (error) {
        if (error instanceof SandboxFileNotFoundError) return null;
        throw error;
      }
    },

    async destroy() {
      await sandbox.destroy();
    },
  };
}

export function createSdkClient(credentials: RailwayCredentials): RailwayApi {
  const base = connection(credentials);
  return {
    async create(options) {
      return wrap(
        await Sandbox.create({
          ...base,
          idleTimeoutMinutes: options.idleTimeoutMinutes,
          ...(options.resources ? { resources: options.resources } : {}),
        }),
      );
    },

    async connect(id) {
      try {
        return wrap(await Sandbox.connect(id, base));
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return null;
        throw error;
      }
    },

    async list(first = 100) {
      const sandboxes = await Sandbox.list({ ...base, first });
      return sandboxes.map((s) => ({ id: s.id, status: s.status, createdAt: s.createdAt }));
    },
  };
}
