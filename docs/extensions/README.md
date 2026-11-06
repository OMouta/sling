# Extensions

An extension adds to Sling without changing Sling's code. It can add:

- **Connectors**, with workflow nodes, triggers, and event sources, like the built-in Discord and email connectors
- **Sandbox providers**, which start the sandboxes coding tasks run in, like the built-in Docker and Railway providers
- **Workflow templates**, which show up under **New from template**

An extension is one file, a `.slx` package. You install it from a catalog, or upload it, under **Extensions** in the web app. Sling ships with three, in its included catalog:

| Extension | Kind | What it does |
|---|---|---|
| [ntfy](../../extensions/ntfy) | connector | Publish push notifications, and start workflows from messages on ntfy topics |
| [Fly Machines](../../extensions/fly-machines) | provider | Run sandboxes as Fly Machines in your own Fly app |
| [Task alerts](../../extensions/task-alerts) | workflows | A template that sends an ntfy notification when a coding task finishes |

Writing one:

- [connectors.md](connectors.md): nodes, triggers, event sources, credentials, `fetch` and `WebSocket`
- [providers.md](providers.md): sandbox providers and the sandbox boot contract
- [workflow-packages.md](workflow-packages.md): templates, bindings, and requirements, and **Export as package**
- [manifest.md](manifest.md): every field of `sling-extension.json`, and the permissions
- [signing.md](signing.md): keys, trust, catalogs, and revocation
- [cli.md](cli.md): every `sling-ext` command

## What an extension can and can't do

Each extension with code runs in its own Node process, apart from the server. Sling starts it with Node's permission model on, an empty environment, and code generation from strings turned off. The process can read its own unpacked package and nothing else. It can't:

- read files outside its package, or write any file
- open sockets or resolve hostnames
- start processes or worker threads
- load native addons, FFI, or WASI, or open the inspector
- read Sling's environment, database, or encrypted credentials

Its only way out is its IPC channel to the server, and the server checks every request that comes through it:

| The extension asks for | Sling allows it when |
|---|---|
| An installation's credentials and config | The installation is in the run's workspace, and its connector belongs to this extension |
| `fetch` or a `WebSocket` | The host is one the manifest declares, and the request passes the network rules in [manifest.md](manifest.md#network) |
| Emitting an event | The event type is one of this connector's trigger events |
| Its own state store | Always, for its own installation |
| Deciding an approval | The extension was granted the `approvals` permission |
| Providing sandboxes | The extension was granted the `sandboxes` permission |

So an extension gets credentials only for the installation a call is about, reaches only the hosts it declared, and adds only names that start with its own ID. Raw TCP, UDP, and DNS aren't available, so connectors that need them, such as IMAP, stay built in. Extensions don't receive webhooks either. Use the workflow **Webhook** trigger for that.

A provider is the one exception to "only its own credentials". It starts the environment a task runs in, so it receives that sandbox's secrets: the agent's API key, the GitHub token, and the pairing code. That's what the `sandboxes` permission grants, and the install dialog says so. See [providers.md](providers.md#secrets).

### Processes

A process starts on the first call to it, so ten installed extensions cost nothing until one is used. Sling stores what each extension adds when you install it, so its nodes appear in the editor without starting anything. A process stops after 5 minutes with no calls in flight and no event source running.

Every call has a deadline:

| Call | Deadline |
|---|---|
| Connection test | 30 s |
| Node `run` and `resume` | 10 min |
| Trigger `match` | 1 s |
| Provider `create` and `destroy` | 5 min |
| Provider `list` | 1 min |
| Event source `start` | 30 s |

The process sends a heartbeat every 5 seconds. One that misses 10 seconds of them is killed, and calls in flight fail with "the extension stopped responding". The next call starts it again, and its event sources restart with backoff. After 5 crashes in 10 minutes the extension goes to **error** and stays stopped until you turn it off and on.

Each message between the process and the server is capped at 16 MB. What the extension logs, and anything it writes to stderr, goes to the server log tagged with the extension's ID. The last 200 lines show in the extension's details.

Extension processes need Node 26 or later, which can deny a process the network. On an older Node, Sling refuses to start any extension code and shows "needs Node 26".

## Trust

Packages are signed with a publisher's Ed25519 key. You trust a key once, after checking its fingerprint, and from then on Sling installs packages signed by it. An installed extension stays pinned to the key that signed it, so an update signed by any other key is refused. Unsigned packages install only when the server runs with `SLING_ALLOW_UNSIGNED_EXTENSIONS=1`. [signing.md](signing.md) has the details.

The extensions in the included catalog are trusted because they ship with the server, like its own code. They still run isolated and get only their permissions, and Sling checks their digests like any other package.

## Installing one

Only the workspace owner can install, update, or remove extensions. Extensions are per server: installing one makes it available in every workspace, while its installations, credentials, and workflows stay per workspace.

1. Open **Extensions → Discover**. It lists every extension from your catalogs and the included one. Search, or filter by kind.
2. Pick one and press **Install**. Sling downloads it, checks its digest against the catalog and its signature against its key, runs it once to read what it adds, and shows you:
   - what it adds: connectors, nodes, and templates
   - each permission, in plain words, with the risky ones marked
   - the publisher and the key's fingerprint
   - anything missing, such as an extension it requires
3. If you haven't trusted the publisher's key yet, compare the fingerprint with the one the publisher lists, then press **Trust and install**.

The new connector appears under **Connectors**, and its nodes appear in the workflow editor. Add an installation the way you would for Discord or email.

To add someone else's catalog, paste its URL under **Extensions → Sources**. To install a `.slx` file you have, use **Upload** on the same page. An upload goes through the same checks, using the key in the package's signature.

### Updates

When an enabled catalog lists a newer version with a compatible SDK, the extension shows **Update**. The dialog lists the permissions the new version adds and removes. Nothing updates on its own. Approving moves the extension to the new version without restarting Sling.

If a catalog revokes the version you have installed, Sling disables it and shows the catalog's reason.

### Disabling and removing

Disabling an extension stops its process and event sources. Its nodes then fail with "the extension is disabled". Removing it first lists the installations and workflows that use it, then removes its installations, templates, and node types.
