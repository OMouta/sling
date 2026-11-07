# sling-ext

`sling-ext` builds, checks, signs, and publishes extensions. It needs Node 26.13 or later.

In the Sling repo, run it as `pnpm sling-ext <command>`. It works in the folder you run it from, wherever that is in the repo.

Outside the repo, link it onto your `PATH` from a Sling checkout where you've run `pnpm install`:

```sh
ln -s "$PWD/packages/extension-cli/src/main.ts" ~/.local/bin/sling-ext
sling-ext --version
```

A project needs no dependencies of its own. `sling-ext` brings `@sling/connector-sdk` and `zod`, bundles its own copies into every extension, and `init` points your editor's `tsconfig.json` at them.

| Command | Does |
|---|---|
| [`init`](#init) | Starts a project |
| [`build`](#build) | Bundles `src/index.ts` into `extension.mjs` |
| [`check`](#check) | Runs the bundle the way Sling does, and lists what it adds |
| [`keygen`](#keygen) | Makes a signing key |
| [`pack`](#pack) | Writes the `.slx`, signed if you give a key |
| [`sign`](#sign) | Signs a `.slx` |
| [`verify`](#verify) | Checks a `.slx`'s digest, signature, and manifest |
| [`catalog`](#catalog) | Writes `catalog.json` for a folder of `.slx` files |

Every command takes `--help`. Commands exit 0 on success and 1 on any problem, with the reason on stderr.

## init

```sh
sling-ext init <dir> [--kind connector|provider|workflows] [--id id] [--name name] [--publisher name]
```

Creates `<dir>` with a working starter. It refuses a folder that isn't empty.

| Kind | Starts with |
|---|---|
| `connector`, the default | An action that POSTs to an HTTP endpoint, a trigger fed by an event source that polls it for changes, a connection test, and a test of the built bundle |
| `provider` | A sandbox provider for a platform with an HTTP API, and a test of its `create` |
| `workflows` | A workflow package with one template that posts to Discord, and a test of its bindings |

The ID comes from the folder's name unless you pass `--id`, and the publisher from your user name unless you pass `--publisher`. The project has `sling-extension.json`, `src/index.ts`, a test in `test/`, a README, an icon, a `.gitignore`, and for code a `tsconfig.json` whose `paths` point at the SDK and zod that came with `sling-ext`.

```text
$ sling-ext init acme-crm --publisher Acme
Created connector acme-crm in acme-crm
  ...
Next:
  cd acme-crm
  sling-ext build
  sling-ext check
  node --test
```

## build

```sh
sling-ext build [dir] [--entry src/index.ts] [--no-minify]
```

Bundles the entry and everything it imports with esbuild into the file the manifest's `main` names: one ES module for Node 26, minified, with every dependency inside it. A workflow package has nothing to build.

`@sling/connector-sdk` and `zod` always come from `sling-ext`'s own installation, so every extension built with one `sling-ext` gets the same SDK and one copy of zod. zod's translated error messages are left out, which halves the bundle. English stays, and calling another locale, such as `z.locales.fr()`, throws an error that says to import it directly from `zod/v4/locales/fr.js`.

```text
$ sling-ext build
Built extension.mjs: 196.5 kB in 50 ms
```

`build` warns when the bundle imports a Node module an extension can't use, such as `node:fs` or `node:https`.

## check

```sh
sling-ext check [dir | file.slx]
```

Checks a project, or a packed `.slx`, the way Sling checks a package when you install it:

1. The manifest, against [manifest.md](manifest.md), and that every file it names is there.
2. That the `sdk` range includes this SDK's version.
3. Each template's `template.json` and `workflow.json`. See [workflow-packages.md](workflow-packages.md#checking-and-packing).
4. For packages with code, it unpacks the package into a temporary folder and runs the bundle there under Sling's restrictions, then calls `describe()`.
5. What the bundle describes: names inside the extension's ID, nothing defined twice, a provider only with the `sandboxes` permission, and `configHosts` fields that exist.

The bundle runs in a Node process started like this, with an empty environment:

```text
node --permission
     --allow-fs-read=<the unpacked package>
     --allow-fs-read=<the script that loads it>
     --max-old-space-size=<memoryMb>
     --disallow-code-generation-from-strings
```

So a bundle that reads a file, opens a socket, starts a process, or calls `eval` while it loads fails here the same way it would in Sling.

```text
$ sling-ext check
ntfy (ntfy) 1.0.0, published by Sling

Adds
  Connector ntfy: ntfy (event source)
    ntfy.publish v1, action: Publish to ntfy
    ntfy.message_received v1, trigger on ntfy.message: ntfy message received
Kinds: connector

Permissions
  Connect to ntfy.sh
  Connect to the address in its "server" setting

Package: 4 files, 209.0 kB unpacked. The bundle described itself in 36 ms.

No problems.
```

Permissions marked `[high]` are the ones the install dialog marks as risky. Anything the bundle prints while it loads is shown under "The bundle printed". Warnings don't fail the check. Problems do, and they're exactly what Sling would refuse.

## keygen

```sh
sling-ext keygen [--out key.json] [--publisher name]
```

Makes an Ed25519 signing key and prints its fingerprint. The file is written with mode 0600, and `keygen` won't overwrite an existing one. The publisher name defaults to the one in the manifest when you run it in a project. `--out` defaults to `key.json`, but keep keys outside your project, for example in `~/.sling/`.

```text
$ sling-ext keygen --out ~/.sling/signing-key.json --publisher Acme
Wrote /Users/you/.sling/signing-key.json. Keep it secret: it signs packages as Acme.
Fingerprint: 7c30 8f1e d548 0a05 (key ID 7c308f1ed5480a05)
Public key: 73upnPgxacCANnCPl8saP3+EECULJ7Q5tJIq9/t3yDw=
```

See [signing.md](signing.md) for what the fingerprint is for.

## pack

```sh
sling-ext pack [dir] [--sign key.json] [--out dist]
```

Runs the same checks as `check`, then writes `<out>/<id>-<version>.slx`, in `dist/` by default. It packs only the manifest, the bundle, `README.md`, the icon, and the templates. It refuses a project with problems, or one whose bundle isn't built.

Packing is deterministic: sorted entries, mtime 0, owner 0, mode 0644, and a fixed gzip header. The same files give the same bytes on any machine, signed or not, so anyone can rebuild a package and compare.

```text
$ sling-ext pack --sign ~/.sling/signing-key.json
Packed dist/acme-crm-0.1.0.slx: 57.5 kB, 4 files
Digest: sha256:5cbf8e4082b51a0ec8684b01c122680337fec9e4d29079d9f18303e00a609e38
Signed by Acme: 7c30 8f1e d548 0a05 (key ID 7c308f1ed5480a05)
```

## sign

```sh
sling-ext sign <file.slx> --key key.json [--out file.slx]
```

Adds `SIGNATURE.json` to a package, or replaces the signature it has, and writes it back in place unless you pass `--out`. The digest doesn't change. Use it for packages you didn't pack yourself, such as one from **Export as package**.

## verify

```sh
sling-ext verify <file.slx> [--fingerprint keyId]
```

Opens the package with Sling's limits, checks its manifest, prints its digest and permissions, and checks the signature. With `--fingerprint`, it also checks that the signing key is that one. Spaces in the fingerprint are fine.

```text
$ sling-ext verify dist/acme-crm-0.1.0.slx
Acme crm (acme-crm) 0.1.0, published by Acme
Files: 4, 198.2 kB unpacked, 57.5 kB packed
Digest: sha256:5cbf8e4082b51a0ec8684b01c122680337fec9e4d29079d9f18303e00a609e38
SDK: ^1.0.0 (this sling-ext has 1.0.0)
Permissions:
  Connect to the address in its "url" setting
Signature: good, by Acme
Fingerprint: 7c30 8f1e d548 0a05 (key ID 7c308f1ed5480a05)
```

It exits 1 for a bad signature, a different key than `--fingerprint`, or an unsigned package.

## catalog

```sh
sling-ext catalog <dir> [--name "Acme extensions"] [--out catalog.json] [--revoke id@version --reason text]
```

Writes `catalog.json` for the `.slx` files in `<dir>`, with URLs relative to it. It takes publishers from the packages' signatures, and kinds from what each package adds, running each bundle once to find out. It refuses a package with a bad signature, two files with the same ID and version, and an extension whose versions are signed by different keys.

When `catalog.json` already exists, it keeps the catalog's name, each version's `publishedAt`, and revocations. `--revoke` marks one version revoked with your reason.

```text
$ sling-ext catalog dist --name "Acme extensions"
Wrote dist/catalog.json: "Acme extensions", 1 extension, 1 version, 1 publisher
  acme-crm 0.1.0 (connector), signed by Acme, 7c30 8f1e d548 0a05

Serve dist/ from any static HTTPS host, then add <url>/catalog.json in Sling under Extensions → Sources.
```

[signing.md](signing.md#catalogs) covers hosting a catalog and revoking versions.

## The included catalog

In the Sling repo, `pnpm extensions:build` builds and packs every extension in `extensions/`, unsigned, into `extensions/dist` with a `catalog.json` named "Included with Sling". The server reads that folder from `SLING_INCLUDED_EXTENSIONS`. The Docker image builds it in its own stage and sets `SLING_INCLUDED_EXTENSIONS=/app/extensions`.
