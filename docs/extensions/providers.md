# Writing a sandbox provider

A sandbox provider starts the environments coding tasks run in when no paired machine can take them, or when someone asks for a sandbox. The built-in providers run containers on Docker and sandboxes on Railway. An extension can add one for any platform with an API, such as the [Fly Machines extension](../../extensions/fly-machines). [sandboxes.md](../sandboxes.md) explains how Sling decides when to use one.

Start from the provider starter:

```sh
sling-ext init acme-cloud --kind provider
```

## The shape

A provider is a connector with an `executionProvider` and no nodes:

```ts
import { defineConnector, defineExtension, type ExecutionProvider } from "@sling/connector-sdk";

const provider: ExecutionProvider<Credentials, Config> = {
  async create(ctx, spec) { /* start spec.image with spec.env */ return { externalId: "..." }; },
  async destroy(ctx, externalId) { /* remove it; already gone is fine */ },
  async list(ctx) { /* everything you started that carries the sling.sandbox label */ return []; },
};

const connector = defineConnector({
  id: "acme-cloud",
  name: "Acme Cloud",
  description: "Runs coding tasks in Acme Cloud sandboxes.",
  credentialsSchema,
  secretFields: ["apiToken"],
  configSchema,
  test: async ({ credentials, config, signal }) => ({ ok: true }),
  nodes: [],
  executionProvider: provider,
});

export default defineExtension({ connectors: [connector] });
```

The manifest must grant `sandboxes: true`. Sling refuses to install a package whose connector provides sandboxes without it.

The installation's config should include the settings Sling reads from every provider, with these names:

| Key | Meaning |
|---|---|
| `image` | The image to run. Sling passes it in `spec.image`, falling back to the server's sandbox image |
| `controlPlaneUrl` | The URL sandboxes reach Sling at. Sling puts it in `SLING_URL`, falling back to `SLING_PUBLIC_URL` |
| `cpus`, `memoryMb` | Defaults for the sandbox's size |

## The calls

| Call | Deadline | Does |
|---|---|---|
| `create(ctx, spec)` | 5 min | Starts `spec.image` with `spec.env` as its environment and attaches `spec.labels`. Returns `{ externalId, detail }` as soon as the platform accepts it, not when the Runner connects |
| `destroy(ctx, externalId)` | 5 min | Removes the sandbox. A sandbox that's already gone counts as destroyed, so don't throw for it |
| `list(ctx)` | 1 min | Every sandbox this installation runs that carries the `sling.sandbox` label, as `{ externalId, sandboxId }` |

`ctx` holds the installation's `credentials` and `config`, `installationId`, `workspaceId`, `log`, and a `signal` to pass to `fetch`.

`spec` holds:

| Field | Meaning |
|---|---|
| `sandboxId` | Sling's ID for the sandbox |
| `workspaceId` | The workspace it's for |
| `image` | The image to run |
| `env` | The environment for the sandbox's Runner. It holds secrets: never log it |
| `labels` | `sling.sandbox` and `sling.workspace`. Attach them to whatever you create |
| `cpus`, `memoryMb` | The size, when set |
| `lifetimeSeconds` | The longest the sandbox may live |

Throw an `Error` whose message says what to fix, such as "Fly rejected the API token. Create one with fly tokens create deploy". Sling shows it on the sandbox and the task.

### The sweep

Every minute Sling calls `list` and destroys anything labeled as its own that it no longer tracks, for example a sandbox whose `create` call timed out after the platform had already started it. So `list` must find everything you start, and it must not return what you didn't start. Filter by the labels, not by name. The built-in Docker provider and the Fly example also filter by `sling.workspace`.

If the platform restricts label names, map them. Fly metadata keys are plain words, so the Fly example stores `sling.sandbox` as `sling_sandbox`.

### Lifetime

Sling destroys a sandbox when its task is done, when its Runner hasn't connected within 10 minutes, and when it passes its lifetime. If the platform has a hard limit on how long something runs, set it from `lifetimeSeconds` as a backstop. If it doesn't, store the deadline on the sandbox and remove sandboxes past it in `list`, as the Docker provider and the Fly example do with a 10-minute grace. The grace is there because Sling may count the lifetime from when the Runner connected, which can be up to 10 minutes after `create`.

The Runner in the sandbox also exits on its own after 15 minutes without a task. Platforms that remove a sandbox when its process exits, such as Fly with `auto_destroy`, clean up after that too.

## The sandbox boot contract

The provider starts the image, and the image's entrypoint, `sling-runner sandbox`, does the rest: it clones the repos, logs the agents in, pairs with Sling using the one-time code, runs one task, and exits when Sling revokes it. Everything it needs is in `spec.env`. Pass it through unchanged:

| Variable | Holds |
|---|---|
| `SLING_URL` | Sling's URL as the sandbox reaches it |
| `SLING_PAIR_CODE` | A one-time pairing code bound to this sandbox. It expires in 15 minutes |
| `SLING_SANDBOX_ID` | The sandbox's ID |
| `SLING_REPOS` | JSON: `[{ "name", "cloneUrl", "defaultBranch", "network" }]` |
| `SLING_HARNESSES` | The agents to set up, such as `codex,claude-code` |
| `SLING_MAX_MODE` | The highest permission mode, `full-access` in a sandbox |
| `SLING_IDLE_EXIT_SECONDS` | Exit after this long without a task. Default 900 |
| `OPENAI_API_KEY` | When stored and Codex runs the task |
| `ANTHROPIC_API_KEY` | When stored and Claude Code runs the task |
| `SLING_GIT_TOKEN` | When stored. The Runner uses it for git and `gh`, and never gives it to the agent |

The Runner dials out to Sling, so the sandbox needs no open ports. It needs outbound access to `SLING_URL` and to the git host. If the platform runs the image's entrypoint as process 1, give it an init process to reap what agents leave behind, as `docker run --init` does. Fly Machines run their own init, so the Fly example needs nothing extra.

[sandbox-image.md](../sandbox-image.md) has the whole image contract, the boot steps, and the Runner's exit codes. A provider that runs the default image needs nothing more than this page.

Before `create`, check that `SLING_URL` is something the sandbox can reach. A platform in the cloud can't reach `http://localhost:8080`. Railway and the Fly example refuse anything but `https://`, and the Fly example also accepts `http://` to Fly's private `.internal` and `.flycast` addresses, for a Sling running on Fly.

## Secrets

A provider receives every sandbox's secrets: the agent's API key, the GitHub token, and the pairing code, in `spec.env`. There's no way around that, since the provider starts the environment where they're used. It's why `sandboxes` is a permission, and why the install dialog says plainly that the extension receives each sandbox's API keys, GitHub token, and pairing code. Only grant it to providers whose publisher you'd trust with those.

When you write one:

- Never log `spec.env`, or a request body that contains it.
- Don't keep it. Pass it to the platform and drop it.
- Tell users where the platform stores it. On Fly, a Machine's environment is readable by anyone with access to its app, which is why the Fly example asks for an app that holds nothing else.

## Testing

Test against a fake of the platform's API. The Fly example's `test/fake-api.ts` is a small HTTP server that keeps Machines in memory and answers create, list with metadata filters and pages, and delete the way Fly does. Its config has an `apiUrl` field, named in the manifest's `configHosts`, so tests can point it at the fake. Its tests check the request body, that secrets never reach the log, the sweep's paging and expiry, and the errors for a bad token or a missing app.

Add a live test that skips without credentials. The Fly example's creates one Machine running busybox, which exits at once, then lists and destroys it:

```sh
FLY_API_TOKEN=... FLY_APP=... pnpm --filter @sling/extension-fly-machines test:live
```
