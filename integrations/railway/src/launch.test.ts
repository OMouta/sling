import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRETS } from "./fakes.ts";
import {
  checkScript,
  containerName,
  EXIT_DOCKER_DOWN,
  EXIT_NO_DOCKER,
  keepaliveScript,
  launchScript,
  registryOf,
  sandboxLabels,
  shellQuote,
} from "./launch.ts";

const run = promisify(execFile);

/**
 * A stand-in `docker` that records each call's arguments, and for `run`, the
 * values of the variables named with -e as the CLI would see them.
 */
const STUB = `#!/bin/sh
log="$STUB_DIR/calls"
printf '%s\\n' "$*" >> "$log"
case "$1" in
  info) [ -f "$STUB_DIR/down" ] && exit 1; exit 0 ;;
  login) cat > "$STUB_DIR/login-stdin"; printf '%s' "$DOCKER_CONFIG" > "$STUB_DIR/docker-config"; exit 0 ;;
  run)
    shift
    while [ $# -gt 0 ]; do
      if [ "$1" = "-e" ]; then eval "printf '%s=%s\\n' \\"$2\\" \\"\\$$2\\"" >> "$STUB_DIR/run-env"; shift; fi
      shift
    done
    echo 0123456789abcdef ;;
  version) echo 29.1.0 ;;
esac
exit 0
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sling-railway-"));
  await writeFile(join(dir, "docker"), STUB);
  await chmod(join(dir, "docker"), 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function sh(script: string, env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run("/bin/sh", ["-c", script], {
      env: { PATH: `${dir}:/usr/bin:/bin`, STUB_DIR: dir, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const calls = async () => (await readFile(join(dir, "calls"), "utf8")).trim().split("\n");

const BOOT_ENV = {
  SLING_URL: "https://sling.example.com",
  SLING_REPOS: JSON.stringify([{ name: "it's", cloneUrl: "https://github.com/a/b.git" }]),
  ...SECRETS,
};

function launch(overrides: Partial<Parameters<typeof launchScript>[0]> = {}) {
  return launchScript({
    sandboxId: "sbx_1",
    image: "ghcr.io/acme/sandbox:1",
    envNames: Object.keys(BOOT_ENV),
    labels: sandboxLabels(
      "sbx_1",
      "ws_1",
      { note: "it's quoted" },
      new Date("2026-11-05T11:00:00Z"),
    ),
    withLogin: false,
    ...overrides,
  });
}

describe("launch script", () => {
  it("never contains a secret value", () => {
    const script = launch({ withLogin: true });
    for (const value of Object.values(SECRETS)) expect(script).not.toContain(value);
  });

  it("pulls, then starts the container detached with the boot env copied in by name", async () => {
    const result = await sh(launch(), BOOT_ENV);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const [info, pull, runCall] = await calls();
    expect(info).toBe("info");
    expect(pull).toBe("pull --quiet ghcr.io/acme/sandbox:1");
    expect(runCall).toContain("run -d --name sling-sbx_1");
    expect(runCall).toContain("--label sling.sandbox=sbx_1");
    expect(runCall).toContain("--label sling.workspace=ws_1");
    expect(runCall).toContain("--label sling.expires-at=2026-11-05T11:00:00.000Z");
    expect(runCall).toContain("--label note=it's quoted");
    expect(runCall).toContain("--cap-drop ALL --security-opt no-new-privileges:true --restart no");
    expect(runCall).toMatch(/ ghcr\.io\/acme\/sandbox:1$/);
    expect(runCall).not.toContain("-p ");

    // The values reach the docker CLI through its environment, intact.
    const runEnv = await readFile(join(dir, "run-env"), "utf8");
    for (const [key, value] of Object.entries(BOOT_ENV))
      expect(runEnv).toContain(`${key}=${value}\n`);
  });

  it("logs in with the password on stdin, in a throwaway config", async () => {
    const result = await sh(launch({ withLogin: true }), {
      ...BOOT_ENV,
      SLING_REGISTRY_USERNAME: "bot",
      SLING_REGISTRY_PASSWORD: "reg-secret-pw",
    });
    expect(result.code).toBe(0);
    const all = await calls();
    expect(all[1]).toBe("login --username bot --password-stdin ghcr.io");
    expect(all.join("\n")).not.toContain("reg-secret-pw");
    expect(await readFile(join(dir, "login-stdin"), "utf8")).toBe("reg-secret-pw");
    // The registry login isn't copied into the container.
    expect(await readFile(join(dir, "run-env"), "utf8")).not.toContain("SLING_REGISTRY");
    // And the config holding the login is gone once the script exits.
    const config = await readFile(join(dir, "docker-config"), "utf8");
    await expect(readFile(join(config, "config.json"))).rejects.toThrow();
    expect((await sh(`test -d '${config}' && echo there || echo gone`)).stdout.trim()).toBe("gone");
  });

  it("appends a command override, quoted", async () => {
    await sh(launch({ command: ["sh", "-c", "env | grep SLING_; sleep 300"] }), BOOT_ENV);
    const runCall = (await calls())[2];
    expect(runCall).toMatch(/ghcr\.io\/acme\/sandbox:1 sh -c env \| grep SLING_; sleep 300$/);
  });

  it("exits with a known code when Docker is missing", async () => {
    await rm(join(dir, "docker"));
    // Only the stub's folder on PATH: CI runners have a real docker in /usr/bin.
    const result = await sh(launch(), { ...BOOT_ENV, PATH: dir });
    expect(result.code).toBe(EXIT_NO_DOCKER);
    expect(result.stderr).toContain("Docker isn't installed");
  });

  it("refuses a variable name that isn't one", () => {
    expect(() => launch({ envNames: ["A; rm -rf /"] })).toThrow(
      /isn't a valid environment variable/,
    );
  });
});

describe("keepalive script", () => {
  it("waits on the container for its lifetime, then removes it", async () => {
    await writeFile(
      join(dir, "timeout"),
      `#!/bin/sh\necho "timeout $*" >> "$STUB_DIR/calls"\nshift\nexec "$@"\n`,
    );
    await chmod(join(dir, "timeout"), 0o755);
    const script = keepaliveScript("sbx_1", 3660);
    expect(script).toBe(
      "timeout 3660 docker wait 'sling-sbx_1' >/dev/null 2>&1; docker rm -f 'sling-sbx_1' >/dev/null 2>&1",
    );
    expect((await sh(script)).code).toBe(0);
    expect(await calls()).toEqual([
      "timeout 3660 docker wait sling-sbx_1",
      "wait sling-sbx_1",
      "rm -f sling-sbx_1",
    ]);
  });
});

describe("check script", () => {
  it("prints the Docker version and architecture, and checks the image's manifest", async () => {
    const result = await sh(checkScript("alpine:3", false));
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^29\.1\.0\n(x86_64|arm64|aarch64)\n$/);
    expect((await calls()).slice(1)).toEqual([
      "version --format {{.Server.Version}}",
      "manifest inspect alpine:3",
    ]);
  });

  it("gives up when the daemon never comes up", { timeout: 90_000 }, async () => {
    await writeFile(join(dir, "down"), "");
    await writeFile(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "sleep"), 0o755);
    const result = await sh(checkScript("alpine:3", false));
    expect(result.code).toBe(EXIT_DOCKER_DOWN);
  });
});

describe("helpers", () => {
  it("quotes for the shell", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("names the container after the sandbox", () => {
    expect(containerName("sbx_1")).toBe("sling-sbx_1");
    expect(containerName("a b/c")).toBe("sling-a-b-c");
  });

  it("finds the registry to log in to", () => {
    expect(registryOf("alpine:3")).toBe("docker.io");
    expect(registryOf("acme/tool:1")).toBe("docker.io");
    expect(registryOf("ghcr.io/acme/sandbox:1")).toBe("ghcr.io");
    expect(registryOf("localhost:5000/x@sha256:00")).toBe("localhost:5000");
  });
});
