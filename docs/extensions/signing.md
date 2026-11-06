# Signing, trust, and catalogs

Sling installs an extension only when it trusts the key that signed it. A publisher signs each package with an Ed25519 key. A Sling owner trusts that key once, after checking its fingerprint, and from then on can install and update that publisher's packages. Packages travel through catalogs, which are JSON files on any static HTTPS host.

## Keys

Make a key once, and keep it outside your project:

```sh
sling-ext keygen --out ~/.sling/signing-key.json --publisher "Acme"
```

```text
Wrote /Users/you/.sling/signing-key.json. Keep it secret: it signs packages as Acme.
Fingerprint: 3f2a 91c0 7d4e 22b1 (key ID 3f2a91c07d4e22b1)
Public key: lK0b...
```

The file holds the key ID, the public key, the private key, and the publisher name. `keygen` writes it with mode 0600 and refuses to overwrite a file. `sign` and `pack --sign` warn when other users on the machine can read it.

Back the key up. Every extension installed from your packages is pinned to it, so if you lose it, your users have to remove and reinstall your extensions to move to a new one.

### Fingerprints

The key ID is the first 16 hex characters of the SHA-256 of the raw 32-byte public key. Sling shows it as four groups of four, `3f2a 91c0 7d4e 22b1`, and calls it the fingerprint.

Publish your fingerprint somewhere your users already trust, such as your README or website. Before trusting your key, they compare it with the one Sling shows.

## Signing

Sign when you pack, or sign a package you already have:

```sh
sling-ext pack --sign ~/.sling/signing-key.json
sling-ext sign dist/acme-crm-1.1.0.slx --key ~/.sling/signing-key.json
```

Signing adds `SIGNATURE.json` to the package, or replaces the one there:

```json
{
  "format": "sling.signature/v1",
  "keyId": "3f2a91c07d4e22b1",
  "publicKey": "<base64, 32 bytes>",
  "publisher": "Acme",
  "signature": "<base64>"
}
```

The signature is Ed25519 over these bytes, with a newline after each line:

```text
sling.extension/v1
<id>
<version>
<digest>
```

So a signature covers the package's ID, its version, and every file in it, through the digest described in [manifest.md](manifest.md#files). Changing any file, or moving a signature to another package or version, breaks it. Signing doesn't change the digest, and packing the same files gives the same bytes, so a signed package can be rebuilt and checked by anyone.

Check a package before you publish it:

```sh
sling-ext verify dist/acme-crm-1.1.0.slx --fingerprint 3f2a91c07d4e22b1
```

## Trust in Sling

Trust is per key, and per server.

- **Installing from a catalog.** When the package's key isn't trusted yet, the install dialog shows the publisher's name and fingerprint, with **Trust and install**. The name comes from the signature, so check the fingerprint, not the name.
- **Uploads** work the same way, with the key in the package's signature.
- **Trusted publishers** are listed under **Extensions → Sources**. Removing one leaves its installed extensions running, but no new install or update can use that key.

### Pinning

An installed extension is pinned to the key that signed it. An update signed by any other key is refused, even by a key you trust. That stops someone who controls a catalog, or a second trusted publisher, from replacing an extension you already run. To move an extension to a new key, remove it and install it again.

### Every install is checked twice

Each install and update has two steps. **Preview** downloads or receives the package, checks its digest and signature, runs it once to read what it adds, and shows what you're about to approve. **Confirm** sends back the staging ID, the digest, and the permissions you saw, and Sling refuses if any of them changed in between. A preview expires after 15 minutes.

Sling refuses, with a reason:

- a package whose files don't match its signature
- a download whose digest doesn't match the catalog
- a signature by a key you haven't trusted, until you trust it
- an update signed by a different key than the installed version
- a package that needs a newer SDK than the server has
- a package that adds names outside its own ID
- a stored package that changed in the database, when the server loads it

### Packages that ship with Sling

The catalog included with Sling, in `SLING_INCLUDED_EXTENSIONS`, is unsigned and trusted anyway, because it ships with the server like its own code. Its packages are still checked against their digests, run isolated, and get only their permissions.

### Unsigned packages

Sling installs an unsigned package only when the server runs with `SLING_ALLOW_UNSIGNED_EXTENSIONS=1`. The web app can't turn that on. Unsigned extensions are labeled **Unsigned** on every card. Use it for developing an extension, or for moving an exported workflow between your own servers.

## Catalogs

A catalog is a `catalog.json` next to the packages it lists. Write one for a folder of `.slx` files:

```sh
sling-ext catalog dist --name "Acme extensions"
```

```json
{
  "format": "sling.catalog/v1",
  "name": "Acme extensions",
  "publishers": [{ "keyId": "3f2a91c07d4e22b1", "name": "Acme", "publicKey": "<base64>" }],
  "extensions": [{
    "id": "acme-crm",
    "name": "Acme CRM",
    "description": "Contacts and deals in Acme.",
    "publisher": "3f2a91c07d4e22b1",
    "kinds": ["connector"],
    "homepage": "https://acme.test/sling",
    "versions": [{
      "version": "1.1.0",
      "url": "acme-crm-1.1.0.slx",
      "digest": "sha256:…",
      "size": 48213,
      "sdk": "^1.0.0",
      "permissions": { "network": { "hosts": ["api.acme.test"], "configHosts": [], "localNetwork": false }, "approvals": false, "sandboxes": false },
      "publishedAt": "2026-11-01T00:00:00Z",
      "revoked": null
    }]
  }]
}
```

`catalog` reads every package in the folder:

- **URLs** are the file names, relative to the catalog. Sling resolves them against the catalog's own URL.
- **Publishers** come from the packages' signatures. Each extension's `publisher` is its key ID, or `null` when it's unsigned. `catalog` refuses an extension whose versions are signed by different keys, since Sling would refuse those updates anyway.
- **Kinds** come from what each package adds: `connector`, `provider`, and `workflows`. **Discover** filters on them. To find out, `catalog` runs each bundle once, the same restricted way `check` does.
- **Versions** are listed newest first, each with its digest, size, SDK range, and permissions, so Sling can show them before downloading anything.

Running `catalog` again keeps each version's `publishedAt` and any revocation, as long as the package's digest is the same. The output is capped at 2 MB, the most Sling accepts.

### Hosting one

A catalog is static files. Put the folder on any HTTPS host, such as GitHub Pages, an S3 bucket behind a CDN, or a plain web server:

```text
https://ext.acme.test/catalog.json
https://ext.acme.test/acme-crm-1.0.0.slx
https://ext.acme.test/acme-crm-1.1.0.slx
```

Then add `https://ext.acme.test/catalog.json` under **Extensions → Sources**. Sling fetches a catalog when you add it, when you press **Refresh**, and every 6 hours after that, sending the last ETag so an unchanged catalog costs one small request. It fetches catalogs over HTTPS only.

To develop a catalog locally, serve it from your machine and run Sling with `SLING_ALLOW_UNSIGNED_EXTENSIONS=1`. With that set, Sling also accepts a catalog at a loopback URL over plain HTTP:

```sh
cd dist && python3 -m http.server 8000
# add http://127.0.0.1:8000/catalog.json under Extensions → Sources
```

### Publishing an update

Pack the new version into the same folder, run `catalog` again, and upload both files. Keep the older `.slx` files listed, so servers that haven't updated can still reinstall the version they run. Servers see **Update** within 6 hours, or at once on **Refresh**, and the update dialog shows which permissions the new version adds and removes.

### Revoking a version

If a version is broken or unsafe, revoke it:

```sh
sling-ext catalog dist --revoke acme-crm@1.1.0 --reason "Logs the API key on errors. Update to 1.1.1."
```

That sets the version's `revoked` to `{ "reason": "…" }`. Upload the new `catalog.json`. Each server that has that version installed disables it the next time it fetches the catalog, and shows your reason. Sling never offers a revoked version as an update. Publish a fixed version alongside, so people have something to move to.

Revocation lives in your catalog, so it reaches only servers that use your catalog. There's no global revocation list.
