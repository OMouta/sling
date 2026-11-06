# Fly Machines

Runs Sling's coding tasks in sandboxes on [Fly Machines](https://fly.io/docs/machines/), in a Fly app of your own. Sling uses a sandbox when no paired machine can take a task, or when you ask for one. Each sandbox is a fresh Machine that runs the sandbox image, pairs its Runner with Sling, runs one task, and is destroyed.

## What this extension can see

Installing it grants the **sandboxes** permission. A sandbox provider starts the environment the task runs in, so it receives everything that environment needs: the OpenAI or Anthropic API key, the GitHub token, and the sandbox's one-time pairing code. They're passed to Fly as the Machine's environment, so anyone with access to the Fly app can read them while the Machine exists. Use an app that holds nothing else, and a token scoped to it.

## Set up Fly

1. Create an empty app: `fly apps create sling-sandboxes`.
2. Push the sandbox image where Fly can pull it. From the Sling repo:

   ```sh
   docker build -f deploy/sandbox/Dockerfile -t registry.fly.io/sling-sandboxes:sandbox .
   fly auth docker
   docker push registry.fly.io/sling-sandboxes:sandbox
   ```

3. Create a token for that app: `fly tokens create deploy --app sling-sandboxes`. Copy all of it, including `FlyV1`.

## Add it to Sling

Under **Connectors**, add Fly Machines:

| Field | What to put |
|---|---|
| API token | The token from step 3 |
| App | `sling-sandboxes` |
| Region | Optional, such as `iad` or `fra`. Empty lets Fly pick |
| Image | `registry.fly.io/sling-sandboxes:sandbox` |
| Control plane URL | Sling's public HTTPS URL. Empty uses `SLING_PUBLIC_URL`. If Sling runs on Fly in the same organization, its `.internal` or `.flycast` address works too |
| CPU kind | `shared` (the default) or `performance` |
| CPUs, Memory in MB | Optional. Defaults to the workspace's sandbox settings, or 2 CPUs and 4096 MB |
| Machines API URL | Leave it as `https://api.machines.dev`. Tests point it at a fake |

**Test** checks that Fly accepts the token and the app exists.

## How it works

| Sling asks | The extension calls |
|---|---|
| Create a sandbox | `POST /v1/apps/<app>/machines` with the image, the sandbox's environment, the guest size, `auto_destroy: true`, restart policy `no`, and metadata `sling_sandbox`, `sling_workspace`, and `sling_expires_at` |
| List sandboxes | `GET /v1/apps/<app>/machines?metadata.sling_workspace=<workspace>`, following Fly's page cursor |
| Destroy one | `DELETE /v1/apps/<app>/machines/<id>?force=true`. A Machine that's already gone counts as destroyed |

Fly metadata keys are plain words, so the labels `sling.sandbox` and `sling.workspace` are stored as `sling_sandbox` and `sling_workspace`.

CPUs round up to what Fly offers (1, 2, 4, 8, and 16 for performance), and memory rounds up to a multiple of 256 MB.

Fly runs its own init as process 1, so processes the agents leave behind are reaped. The Machine is removed when its Runner exits, after its task or after 15 minutes idle. Fly has no hard lifetime for a Machine, so each one carries its deadline in `sling_expires_at`, and the extension destroys any Machine still running 10 minutes past it when Sling lists sandboxes, which it does every minute.

## Permissions

| Permission | Why |
|---|---|
| Connect to api.machines.dev | The Fly Machines API |
| Connect to the host in each installation's "apiUrl" setting | Only differs from the above in tests |
| Start sandboxes, and receive each sandbox's secrets | It's a sandbox provider |

## Develop

```sh
pnpm --filter @sling/extension-fly-machines test     # against a fake Machines API on a local port
FLY_API_TOKEN=... FLY_APP=... pnpm --filter @sling/extension-fly-machines test:live
```

The live test creates one Machine running busybox, which exits at once, then lists and destroys it. `test/fake-api.ts` is the fake Machines API, for tests elsewhere that need one.
