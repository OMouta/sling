import { computeDigest } from "@sling/extension-package";
import { describe, expect, it } from "vitest";
import { buildExtension, generateSigningKey } from "../../test/fixtures/extensions.ts";
import { assessTrust, type TrustInput } from "./trust.ts";

const acme = generateSigningKey("Acme");
const other = generateSigningKey("Other");

const template = {
  t: {
    template: { name: "T" },
    workflow: { schema: "sling.workflow/v1", name: "T", nodes: [], edges: [] },
  },
};

async function pkg(key?: typeof acme) {
  return (await buildExtension({ id: "trusty", templates: template, ...(key ? { key } : {}) })).pkg;
}

function input(over: Partial<TrustInput> & Pick<TrustInput, "pkg">): TrustInput {
  return {
    source: "upload",
    catalogPublisher: null,
    allowUnsigned: false,
    isTrusted: () => false,
    pinnedKeyId: null,
    installed: false,
    ...over,
  };
}

describe("assessTrust", () => {
  it("trusts the included catalog by origin, signed or not", async () => {
    const r = assessTrust(input({ source: "included", pkg: await pkg() }));
    expect(r).toEqual({ problems: [], signer: null, signed: true, needsTrust: false });
  });

  it("refuses unsigned packages unless the server allows them", async () => {
    const p = await pkg();
    expect(assessTrust(input({ pkg: p })).problems).toEqual([
      "The package isn't signed. This server only installs signed packages.",
    ]);
    expect(assessTrust(input({ pkg: p, allowUnsigned: true }))).toEqual({
      problems: [],
      signer: null,
      signed: false,
      needsTrust: false,
    });
  });

  it("refuses an unsigned package the catalog says is signed", async () => {
    const r = assessTrust(
      input({ pkg: await pkg(), allowUnsigned: true, catalogPublisher: acme.keyId }),
    );
    expect(r.problems[0]).toContain("but it isn't signed");
  });

  it("asks to trust a valid signature by an unknown key", async () => {
    const r = assessTrust(input({ pkg: await pkg(acme) }));
    expect(r).toMatchObject({ problems: [], signed: true, needsTrust: true });
    expect(r.signer).toEqual({ keyId: acme.keyId, publicKey: acme.publicKey, publisher: "Acme" });
    const trusted = assessTrust(
      input({ pkg: await pkg(acme), isTrusted: (k) => k === acme.keyId }),
    );
    expect(trusted.needsTrust).toBe(false);
  });

  it("refuses a package changed after it was signed", async () => {
    const p = await pkg(acme);
    const files = new Map(p.files);
    files.set("README.md", new TextEncoder().encode("changed"));
    const changed = { ...p, files, digest: computeDigest(files) };
    const r = assessTrust(input({ pkg: changed }));
    expect(r.problems).toEqual([
      "The signature doesn't match the package. Its files changed after it was signed.",
    ]);
    expect(r.signer).toBeNull();
  });

  it("refuses a catalog entry that names another publisher", async () => {
    const r = assessTrust(
      input({ source: "catalog", pkg: await pkg(other), catalogPublisher: acme.keyId }),
    );
    expect(r.problems[0]).toMatch(/^The package is signed by [0-9a-f ]+, but the catalog lists/);
  });

  it("pins an installed extension to the key that signed it", async () => {
    const trustedBoth = (k: string) => k === acme.keyId || k === other.keyId;
    const switched = assessTrust(
      input({
        pkg: await pkg(other),
        isTrusted: trustedBoth,
        installed: true,
        pinnedKeyId: acme.keyId,
      }),
    );
    expect(switched.problems[0]).toContain("signed by a different key than the installed version");
    const same = assessTrust(
      input({
        pkg: await pkg(acme),
        isTrusted: trustedBoth,
        installed: true,
        pinnedKeyId: acme.keyId,
      }),
    );
    expect(same.problems).toEqual([]);
    const unsigned = assessTrust(
      input({ pkg: await pkg(), allowUnsigned: true, installed: true, pinnedKeyId: acme.keyId }),
    );
    expect(unsigned.problems[0]).toContain("The installed version is signed by");
    // An unpinned install (unsigned or included before) can move to a signed version.
    const fromUnsigned = assessTrust(input({ pkg: await pkg(acme), installed: true }));
    expect(fromUnsigned).toMatchObject({ problems: [], needsTrust: true });
  });
});
