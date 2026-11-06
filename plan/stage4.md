# Stage 4 build plan

Open ecosystem. This is spec section 15, Stage 4, with the choices in `decisions.md` applied (D58 to D69 are new for this stage).

## Status (2026-11-06)

W0 to W5 are built and on `main`. The contracts went in first: Node 26, the SDK at 1.0, the package format, views, tables, and the runtime interface. Four parallel workstreams followed (isolation, control plane, web, and the CLI with the examples and docs). Each was cherry-picked onto `main`, then integrated and checked against the real isolated runtime.

| "Done when" item | Verified by |
|---|---|
| 1. Isolation | `extensions/escape.test.ts`: real restricted processes try files, writes, processes, workers, the environment, sockets, UDP, DNS, `node:http`, `process.binding`, and eval. Every attempt is refused and logged, and the test process carries on |
| 2. Network | `extensions/broker.test.ts` (60 tests) against local HTTP, WebSocket, and TLS servers with a stub resolver: every case in the item, a resolver that changes its answer, caps, and WSS on a server that also speaks HTTP/2. Also live: the included ntfy package reached ntfy.sh through the broker over HTTPS and WSS |
| 3. Credentials | `extensions/process-runtime.test.ts`: another connector's installation, approvals without the permission, and a provider without `sandboxes` |
| 4. Crashes and hangs | `extensions/process-runtime.test.ts`: exit, uncaught throw, infinite loop, and running out of a 64 MB heap. The next call restarts the process, a second extension carries on, and five crashes leave it in error until it's turned off and on |
| 5. Write and ship your own | `extension-cli` `outside-repo.test.ts` runs every command in a folder outside the repo. In `stage4.e2e.test.ts`, the CLI makes, builds, signs, and catalogs an extension; Sling installs it after the trust step, and a workflow runs through its trigger and its action on real processes. Also in the browser, with a catalog made by the CLI |
| 6. Integrity | `extensions.e2e.test.ts`, on both the in-process and the real process runtime: every refusal in the item, including a package changed in the database and refused after a restart |
| 7. Updates | `extensions.e2e.test.ts`: the permission diff, no restart, and revocation. In the browser: 0.1.0 to 0.2.0, with the added host listed |
| 8. Included examples | `stage4.e2e.test.ts` against a local fake ntfy. Run once live with `SLING_LIVE_NTFY=1`, with the package exactly as it ships: a finished task sent a notification to ntfy.sh, and a message published to the watched topic started a workflow through the ntfy trigger |
| 9. A provider from an extension | `stage4.e2e.test.ts`: the Fly Machines example against a fake Machines API. Create got the sandbox environment, the sandbox's Runner paired and ran the task, the machine was destroyed, and the orphan sweep destroyed a stray machine through the extension |
| 10. Workflow packages | `extensions.e2e.test.ts`. In the browser: **Export as package** downloaded a package with a `$ntfy` binding, a requirement on `ntfy ^1.0.0`, and no installation IDs, and uploading it back showed **Unsigned** |
| 11. Disable and remove | `extensions.e2e.test.ts`. In the browser: the remove dialog lists the installation and workflow that use the extension |
| 12. Stable SDK | `connector-sdk` `api-report.test.ts`; the four built-in connectors import only the SDK; seven pages in `docs/extensions/` |
| 13. Extensions page | Playwright against a preview server on its own database: **Installed**, **Discover**, **Sources**, install, trust, update, details, remove, upload, Connectors, templates, and Export as package, at desktop and phone width in dark and light |

Test counts on `main`:
- **Unit:** 759 in TypeScript across 16 packages, and 156 in Rust.
- **End-to-end:** 124 across eight suites, including 29 extension tests and 8 integration tests on real processes. The 29 extension tests also pass on the real process runtime. Two Stage 2 email tests failed once while all eight suites ran in parallel, and passed alone.
- **Live:** the ntfy flow through Sling against ntfy.sh, once. The ntfy example's own live test, once. No real Codex or Claude Code turns.

| Budget | Measured |
|---|---|
| Extension process, spawn to first answer | 38 to 44 ms median |
| Node run through an extension, overhead over in-process, p95 | 0.09 to 0.10 ms |
| Brokered `fetch` overhead against a local server, p95 | 0.11 to 0.30 ms |
| Install from the included catalog (preview plus confirm) | preview of the included ntfy 61 ms; preview and install of the Fly provider 55 ms, on real processes |
| Server start with 10 extensions installed, extra time | 24.6 ms |
| Idle extension process memory | 58.3 MB in `node:26-slim` on Linux. **69.4 MB on macOS, over budget**: bare Node idles at 47 MB there, and zod and the SDK in the bundle add the rest |

Found and fixed during integration:
- **Start timer:** it was never cleared once an extension loaded, so every extension process was killed 10 seconds after it started, as "didn't load".
- **WSS through the broker:** the connector offered HTTP/2, so undici tried WebSocket over extended CONNECT, which ntfy.sh refuses. Sockets now get their own HTTP/1.1 agent.
- **Tests that relied on the in-process stand-in:** the control plane suite's chat extension called a loopback server without `localNetwork`, which the real broker rightly refused.
- **Layout:** the Installed, Discover, and Sources lists stopped short of the page's buttons; a README's first heading repeated the extension's name.
- **Image:** the extension runtime's manifest wasn't copied into the install step, and nested server tests stayed in the image.
- **Template views:** they now carry the extension's version and icon, so the template dialog makes no extra request.
- **Found by the workstreams themselves:**
  - node types with hyphens failed workflow validation, so no extension with a hyphenated ID could be used
  - the heartbeat killed healthy processes after the machine slept
  - zod's translated error messages doubled every bundle, 382 KB to 196 KB once dropped
  - a WebSocket message that arrived with the handshake was lost
  - Node 26 ignores a comma-separated `--allow-fs-read`, and the IPC channel can't refuse an oversized message before reading it; the plan's Isolation section now says what was built

Not done or not verified yet:
- **Fly Machines against a live account.** Need: `FLY_API_TOKEN`, an app, and the sandbox image on a registry Fly can pull from.
- **Idle memory on macOS** is over budget (see above). Linux meets it.
- **Linux and Windows end to end.** Isolation was exercised on macOS. On Linux, only the image (Node 26, `--allow-net` available, the catalog in place) and idle memory were checked. CI hasn't run, because the repo has no remote.
- **Your dev server** still runs on Node 24, so extensions show "needs Node 26" there until it restarts on Node 26.
- **An official signing key.** The included catalog is trusted because it ships with the server. Publishing a signed online catalog needs a project key and a release step.
- **Publishing the SDK and CLI to npm.**
- **Smaller gaps:**
  - Discover shows a kind icon for extensions not yet installed, because catalogs carry no icon.
  - There's no switch to turn a catalog off, though the API stores `enabled`.
  - Memory outside the V8 heap, and how many requests an extension makes at once, aren't limited.
  - Fetch bodies are buffered rather than streamed.
  - A server message over 1 MB closes the socket with a generic 1006.
  - During a version swap, old and new sockets together can briefly pass 16.
  - Revocations and crashes found in the background are audited in every workspace.
  - A crash loop's error status resets when the server restarts.

## Goal

Someone outside the project can write a connector, a sandbox provider, or a set of workflow templates, sign it, publish it as a static file, and have a Sling owner install it from the web app without editing Sling's code. The owner sees exactly what the extension may do before installing it, and the extension can't do more: it runs in its own process with no files, no environment, and no network except the hosts it declared.

## Done when

1. **Isolation.** A test extension that tries to read a file outside its package, write a file, start a process or a worker thread, read an environment variable, open a socket, or resolve a hostname is refused on every attempt, and the server keeps running. Each refusal shows in the extension's log.
2. **Network.** An extension's `fetch` and `WebSocket` reach only the hosts its manifest lists, plus the host in each installation's config fields that the manifest names. Each of these fails with a message that says why:
   - an undeclared host
   - plain HTTP to a public host
   - a redirect to an undeclared host
   - a declared name that resolves to a private address, without `localNetwork`
3. **Credentials.** An extension's node reads installations of its own connectors and nothing else. Asking for another connector's installation fails. Deciding approvals needs the `approvals` permission. Only an extension with the `sandboxes` permission can provide sandboxes, which means it sees each sandbox's secrets.
4. **Crashes and hangs.** An extension that crashes, or loops forever, fails the node that was running with "the extension stopped responding". Sling restarts the process on the next call, and its event source restarts with backoff. Other extensions and the server carry on.
5. **Write and ship your own.** Outside the repo:
   - `sling-ext init`, then `build` and `check`
   - `keygen`, then `pack --sign`
   - `catalog` writes a catalog for the folder, which you serve over HTTP
   
   In Sling, add the catalog under **Extensions → Sources**, then install the extension. The dialog shows its permissions, and the publisher's fingerprint to trust. The extension's connector then appears under **Connectors**, and its nodes in the editor. A workflow that uses its trigger and its action runs.
6. **Integrity.** Each of these is refused with a reason:
   - an unsigned package (allowed only when the server runs with `SLING_ALLOW_UNSIGNED_EXTENSIONS=1`, and then labeled **Unsigned**)
   - a package whose files don't match its signature
   - a download whose digest doesn't match the catalog
   - a signature by a key you haven't trusted, until you trust it
   - an update signed by a different key than the installed version
   - a package that needs a newer SDK than the server has
   - a package that adds names outside its own ID
   - a stored package changed in the database, refused when the server loads it
7. **Updates.** When a catalog lists a newer version, the extension shows **Update**. The dialog lists permissions added and removed. Approving it moves the extension to the new version without restarting Sling. A version the catalog revokes is disabled, with the catalog's reason.
8. **Included examples.** On a fresh server, **Extensions → Discover** lists ntfy, Fly Machines, and Task alerts from the catalog that ships with Sling. Install ntfy and Task alerts, add an ntfy installation, and install the **Notify when a task finishes** template. A finished task sends a push notification, and a message published to a watched topic starts a workflow through the ntfy trigger.
9. **A provider from an extension.** The Fly Machines example, pointed at a fake Machines API, starts a sandbox whose Runner pairs and runs a task. The orphan sweep and destroy go through the extension too.
10. **Workflow packages.** **Export as package** on any workflow downloads a package. Installation IDs in it are replaced by bindings, and it holds no credentials. Installed (signed, or unsigned in developer mode), it adds the template, which asks for its bindings when you install it.
11. **Disable and remove.** Disabling an extension stops its process and its event sources, and its nodes fail with "the extension is disabled". Removing one first lists the installations and workflows that use it, then removes its installations, templates, and node types.
12. **Stable SDK.** `@sling/connector-sdk` is 1.0.0. An API report in the repo fails the tests when its exports change. The built-in connectors import only the SDK. `docs/extensions/` covers connectors, providers, workflow packages, the manifest and permissions, signing and catalogs, and the CLI.
13. **Extensions page**, checked in a browser:
   - **Installed**, with status, publisher, and **Update**
   - **Discover**, with search and a filter by kind
   - **Sources**, with catalogs and trusted publishers
   - the install, trust, update, and remove dialogs

## Out of scope

- A hosted marketplace or registry. A catalog is a static file anyone can host.
- Raw TCP, UDP, and DNS for extensions, so connectors like IMAP stay built in. Inbound webhooks for extensions: workflows already have the webhook trigger.
- Extensions on the Runner, coding-agent adapters, model providers, and web UI code. Extension forms come from their schemas.
- Automatic updates.
- Sigstore, key expiry, and revocation lists beyond what a catalog revokes.
- Installing an extension for one workspace only, and roles.
- Publishing the SDK and CLI to npm. The packages are ready for it, but there's no registry account or remote.
- Moving the built-in connectors (Discord, email, Docker, Railway) into extension processes.

## Packages (D58, D65)

An extension is one `.slx` file, a gzipped tar:

```text
sling-extension.json     the manifest
extension.mjs            one ES module with every dependency bundled in (absent in workflow packages)
templates/<key>/         template.json and workflow.json, the format workflows/ already uses
README.md                shown in the details dialog
icon.svg | icon.png      optional
SIGNATURE.json           added by signing, left out of the digest
```

The manifest:

```json
{
  "format": "sling.extension/v1",
  "id": "ntfy",
  "name": "ntfy",
  "version": "1.0.0",
  "description": "Push notifications through ntfy.sh or your own ntfy server.",
  "publisher": "Sling",
  "sdk": "^1.0.0",
  "main": "extension.mjs",
  "templates": [],
  "permissions": {
    "network": { "hosts": ["ntfy.sh"], "configHosts": ["server"], "localNetwork": false },
    "approvals": false,
    "sandboxes": false
  },
  "requires": { "extensions": {}, "connectors": [] },
  "memoryMb": 256,
  "license": "Apache-2.0",
  "homepage": "https://ntfy.sh"
}
```

- **IDs** are 3 to 40 characters of lowercase letters, digits, and hyphens, starting with a letter.
- **Names.** Every connector ID the extension adds is its ID or starts with `<id>.`. Every node type and trigger event starts with `<id>.`. Template keys become `<id>/<key>` once installed.
- **Digest.** `sha256:` and the hex SHA-256 of one line per file, sorted by path: `<path>\0<hex sha256 of contents>\n`. `SIGNATURE.json` is left out. Tar metadata and compression don't change the digest.
- **Signature.**

  ```json
  { "format": "sling.signature/v1", "keyId": "3f2a91c07d4e22b1", "publicKey": "<base64, 32 bytes>", "publisher": "Sling", "signature": "<base64>" }
  ```

  It's an Ed25519 signature over `sling.extension/v1\n<id>\n<version>\n<digest>\n`. The key ID is the first 16 hex characters of the public key's SHA-256. Fingerprints show as four groups of four (`3f2a 91c0 7d4e 22b1`).
- **Limits:**
  - 20 MB compressed, 50 MB unpacked, 2,000 files, 200-character paths
  - regular files and directories only
  - no absolute paths and no `..`
- **Packing is deterministic:** sorted entries, mtime 0, owner 0, mode 0644 for files and 0755 for directories.

### Catalogs

```json
{
  "format": "sling.catalog/v1",
  "name": "Acme extensions",
  "publishers": [{ "keyId": "3f2a91c07d4e22b1", "name": "Acme", "publicKey": "<base64>" }],
  "extensions": [{
    "id": "acme-crm",
    "name": "Acme CRM",
    "description": "…",
    "publisher": "3f2a91c07d4e22b1",
    "kinds": ["connector"],
    "homepage": "https://…",
    "versions": [{
      "version": "1.1.0",
      "url": "acme-crm-1.1.0.slx",
      "digest": "sha256:…",
      "size": 48213,
      "sdk": "^1.0.0",
      "permissions": { "network": { "hosts": ["api.acme.test"] } },
      "publishedAt": "2026-11-01T00:00:00Z",
      "revoked": null
    }]
  }]
}
```

- **Download.** Package URLs resolve against the catalog's URL. A catalog is fetched over HTTPS only. The one exception is a loopback URL while the server runs with `SLING_ALLOW_UNSIGNED_EXTENSIONS`, for developing a catalog locally.
- **Caching.** Sling fetches each catalog when it's added, on **Refresh**, and every 6 hours, with its ETag. A catalog is capped at 2 MB.
- **Kinds** come from what the package adds: `connector`, `provider`, and `workflows`. **Discover** filters on them.
- **Revocation.** `revoked` is null or `{ "reason": "…" }`. Installed revoked versions are disabled with that reason.
- **Included catalog.** The catalog that ships with Sling lives at `SLING_INCLUDED_EXTENSIONS`, a directory with `catalog.json` and the packages. In the repo that's `extensions/dist`, built by `pnpm extensions:build`. In the Docker image it's `/app/extensions`.

## Trust (D60, D61)

- **Who's trusted.** A publisher is trusted per key, server-wide.
  - **Installing from a catalog.** When the signing key isn't trusted yet, the install dialog shows the publisher name and fingerprint, with **Trust and install**.
  - **Uploads** work the same way, using the key in the package's signature.
  - **Removing** a trusted key leaves installed extensions running, but no new installs or updates can use that key.
- **Pinning.** An installed extension is pinned to the key that signed it. An update signed by any other key is refused, even a trusted one. To move to a new key, remove the extension and install it again.
- **Included packages** are trusted because they ship with the server, like its own code. They're still checked against their digest, run isolated, and are limited to their permissions.
- **Unsigned packages** install only when the server runs with `SLING_ALLOW_UNSIGNED_EXTENSIONS=1`. The web app can't change that. They're labeled **Unsigned** on every card.
- **Preview, then confirm.** Every install and update has two steps:
  - **Preview** downloads or receives the package, verifies it, starts it once to read what it adds, and returns a preview: what it adds, its permissions, the publisher and trust state, any problems, and a staging ID. When it's an update, the preview adds the permission diff.
  - **Confirm** sends the staging ID, the digest, and the permissions the user saw. The server refuses if any of them changed. Staged packages expire after 15 minutes.
- **Updates are manual.** An **Update** button appears when an enabled catalog has a newer, unrevoked version with a compatible SDK. Nothing updates on its own.

## Isolation (D59, D63, D68)

Each enabled extension with code gets its own Node process, started like this:

```text
node --permission
     --allow-fs-read=<child runtime dir>
     --allow-fs-read=<unpacked package dir>
     --max-old-space-size=<memoryMb>
     --disallow-code-generation-from-strings
     <child runtime>/main.mjs
```

One `--allow-fs-read` per directory: Node 26 denied reads under the second path of a comma-separated list. Both paths go through `realpath` first, because macOS's `/var` symlink otherwise blocks the module loader.

- **What the process can't do.** With no other `--allow-*` flag it can't:
  - write files, or read any outside those two directories
  - open sockets or resolve names
  - start child processes or worker threads
  - load addons, FFI, or WASI, or open the inspector
- **Environment.** It's empty.
- **The channel.** The only way out is stdin and stdout, carrying length-prefixed V8 structured-clone frames. Not Node's `ipc` channel: it reads a whole message before the server sees it, so a child could send a buffer far larger than its heap cap and exhaust the server. With its own framing the server refuses anything over 16 MB from the 4-byte header. A pipe on fd 3 isn't possible, because `--permission` denies opening it.
- **Node version.** Node 24 can't deny network, so the server checks for `--allow-net` support before starting any extension process. Without it, extensions show "needs Node 26", and none of their code runs. The project moves to Node 26 LTS.
- **Unpacking.** On start, and on install or update, the server unpacks each enabled package from Postgres into a fresh directory under `SLING_EXTENSION_CACHE` (default `<tmpdir>/sling-extensions`). It checks the digest as it goes, and removes directories from earlier runs.

The **child runtime** (`packages/extension-runtime`) belongs to the server, not to the extension:
- imports the bundle
- answers calls from the server
- replaces `fetch` and `WebSocket` with versions that go through the server
- sends logs back

The extension's bundle only default-exports `defineExtension({ connectors })`. So the protocol can change without anyone rebuilding their extension.

**What the server enforces, per call:**

| Child asks for | Allowed when |
|---|---|
| `installation(id)` | The installation is in the run's workspace, and its connector belongs to this extension |
| `fetch`, `WebSocket` | The network rules below pass |
| `emit(event)` | The event type is one of this connector's trigger events |
| `state.get/set` | Always, for its own installation |
| `approvals.decide` | The extension was granted `approvals` |
| Being called as a provider | The extension was granted `sandboxes`. Checked when the server reads what the extension adds, so a provider without it is refused at install |

**Lifecycle:**
- **Start.** A process starts on the first call, so a server with ten extensions installed starts no processes until one is used. What each extension adds is stored at install, so registering its nodes at startup spawns nothing.
- **Idle stop.** It stops after 5 minutes with no calls in flight and no event source running.
- **Deadlines.** Every call has one:

  | Call | Deadline |
  |---|---|
  | `test` | 30 s |
  | node `run`, `resume` | 10 min |
  | trigger `match` | 1 s |
  | provider `create`, `destroy` | 5 min |
  | provider `list` | 1 min |
  | `source.start` | 30 s |

- **Heartbeat.** Every 5 seconds. A process that misses 10 seconds of heartbeats is killed. In-flight calls fail with "the extension stopped responding", and sources report an error, so the connector runtime restarts them with its usual backoff.
- **Crash loops.** After 5 crashes in 10 minutes the extension goes to **error** and stays stopped until you turn it off and on again.
- **Limits.** Each message is capped at 16 MB.
- **Logs.** Each process's stderr and the logs it sends go to the server log, tagged with the extension, plus a ring buffer of the last 200 lines. The details dialog shows the buffer.

## Network (D62)

The child has no network of its own. The child runtime's `fetch` and `WebSocket` send each request to the server, which checks it:

1. **The host must be allowed**, by one of:
   - the manifest's `network.hosts`, exact or `*.example.com` (which covers `example.com` too)
   - the hostname of a URL in a config field the manifest lists in `network.configHosts`, from any installation of this extension's connectors
2. **The scheme:** `https:` and `wss:`. `http:` and `ws:` work only with `localNetwork`, and only when the name resolves to a private address.
3. **The address.** The server resolves the name itself and checks every address. Without `localNetwork`, it refuses loopback, private, link-local, CGNAT, and unique-local addresses. It connects to the address it checked, so a DNS answer that changes in between can't slip through.
4. **Redirects** are followed by the server, up to 5 hops, and each hop is checked again.
5. **Limits.** Request and response bodies are capped at 10 MB, and a request times out after 60 seconds unless the extension passes a shorter signal. WebSocket messages are capped at 1 MB, and an extension can hold 16 sockets at once.

A refusal reaches the extension as a `TypeError` from `fetch`, or an error event on the socket, with the reason in the message. The server logs it too.

## Credentials and secrets

- **Credentials** go to the child only for the installation a call is about: the installation of a test, a source, or a provider call, or one a node asks for that passes the check above. The child never sees the encrypted store, the database, or other connectors.
- **Sandbox secrets** go to a provider in the `SandboxSpec`, as they do for Docker and Railway today. The provider starts the environment where those secrets are used, so it can't be kept from them. That's why `sandboxes` is a permission, and why the install dialog says plainly that the extension receives each sandbox's API keys, GitHub token, and pairing code.
- **Scrubbing.** Credential values are scrubbed from stored node inputs and outputs, as they are for built-in connectors.

## SDK (D66)

`@sling/connector-sdk` becomes 1.0.0:

- **Definitions.** `defineExtension({ connectors })` returns the extension definition with a `describe()` function. `describe()` turns every schema into JSON Schema with the extension's own copy of zod.
- **Connectors.** `defineConnector`, `ConnectorDefinition`, `TestResult`, event sources and their contexts, `ApprovalDecision`.
- **Nodes.** `defineNode`, `NodeSpec`, `NodeContext` (without `services`), `NodeError`, port and exec port types, `TriggerSpec`, `WaitSpec`, and the named port types.
- **Providers.** `ExecutionProvider`, `SandboxSpec`, `ProviderContext`, `ProviderConfigBase`, `SANDBOX_LABELS`, and the sandbox boot contract, documented.
- **Formats.** Manifest, permissions, catalog, and signature schemas, plus `SDK_VERSION`.

Rules:
- **Version check.** The manifest's `sdk` range must include the server's `SDK_VERSION`. Ranges are `^x.y.z`, `~x.y.z`, `>=x.y.z`, or an exact version.
- **API report.** `packages/connector-sdk/api-report.d.ts` is the declaration output of the package's public entry. A test regenerates it and fails on any difference. Changing the SDK means updating the report in the same commit and bumping the version to match.
- **Built-in connectors.** Discord, email, Docker, and Railway import only `@sling/connector-sdk` (and their own dependencies). They keep running in the server process.

## CLI

`packages/extension-cli`, run as `sling-ext` (in the repo, `pnpm sling-ext …`):

| Command | Does |
|---|---|
| `init <dir> [--kind connector\|provider\|workflows]` | A working starter: manifest, `src/index.ts`, a test, README |
| `build` | Bundles `src/index.ts` into `extension.mjs` with esbuild (ESM, Node 26, all dependencies inline) |
| `check` | Runs the bundle under the same restrictions Sling uses, prints what it adds, and checks names, schemas, and permissions |
| `keygen [--out key.json]` | A new Ed25519 key, and its fingerprint |
| `pack [--sign key.json]` | The `.slx`, deterministic, signed if a key is given |
| `sign <file.slx> --key key.json` | Adds or replaces `SIGNATURE.json` |
| `verify <file.slx>` | Digest, signature, fingerprint, and manifest |
| `catalog <dir> [--name …]` | Writes `catalog.json` for the `.slx` files in a folder, with relative URLs |

## Workflow packages (D67)

- **Shape.** A workflow package is an extension with templates and no `main`. It runs no code, so it gets no process and its permissions are always empty.
- **Requirements.** `requires.extensions` (ID to version range) and `requires.connectors` (built-in connector IDs) are checked at install. The preview lists anything missing, and each missing extension found in an enabled catalog gets an **Install** button.
- **In the template dialog**, a package's templates show the package's name. Installing one works like a bundled template: it asks for bindings, and the workflow lands published and off.
- **Export as package** (in the workflow editor's menu) builds an unsigned package from the active version, or from the draft if nothing is published:
  - Every config value that is an installation ID becomes a binding (`$discord`, `$discord_2`, …), labeled with the connector's name.
  - Credentials can't be included, because workflows hold only installation IDs.
  - The manifest's `requires` lists the extensions and built-in connectors the workflow's nodes come from.
  - The ID and version come from the dialog, which suggests both from the workflow's name.

## Data model additions

| Change | Holds |
|---|---|
| `extensions` (new) | ID, name, description, installed version, source (`included`, `catalog`, `upload`), catalog ID, publisher key ID and name (null when unsigned or included), signed (bool), enabled, status and detail, granted permissions, installed by, timestamps |
| `extension_packages` (new) | Extension ID and version, digest, size, archive (`bytea`), manifest, what it adds, signature. The installed version and the one before it |
| `extension_publishers` (new) | Key ID, name, public key, trusted by, trusted at |
| `extension_catalogs` (new) | ID, URL (unique), name, enabled, fetched at, ETag, error, cached document, added by |
| `audit_events` | New verbs: `extension.installed`, `extension.updated`, `extension.enabled`, `extension.disabled`, `extension.removed`, `extension.revoked`, `extension.crashed`, `publisher.trusted`, `publisher.removed`, `catalog.added`, `catalog.removed` |

The extension tables have no workspace column (D64). Their audit entries go to the workspace of the person acting.

## API

```text
GET    /api/extensions                         installed, with status, update available, and what uses each
GET    /api/extensions/discover                every entry from enabled catalogs and the included catalog, with install state (?q=&kind=)
GET    /api/extensions/:id                     details: manifest, README, permissions, versions, log tail
GET    /api/extensions/:id/icon                image/svg+xml or image/png, served with a sandboxing CSP
POST   /api/extensions/preview                 { catalogId, extensionId, version } or a raw .slx body → ExtensionPreview
POST   /api/extensions/install                 { stagingId, digest, permissions, trustPublisher }
POST   /api/extensions/:id/update/preview      { version } → ExtensionPreview with the permission diff
PATCH  /api/extensions/:id                     { enabled }
DELETE /api/extensions/:id
GET    /api/extension-catalogs
POST   /api/extension-catalogs                 { url }
POST   /api/extension-catalogs/:id/refresh
DELETE /api/extension-catalogs/:id
GET    /api/extension-publishers
DELETE /api/extension-publishers/:keyId
POST   /api/workflows/:id/export-package       { id, version, name } → .slx download
```

- **Who.** Only the workspace owner can install, update, enable, disable, or remove an extension, or change publishers and catalogs. Today that's the only account.
- **Realtime.** New event `extension.updated`. Connector and template lists refetch on it.

## Workstreams

The contracts land on `main` first. Four workstreams then run in parallel, each in its own worktree, and integration comes last.

### W0. Contracts (on main, first)

- **Node 26:** `.node-version`, `engines`, the Dockerfile, CI, and a full test run on Node 26.
- **`@sling/connector-sdk` 1.0:**
  - `defineExtension` and `describe()`, and the description types
  - manifest, permissions, catalog, and signature schemas
  - `SDK_VERSION`, the naming rule, and the range check
- **`@sling/extension-package`, implemented:**
  - tar read and write, gzip
  - digest, sign, and verify
  - reading with limits, and deterministic packing
  - unit tests
- **`@sling/core`:** `ExtensionView`, `DiscoverEntryView`, `ExtensionPreview`, `PermissionLine`, `PublisherView`, `CatalogView`, and the realtime event.
- **`packages/db`:** the tables above, as migration `0006_extensions`.
- **Server:**
  - the `ExtensionRuntime` interface in `apps/server/src/extensions/runtime.ts`
  - empty `extensions` slots on `AppContext`
  - `esbuild` for tests
  - `test/fixtures/extensions.ts`, which builds and packs a fixture extension

### W1. Isolation: the child runtime, the host, and the network broker

- **`packages/extension-runtime`:** the child side.
- **`apps/server/src/extensions/`:**
  - `process-runtime.ts` (implements `ExtensionRuntime`)
  - `host.ts`: spawn, RPC, deadlines, heartbeat, restarts, idle stop
  - `broker.ts`: network rules, DNS checks, redirects, limits, WebSocket relay
  - `proxy.ts`: connectors, nodes, triggers, sources, and providers as server-side objects
- **Tests:**
  - an escape suite covering every Done-when item 1 attempt
  - broker tests for each item 2 case, against local servers with a stub resolver
  - credential and approval checks
  - crash, hang, and deadline tests
  - measured cold start and call overhead

### W2. Control plane

- **`apps/server/src/extensions/`:**
  - `service.ts`: preview, install, update, enable, disable, remove, load on start, unpacking, revocation
  - `catalogs.ts`: fetch, cache, refresh, the included catalog
  - `trust.ts`: publishers and pinning
  - `export.ts`: export a workflow as a package
  - `routes.ts`
- **Changes elsewhere in the server:**
  - `NodeRegistry.unregisterConnector`
  - the workflow service reads templates from packages
  - `EventBus` awaits trigger `match`
  - installation changes refresh config hosts
  - views, audit, and realtime
- **Test runtime.** Tests use an in-process test runtime (`test/fixtures/in-process-runtime.ts`) until W1 merges.
- **Tests:**
  - unit tests for trust, pinning, the diff, and requirements
  - end-to-end tests against a local catalog server: install, refusals, update, revoke, disable, remove, export, and a workflow package

### W3. Web

- **Extensions page**, a new sidebar item after Connectors:
  - **Installed**
  - **Discover**, with search and kind chips
  - **Sources**: catalogs, with add, refresh, and remove; trusted publishers, with remove
- **Dialogs:** details, which renders the README as Markdown and shows the log tail; install, with the permission list and a trust step; update, with the permission diff; remove, listing what uses the extension; and upload, through a file picker.
- **Elsewhere:**
  - Connectors cards and the template dialog show which extension a connector or template came from, with its icon
  - **Export as package** in the workflow editor
- **Tests.** DOM tests with fixtures. Screenshots come in integration.

### W4. SDK docs, CLI, and examples

- **CLI.** `packages/extension-cli` with every command above, and tests that run init, build, check, pack, sign, verify, and catalog in a temp directory.
- **Examples:**
  - `extensions/ntfy`: a connector with a publish action, a message trigger over WebSocket, and a connection test
  - `extensions/fly-machines`: an execution provider on the Fly Machines API
  - `extensions/task-alerts`: a workflow package with the **Notify when a task finishes** template
  - unit tests for each against fakes
- **`pnpm extensions:build`.** Builds the included catalog into `extensions/dist`. The Dockerfile runs it.
- **API report.** The SDK's API report and its test.
- **Docs.** `docs/extensions/`: overview, connectors, providers, workflow packages, manifest and permissions, signing and catalogs, CLI.

### W5. Integration (after merge)

- **Wiring.** The real runtime replaces the test runtime, and `main.ts` and the Dockerfile wire everything.
- **Done when.** Run the whole list end to end, and the live ntfy check.
- **Browser.** Check every new screen with Playwright against a preview server.
- **Budgets.** Measure them.
- **Docs.** README, the threat model, and plan status.

## Testing

- **Unit:**
  - the package format: digest stability, tamper detection, limits, traversal, and symlinks
  - signatures, ranges, names, and the permission diff
  - the broker's host matching and address classes
- **Isolation, with real child processes:**
  - the escape suite
  - credential scoping
  - approvals and providers without permission
  - crash, hang, and memory limit
  - idle stop and restart
- **End to end, Postgres plus server, with a local HTTP catalog:**
  - catalog to trust, to install, to an installation, to a workflow run through the extension's trigger and action
  - the integrity refusals
  - update with a diff, revoke, disable, and remove
  - export and reinstall a workflow package
- **Providers.** The Fly Machines example against a fake Machines API, through to a paired sandbox Runner running `fake-codex`.
- **Live checks.**
  - **ntfy:** publish to a random topic on ntfy.sh and receive it through the trigger. ntfy.sh needs no account.
  - **Fly:** skipped without `FLY_API_TOKEN`.

## Budgets

| Measure | Budget |
|---|---|
| Extension process, spawn to first answer | under 150 ms |
| Node run through an extension, overhead over in-process, p95 | under 2 ms |
| Brokered `fetch` overhead against a local server, p95 | under 3 ms |
| Install from the included catalog (preview plus confirm) | under 1.5 s |
| Server start with 10 extensions installed, extra time | under 100 ms |
| Idle extension process memory | under 60 MB RSS |
