/** An in-memory Docker daemon and the contexts the server provides. Tests only. */
import type { NodeLogger, ProviderContext } from "@sling/connector-sdk";
import {
  type ContainerInfo,
  type ContainerSpec,
  type ContainerSummary,
  type DockerApi,
  DockerError,
  type RegistryAuth,
} from "./engine.ts";
import {
  configSchema,
  credentialsSchema,
  type DockerConfig,
  type DockerCredentials,
} from "./schemas.ts";

export const silentLog: NodeLogger = { info() {}, warn() {}, error() {} };

export interface FakeContainer {
  id: string;
  name: string;
  spec: ContainerSpec;
  state: "created" | "running" | "exited";
}

type Method = Exclude<keyof DockerApi, "endpoint" | "plaintextTcp">;

export class FakeDocker implements DockerApi {
  readonly endpoint = "unix:///var/run/docker.sock";
  plaintextTcp = false;
  images = new Set<string>();
  networks = new Set(["bridge"]);
  containers = new Map<string, FakeContainer>();
  pulls: { image: string; auth: RegistryAuth | null }[] = [];
  calls: string[] = [];
  /** Makes the next call to a method throw. */
  failures = new Map<Method, Error>();
  version_ = { Version: "29.4.0", ApiVersion: "1.54", Os: "linux", Arch: "arm64" };
  #next = 1;

  #enter(method: Method, detail = "") {
    this.calls.push(detail ? `${method} ${detail}` : method);
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  #find(idOrName: string): FakeContainer | undefined {
    return (
      this.containers.get(idOrName) ??
      [...this.containers.values()].find((c) => c.name === idOrName || c.id.startsWith(idOrName))
    );
  }

  async ping() {
    this.#enter("ping");
  }

  async version() {
    this.#enter("version");
    return this.version_;
  }

  async imageExists(image: string) {
    this.#enter("imageExists", image);
    return this.images.has(image);
  }

  async pullImage(image: string, auth: RegistryAuth | null) {
    this.#enter("pullImage", image);
    this.pulls.push({ image, auth });
    this.images.add(image);
  }

  async networkExists(name: string) {
    this.#enter("networkExists", name);
    return this.networks.has(name);
  }

  async createContainer(name: string, spec: ContainerSpec) {
    this.#enter("createContainer", name);
    if (!this.images.has(spec.Image)) {
      throw new DockerError(`No such image: ${spec.Image}`, { status: 404 });
    }
    if (this.#find(name)) {
      throw new DockerError(`Conflict. The container name "/${name}" is already in use`, {
        status: 409,
      });
    }
    const id = `${String(this.#next++).padStart(4, "0")}${"f".repeat(60)}`;
    this.containers.set(id, { id, name, spec, state: "created" });
    return id;
  }

  async startContainer(id: string) {
    this.#enter("startContainer", id);
    const c = this.#find(id);
    if (!c) throw new DockerError(`No such container: ${id}`, { status: 404 });
    c.state = "running";
  }

  async stopContainer(id: string) {
    this.#enter("stopContainer", id);
    const c = this.#find(id);
    if (!c) return false;
    c.state = "exited";
    return true;
  }

  async removeContainer(id: string) {
    this.#enter("removeContainer", id);
    const c = this.#find(id);
    if (!c) return false;
    this.containers.delete(c.id);
    return true;
  }

  async inspectContainer(id: string): Promise<ContainerInfo | null> {
    this.#enter("inspectContainer", id);
    const c = this.#find(id);
    if (!c) return null;
    return {
      Id: c.id,
      Name: `/${c.name}`,
      State: { Status: c.state, Running: c.state === "running" },
      Config: { Image: c.spec.Image, Env: c.spec.Env, Labels: c.spec.Labels },
      HostConfig: c.spec.HostConfig,
      NetworkSettings: { Ports: {}, Networks: { [c.spec.HostConfig.NetworkMode]: {} } },
    };
  }

  async listContainers(labels: string[]): Promise<ContainerSummary[]> {
    this.#enter("listContainers", labels.join(","));
    return [...this.containers.values()]
      .filter((c) =>
        labels.every((filter) => {
          const [key, value] = filter.split("=", 2) as [string, string | undefined];
          const actual = c.spec.Labels[key];
          return value === undefined ? actual !== undefined : actual === value;
        }),
      )
      .map((c) => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.spec.Labels, State: c.state }));
  }

  async containerLogs(id: string) {
    this.#enter("containerLogs", id);
    return "";
  }

  /** Adds a container as if something else had created it. */
  seed(name: string, labels: Record<string, string>, image = "alpine:3"): string {
    this.images.add(image);
    const id = `${String(this.#next++).padStart(4, "0")}${"e".repeat(60)}`;
    this.containers.set(id, {
      id,
      name,
      state: "running",
      spec: {
        Image: image,
        Env: [],
        Labels: labels,
        Tty: false,
        OpenStdin: false,
        AttachStdin: false,
        StopTimeout: 10,
        HostConfig: {
          NetworkMode: "bridge",
          PidsLimit: 0,
          Init: true,
          CapDrop: [],
          CapAdd: [],
          SecurityOpt: [],
          Privileged: false,
          PublishAllPorts: false,
          PortBindings: {},
          AutoRemove: false,
          RestartPolicy: { Name: "no" },
          ExtraHosts: [],
        },
      },
    });
    return id;
  }
}

export function context(
  overrides: {
    credentials?: Partial<DockerCredentials>;
    config?: Partial<DockerConfig>;
    workspaceId?: string;
    log?: NodeLogger;
  } = {},
): ProviderContext<DockerCredentials, DockerConfig> {
  return {
    installationId: "ins_docker",
    workspaceId: overrides.workspaceId ?? "ws_1",
    credentials: credentialsSchema.parse(overrides.credentials ?? {}),
    config: configSchema.parse(overrides.config ?? {}),
    log: overrides.log ?? silentLog,
    signal: new AbortController().signal,
  };
}

/** A logger that keeps what it was told. */
export function recordingLog() {
  const lines: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  const log: NodeLogger = {
    info: (message, data) => lines.push({ level: "info", message, data }),
    warn: (message, data) => lines.push({ level: "warn", message, data }),
    error: (message, data) => lines.push({ level: "error", message, data }),
  };
  return { log, lines };
}
