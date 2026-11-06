# The manifest and permissions

Every package has a `sling-extension.json` at its root. Sling reads it before anything else, and refuses the package if it doesn't match this page.

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
  "icon": "icon.svg",
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

## Fields

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | Always `sling.extension/v1` |
| `id` | yes | 3 to 40 lowercase letters, digits, and hyphens. It starts with a letter and doesn't end with a hyphen. Everything the extension adds is named after it |
| `name` | yes | Shown on cards and in dialogs. Up to 80 characters |
| `version` | yes | `major.minor.patch`, with an optional prerelease such as `1.1.0-beta.1`, which sorts before `1.1.0` |
| `description` | no | One or two sentences for the card. Up to 500 characters |
| `publisher` | yes | Your name as people should see it. It's only a label: trust comes from the key that signs the package, see [signing.md](signing.md) |
| `sdk` | yes | The SDK versions the extension works with: `^1.0.0`, `~1.0.0`, `>=1.0.0`, or an exact `1.0.0`. It must include the server's SDK version, which is 1.0.0 |
| `main` | no | The bundled ES module, ending in `.mjs`. `sling-ext build` writes it. Leave it out for a workflow package |
| `templates` | no | Template keys, one folder each under `templates/`. Up to 50. See [workflow-packages.md](workflow-packages.md) |
| `icon` | no | An `.svg` or `.png` in the package. Sling serves it with a content security policy that blocks scripts |
| `permissions` | no | What the extension may do beyond the fixed minimum, below. Everything is off by default |
| `requires.extensions` | no | Other extensions the templates need, by ID, with a version range |
| `requires.connectors` | no | Connectors built into Sling that the templates need, such as `discord` |
| `memoryMb` | no | The heap limit for the extension's process, 64 to 512. Default 256 |
| `license`, `homepage`, `repository` | no | Shown in the details dialog. `homepage` and `repository` are URLs |

A package needs `main`, `templates`, or both.

### Names

Every connector the extension adds has the extension's ID, or the ID, a dot, and a name: `acme`, `acme.sandbox`. Every node type and trigger event starts with the ID and a dot: `acme.send`, `acme.message_received`. Templates install as `<id>/<key>`. Sling refuses a package that adds any other name.

## Files

```text
sling-extension.json     the manifest
extension.mjs            the bundle, with every dependency inside it (absent in workflow packages)
templates/<key>/         template.json and workflow.json
README.md                shown in the details dialog
icon.svg or icon.png     optional
SIGNATURE.json           added by signing
```

A `.slx` is a gzipped tar of these files. `sling-ext pack` writes it and includes only these files, whatever else is in the folder. There are no install scripts and no `node_modules`: the bundle carries its dependencies.

Limits:

- 20 MB packed, 50 MB unpacked, 2,000 files
- paths up to 200 characters, with no leading `/` and no `..`
- regular files and folders only, no links

The package's digest is `sha256:` and the SHA-256 of one line per file, sorted by path: `<path>\0<hex SHA-256 of the file>\n`. `SIGNATURE.json` is left out, so signing doesn't change the digest, and neither does the way the tar was written or compressed. Sling checks the digest each time it loads the package.

## Permissions

Without any permission, an extension can:

- read the credentials and config of its own connectors' installations, for the call in progress
- emit its own trigger events
- keep a small state store per installation
- log

Everything else is a permission. The install dialog lists each one in plain words, marks the risky ones, and shows what an update adds or removes. Sling stores what you granted and checks it on every call. A permission this version of Sling doesn't know makes the manifest invalid, so nothing is silently ignored.

| Permission | Install dialog says | Grants |
|---|---|---|
| `network.hosts` | "Connect to ntfy.sh" | `fetch` and `WebSocket` to these hosts |
| `network.configHosts` | "Connect to the host in each installation's "server" setting" | The host of the URL in these config fields, for every installation of the extension's connectors |
| `network.localNetwork` | "Connect to addresses on your local network, including this server" (high) | Loopback and private addresses, and plain `http` and `ws` to them |
| `approvals` | "Approve or reject pending approvals, for people its installation allows" (high) | `approvals.decide` in event sources, as the Discord connector's buttons do |
| `sandboxes` | "Start sandboxes, and receive each sandbox's secrets: API keys, the GitHub token, and its pairing code" (high) | Acting as a sandbox provider, see [providers.md](providers.md) |

`network.hosts` takes up to 50 lowercase hostnames, or `*.` and a name for its subdomains, such as `*.acme.test`. List the bare name too if you call it. IP addresses work, but a name is clearer to the person installing.

`network.configHosts` takes up to 10 config field names. Each must be a field in one of the extension's connector config schemas, or `sling-ext check` and Sling refuse the package. Sling reads the field's value from each installation, so a user can point a self-hosted server at their own host without the extension asking for every host up front. When an installation's config changes, so do the hosts it allows.

## Network

An extension's process has no network of its own. Its `fetch` and `WebSocket` go through Sling, which checks each request:

1. **The host must be allowed**, by `network.hosts` or by `network.configHosts`.
2. **The scheme** must be `https:` or `wss:`. `http:` and `ws:` work only with `localNetwork`, and only when the name resolves to a private address.
3. **The address.** Sling resolves the name itself and checks every address it gets. Without `localNetwork`, it refuses loopback, private, link-local, carrier-grade NAT, and unique local addresses. It connects to the address it checked, so a DNS answer that changes in between can't slip through.
4. **Redirects** are followed by Sling, up to 5, and each hop is checked again.
5. **Limits.** Request and response bodies are capped at 10 MB. A request times out after 60 seconds unless the extension passes a shorter `signal`. WebSocket messages are capped at 1 MB, and an extension can hold 16 sockets at once.

A refusal reaches the extension as a `TypeError` from `fetch`, or an `error` event on the socket, with the reason in the message. Sling logs it too. The reasons look like this:

- a host the manifest doesn't declare
- plain HTTP to a public host
- a redirect to a host the manifest doesn't declare
- a declared name that resolves to a private address, without `localNetwork`

Raw TCP, UDP, and DNS aren't available, and extensions can't receive inbound requests.
