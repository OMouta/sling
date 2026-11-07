# Docker

The Docker connector runs coding tasks in fresh containers on a Docker host you control. Sling uses it when the machine with the repo is offline and you approve a sandbox, or when you ask for a fresh sandbox outright. Every task gets its own container, and Sling destroys it once the task's branch and pull request are delivered.

The container runs the sandbox image. Its entrypoint, `sling-runner sandbox`, clones the repo from its remote, pairs with Sling using a one-time code, and then works like any other Runner. It dials out to Sling, so the container publishes no ports.

## Build the image

The default image is `sling-sandbox:latest`. It isn't on a public registry yet, so build it on the Docker host from a Sling checkout:

```sh
docker build -f deploy/sandbox/Dockerfile -t sling-sandbox:latest .
```

For a remote Docker host, build it there, or push it to a registry that host can pull from and set **Image** to that name. A custom image works too, as long as it has `sling-runner`, `git`, and the coding agents on `PATH`, and starts `sling-runner sandbox`.

## Connect to Docker

### The local socket

The default host, `unix:///var/run/docker.sock`, is the Docker on Sling's own machine.

If Sling runs straight on the host, the user it runs as needs read and write access to the socket. On Linux that usually means adding it to the `docker` group.

If Sling runs in compose, start it with the sandbox override:

```sh
cd deploy
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
```

The override mounts the socket into the `sling` container and gives the container the socket's group. Sling runs as the `node` user, so on Linux set `DOCKER_GID` in `deploy/.env` to the group `stat -c %g /var/run/docker.sock` prints. Docker Desktop and OrbStack give the socket group 0, which is the default.

**Mounting the socket makes Sling root on that host.** Whoever can use the Docker socket can start a privileged container with the host's filesystem mounted, and that takes one API call. So if someone takes over the Sling server, they take over the machine it runs on. Sandboxes never get the socket. Only the Sling server has it. If that's more than you want to give Sling, use a separate Docker host over TLS instead.

### A remote host over TLS

Set the host to `tcp://<host>:2376` and paste the three PEM files from the daemon's TLS setup:

| Field | File |
|---|---|
| CA certificate | `ca.pem`, the CA that signed the daemon's certificate |
| Client certificate | `cert.pem` |
| Client key | `key.pem` |

The daemon should run with `--tlsverify`, so it refuses clients without a certificate it trusts. Docker's guide [Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/) shows how to make the certificates. The daemon's certificate has to name the host you put in the URL.

A `tcp://` host without certificates connects over plain HTTP. The form warns, because anyone on the network path could read sandbox secrets and drive the daemon. Use it only on a network nobody else is on, such as a socket proxy inside the same compose project.

## Let sandboxes reach Sling

**Sling's address for sandboxes** is the address a sandbox uses to reach Sling. Left empty, it's `SLING_PUBLIC_URL`. Which one works depends on where Sling runs:

| Sling runs | Network | Sling's address for sandboxes |
|---|---|---|
| In compose, with the override | `sling-sandboxes` | `http://sling:8080` |
| On the Docker host itself | `bridge` | `http://host.docker.internal:8080` |
| Somewhere else | `bridge` | Sling's public URL |

The override creates the `sling-sandboxes` network and attaches the `sling` service to it. Postgres isn't on that network, so a sandbox can't reach the database. Compose prefixes network names with the project name unless the network sets `name:`, which is why the override sets one.

The connector maps `host.docker.internal` to the host in every container, so the second row works on Linux too.

The network can't be `host` or `container:<name>`. Either one would put a sandbox on the host's or another container's network.

## Add it to Sling

Under **Connectors**, add Docker. The form checks the host as soon as it opens and says which Docker answered, or why it didn't, and whether the image is there. The default host, `unix:///var/run/docker.sock`, is the Docker on Sling's own machine; use `tcp://<host>:2376` for a remote daemon. Everything else is under **More settings**:

| Field | What to put |
|---|---|
| CA certificate, client certificate, client key | The PEM files, for a TLS host. Leave them empty for a socket |
| Registry username, registry password | Only if the image is in a private registry. They're sent with each pull |
| Image | `sling-sandbox:latest` unless you built or pushed another |
| Sling's address for sandboxes | See the table above |
| CPUs, memory per sandbox | Empty means no limit. Swap is off, so the memory limit is hard |
| Network | `bridge`, or `sling-sandboxes` with the compose override |
| Pull the image | **When missing** pulls only when the image isn't on the host. **Always** pulls before every sandbox, which picks up a new `latest`. **Never** uses what's there and fails without it |
| Extra environment | Variables every sandbox gets, such as `HTTPS_PROXY`. They show in plain text, so don't put secrets here. They can't replace the `SLING_*` or API key variables |

**Add** pings the daemon, checks that the network exists, and checks the image before saving. A missing image still passes, since it gets pulled when the first sandbox starts, unless pulling is set to **Never**.

Then store an API key for the coding agent and a GitHub token under **Settings**, **Sandboxes**, and turn on **Allow in sandboxes** for each repo a sandbox may clone.

## What each container gets

- The sandbox's environment: the pairing code, the repos to clone, the agent's API key, and the git token.
- No Linux capabilities, `no-new-privileges`, and at most 4096 processes. Git, Node, and the coding agents don't need more as a normal user.
- No published ports, no privileged mode, and no restart policy.
- The labels `sling.sandbox`, `sling.workspace`, and `sling.expires-at`, plus whatever Sling adds.

Sling finds its containers by those labels. Every minute it lists the workspace's containers and removes any it no longer tracks. A sandbox that outlives its lifetime, 60 minutes by default, gets destroyed and its task is marked interrupted. As a backstop for when Sling has lost track of one, a container more than 10 minutes past its `sling.expires-at` time is removed the next time Sling lists containers. The 10 minutes cover the time a sandbox may take to boot, since the label counts from when the container was created.

## When it doesn't work

- **"There's no Docker socket at /var/run/docker.sock."** Docker isn't running, the host is wrong, or Sling runs in a container without the socket. Start it with the compose override.
- **"Permission denied on the Docker socket."** Set `DOCKER_GID` to the socket's group, or add the user Sling runs as to the `docker` group.
- **"There's no Docker network called ..."** Check the name with `docker network ls`.
- **"Couldn't pull sling-sandbox:latest: pull access denied."** The default image isn't on any registry. Build it on the host as shown above.
- **"TLS with ... failed."** The CA certificate is wrong, or the daemon's certificate doesn't name the host in the URL.
- **The sandbox starts, but the task never does.** The container can't reach the control plane URL. `docker logs sling-<sandbox id>` shows what the Runner saw.
