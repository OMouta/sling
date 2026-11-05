# Railway

The Railway connector runs coding tasks in Railway Sandboxes on your own Railway account. A Railway sandbox is a small VM with Docker in it, and Sling runs the same sandbox image there that the [Docker connector](docker.md) runs locally. The task clones, works, pushes, and opens its pull request the same way in both.

Railway's TypeScript SDK marks its sandbox API as beta and says breaking changes will come. Sling pins the SDK to version 3.16.0 and moves to a new one only after testing it. Expect this connector to need updates more often than the others.

## What you need

- **A Railway account.** Sandboxes work on every plan. Trial and Free cap them at 2 vCPUs, 2 GB, and a 5-minute idle timeout.
- **A public HTTPS URL for Sling.** Sandboxes run on Railway's network and connect back to Sling over the internet. [remote-access.md](../remote-access.md) covers Cloudflare Tunnel and a reverse proxy. Tailscale alone won't do, because a Railway sandbox isn't on your tailnet. If Cloudflare Access protects Sling, the bypass for `/runner/v1/ws` and `/api/runner/pair` that Runners need covers sandboxes too.
- **The sandbox image on a registry.** Each sandbox pulls the image itself and can't see images on your machines.
- **Outbound access from Sling's server** to `backboard.railway.com` on port 443, and to `ssh.railway.com` on port 2226. The SDK runs commands in sandboxes over a WebSocket on that second port, so a firewall that only allows 443 breaks it.

## Set up Railway

1. Create a project for Sling, for example `sling-sandboxes`, and keep nothing else in it. Every minute Sling lists all the sandboxes in the environment to find ones it lost track of, and a dedicated environment keeps your other sandboxes out of that.
2. Open the project, press Cmd+K or Ctrl+K, and copy the environment ID.
3. Create a token under **Account Settings**, **Tokens**. Railway's sandbox docs use an account or workspace token. A project token, from the project's **Tokens** settings page, reaches only that one environment, so it's the tighter choice. Set **Token type** to `project` if you use one. Sling hasn't been tested against a live account with either kind yet.

## Make the image pullable

Push the sandbox image to a registry, for example GitHub's:

```sh
docker build -f deploy/sandbox/Dockerfile -t ghcr.io/you/sling-sandbox:latest .
docker push ghcr.io/you/sling-sandbox:latest
```

Railway's docs don't say which CPU architecture sandboxes use. A multi-arch build runs on either:

```sh
docker buildx build --platform linux/amd64,linux/arm64 -f deploy/sandbox/Dockerfile \
  -t ghcr.io/you/sling-sandbox:latest --push .
```

Turn on **Check in a test sandbox** and run **Test** to see the architecture a sandbox reports.

A public image needs nothing else. For a private one, set **Registry username** and **Registry password**. Use a token that can only read packages. On GitHub that's a classic token with just `read:packages`. Sling logs in for the pull alone, in a Docker config it deletes straight after, and passes the password to `docker login` on stdin.

## Add it to Sling

Under **Connectors**, add Railway:

| Field | What to put |
|---|---|
| API token | The token from step 3 |
| Token type | `account` for an account or workspace token, `project` for a project token |
| Environment ID | From step 2 |
| Registry username, registry password | Only for a private image |
| Image | The image you pushed, such as `ghcr.io/you/sling-sandbox:latest` |
| Control plane URL | Sling's public HTTPS URL, usually the same as `SLING_PUBLIC_URL`. `http://` is refused |
| CPUs, memory in MB | Size of each sandbox. Empty uses your workspace's sandbox default. Sling converts MB to Railway's GB, so 4096 asks for 4 GB |
| Idle timeout in minutes | How long Railway keeps a sandbox after its container stops, before destroying it. 5 by default, which every plan allows |
| Check in a test sandbox | Off by default. See below |

**Test** lists the environment's sandboxes. That's the cheapest call that needs both a valid token and access to the environment. With **Check in a test sandbox** on, it also starts a sandbox with 1 vCPU and 1 GB, waits for Docker, checks that Docker can find the image on its registry, reports the CPU architecture, and destroys the sandbox. That takes a minute or two, and Railway bills for it.

Then store an API key for the coding agent and a GitHub token under **Settings**, **Sandboxes**, and turn on **Allow in sandboxes** for each repo a sandbox may clone.

## How a sandbox runs

1. Sling creates a Railway sandbox with your size and idle timeout. It isn't on the environment's private network and publishes no domains.
2. It writes `/tmp/sling/sandbox.json` with Sling's sandbox and workspace IDs. Railway sandboxes have no names or labels, so this file is how Sling recognizes its own sandboxes later.
3. It runs one command that waits for Docker, pulls the image, and starts it in the background as `sling-<sandbox id>`.
4. It starts a second command, `docker wait` on that container, and disconnects while it keeps running.

The pairing code, the agent's API key, and the git token travel as environment variables on the request that runs step 3, and `docker run -e NAME` copies each one into the container by name. No command line carries a secret value. That matters because Railway records each command's text in the sandbox's session list.

Railway destroys a sandbox that sits idle for its idle timeout. A container running in the background doesn't count as activity. A running command does, so step 4 keeps the sandbox alive for as long as the container runs, however long the task takes. When the container stops, the sandbox goes idle, and Railway destroys it once the idle timeout passes.

Sling destroys the sandbox itself when the task delivers its pull request, or when the task's lifetime runs out. If Sling is down when the lifetime ends, `docker wait` gives up a minute later and removes the container. Railway then destroys the idle sandbox, with no help from Sling.

To find sandboxes it lost track of, Sling reads the marker file once in each running sandbox it doesn't already know, and remembers what it found. A sandbox without the file is left alone. If Sling crashed before writing the file, nothing runs in that sandbox, so Railway idles it out.

Railway documents Docker in every sandbox, so Sling uses it to keep the sandbox's startup identical to the Docker connector's. If Docker is missing or never starts, creating the sandbox fails with a message saying so. There's no fallback that runs `sling-runner` on the VM directly.

## Limits and billing

From Railway's sandbox docs, November 2026:

| | Trial and Free | Hobby | Pro |
|---|---|---|---|
| Idle timeout | 1 to 5 minutes | 1 to 120 minutes | 1 to 120 minutes |
| Sandboxes at once, per environment | 10 | 50 | 100 |
| Default size | 2 vCPUs, 2 GB | 4 vCPUs, 4 GB | 8 vCPUs, 8 GB |
| Largest size | 2 vCPUs, 2 GB | 8 vCPUs, 8 GB | 32 vCPUs, 32 GB |

Railway sets no maximum lifetime apart from the idle timeout. Sling's own limits under **Settings**, **Sandboxes** apply on top: concurrent sandboxes, lifetime, and minutes per month.

Railway bills a sandbox per second for memory, CPU, and outbound traffic, from creation until it's destroyed, out of the same included usage as your services. The rates are on [Railway's sandbox page](https://docs.railway.com/sandboxes). The idle timeout after a container stops is billed too, which is one reason to keep it short.

## When it doesn't work

- **"Railway rejected the API token."** The token was revoked or pasted wrong, or **Token type** doesn't match the kind of token.
- **"Railway has no environment ... that this token can reach."** The environment ID is wrong, or a project token belongs to a different environment.
- **"... must be an https:// URL."** Set **Control plane URL** to Sling's public HTTPS address.
- **"Starting the sandbox image failed (exit 1): ... pull access denied."** The image is private and the registry login is missing or wrong, or the name has a typo.
- **"Couldn't connect to the sandbox to run a command."** Sling's server can't reach `ssh.railway.com` on port 2226.
- **"Docker didn't start in the Railway sandbox within a minute."** Check Railway's status page, then try again.
- **The sandbox starts, but the task never does.** The container can't reach the control plane URL, or the image doesn't run on the sandbox's architecture. Read the Runner's output with the Railway CLI: `railway sandbox exec --id <railway sandbox id> -- docker logs sling-<sandbox id>`.
