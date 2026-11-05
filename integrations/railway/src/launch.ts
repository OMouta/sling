/**
 * Shell commands the provider runs inside a Railway sandbox. They carry no
 * secret values: secrets reach the commands as exec environment variables,
 * and `docker run -e NAME` copies a variable into the container by name.
 * Railway keeps exec command lines in its session list, so a value in one
 * would be visible there.
 */
import { SANDBOX_LABELS } from "@sling/connector-sdk";

/** Where the provider leaves a note saying which Sling sandbox this is, since Railway sandboxes have no labels. */
export const MARKER_PATH = "/tmp/sling/sandbox.json";

/** Exec env names for the registry login. Never passed into the container. */
export const REGISTRY_USER_ENV = "SLING_REGISTRY_USERNAME";
export const REGISTRY_PASSWORD_ENV = "SLING_REGISTRY_PASSWORD";

export const EXPIRES_LABEL = "sling.expires-at";

/** Exit codes the launch script uses for problems it recognizes. */
export const EXIT_NO_DOCKER = 96;
export const EXIT_DOCKER_DOWN = 97;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function containerName(sandboxId: string): string {
  return `sling-${sandboxId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

/** Registry host for `docker login`, or docker.io for Docker Hub. */
export function registryOf(image: string): string {
  const name = image.split("@")[0] ?? image;
  const first = name.split("/")[0] ?? "";
  return name.includes("/") && (/[.:]/.test(first) || first === "localhost") ? first : "docker.io";
}

/** Waits up to a minute for the sandbox's Docker daemon, which may still be starting. */
export const WAIT_FOR_DOCKER = [
  `command -v docker >/dev/null 2>&1 || { echo "Docker isn't installed in this sandbox." >&2; exit ${EXIT_NO_DOCKER}; }`,
  "i=0",
  "until docker info >/dev/null 2>&1; do",
  "  i=$((i+1))",
  `  if [ "$i" -ge 60 ]; then echo "Docker didn't start in this sandbox." >&2; exit ${EXIT_DOCKER_DOWN}; fi`,
  "  sleep 1",
  "done",
].join("\n");

/** Logs in for this script only, in a throwaway Docker config that's removed on exit. */
function registryLogin(image: string, withLogin: boolean): string[] {
  const lines = ['export DOCKER_CONFIG="$(mktemp -d)"', `trap 'rm -rf "$DOCKER_CONFIG"' EXIT`];
  if (withLogin) {
    lines.push(
      `printf '%s' "$${REGISTRY_PASSWORD_ENV}" | docker login --username "$${REGISTRY_USER_ENV}" --password-stdin ${shellQuote(registryOf(image))} >/dev/null`,
    );
  }
  return lines;
}

export interface LaunchArgs {
  sandboxId: string;
  image: string;
  /** Names of the variables to copy into the container. Their values come from the exec env. */
  envNames: string[];
  labels: Record<string, string>;
  withLogin: boolean;
  /** Replaces the image's command. Tests use it. */
  command?: string[];
}

/** Pulls the image and starts it detached, with the boot env copied in by name. */
export function launchScript(args: LaunchArgs): string {
  for (const name of args.envNames) {
    if (!ENV_NAME.test(name)) throw new Error(`"${name}" isn't a valid environment variable name.`);
  }
  const labels = Object.entries(args.labels).map(([k, v]) => `--label ${shellQuote(`${k}=${v}`)}`);
  const run = [
    "docker run -d",
    `--name ${shellQuote(containerName(args.sandboxId))}`,
    ...labels,
    ...args.envNames.map((name) => `-e ${name}`),
    "--cap-drop ALL",
    "--security-opt no-new-privileges:true",
    "--restart no",
    shellQuote(args.image),
    ...(args.command ?? []).map(shellQuote),
  ].join(" ");
  return [
    "set -eu",
    WAIT_FOR_DOCKER,
    ...registryLogin(args.image, args.withLogin),
    `docker pull --quiet ${shellQuote(args.image)} >/dev/null`,
    `${run} >/dev/null`,
  ].join("\n");
}

/**
 * Holds an exec open while the container runs, which keeps Railway from
 * idling the sandbox out mid-task. After `seconds` it removes the container,
 * so the sandbox goes idle and Railway destroys it, even if Sling is down.
 */
export function keepaliveScript(sandboxId: string, seconds: number): string {
  const name = shellQuote(containerName(sandboxId));
  return `timeout ${Math.ceil(seconds)} docker wait ${name} >/dev/null 2>&1; docker rm -f ${name} >/dev/null 2>&1`;
}

/**
 * For the connection test: prints the Docker version and the CPU architecture,
 * then checks the image can be pulled from here.
 */
export function checkScript(image: string, withLogin: boolean): string {
  return [
    "set -eu",
    WAIT_FOR_DOCKER,
    ...registryLogin(image, withLogin),
    "docker version --format '{{.Server.Version}}'",
    "uname -m",
    `docker manifest inspect ${shellQuote(image)} >/dev/null`,
  ].join("\n");
}

export function sandboxLabels(
  sandboxId: string,
  workspaceId: string,
  extra: Record<string, string>,
  expiresAt: Date,
): Record<string, string> {
  return {
    ...extra,
    [SANDBOX_LABELS.sandbox]: sandboxId,
    [SANDBOX_LABELS.workspace]: workspaceId,
    [EXPIRES_LABEL]: expiresAt.toISOString(),
  };
}
