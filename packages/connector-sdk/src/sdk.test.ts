import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkDescription,
  compareVersions,
  describePermissions,
  diffPermissions,
  formatFingerprint,
  kindsOf,
  satisfiesRange,
} from "./host.ts";
import {
  defineConnector,
  defineExtension,
  defineNode,
  ExtensionManifestSchema,
  SDK_VERSION,
} from "./index.ts";

const manifest = (over: Record<string, unknown> = {}) =>
  ExtensionManifestSchema.parse({
    format: "sling.extension/v1",
    id: "acme",
    name: "Acme",
    version: "1.0.0",
    publisher: "Acme",
    sdk: "^1.0.0",
    main: "extension.mjs",
    ...over,
  });

const send = defineNode({
  type: "acme.send",
  version: 1,
  title: "Send",
  description: "Sends",
  category: "action",
  configSchema: z.object({ text: z.string().default("hi").describe("Text") }),
  inputs: [],
  outputs: [{ name: "id", type: "string" }],
  execInput: true,
  execOutputs: [{ name: "next" }],
  idempotent: false,
  run: async () => ({ exec: "next", outputs: { id: "1" } }),
});

const connector = defineConnector({
  id: "acme",
  name: "Acme",
  description: "Acme API",
  credentialsSchema: z.object({ token: z.string() }),
  secretFields: ["token"],
  configSchema: z.object({ server: z.url().default("https://acme.test") }),
  test: async () => ({ ok: true }),
  nodes: [send],
});

describe("manifest", () => {
  it("fills defaults", () => {
    const m = manifest();
    expect(m.permissions).toEqual({
      network: { hosts: [], configHosts: [], localNetwork: false },
      approvals: false,
      sandboxes: false,
    });
    expect(m.requires).toEqual({ extensions: {}, connectors: [] });
    expect(m.memoryMb).toBe(256);
  });

  it("refuses unknown permissions, bad IDs, and packages with nothing in them", () => {
    expect(() => manifest({ permissions: { shell: true } })).toThrow();
    expect(() => manifest({ id: "Acme" })).toThrow();
    expect(() => manifest({ id: "ab" })).toThrow();
    expect(() => manifest({ main: undefined })).toThrow(/main, templates/);
    expect(() => manifest({ main: "index.js" })).toThrow(/\.mjs/);
    expect(() => manifest({ permissions: { network: { hosts: ["Bad Host"] } } })).toThrow();
  });
});

describe("describe", () => {
  it("turns schemas into JSON Schema with input defaults", () => {
    const d = defineExtension({ connectors: [connector] }).describe();
    expect(d.sdkVersion).toBe(SDK_VERSION);
    const c = d.connectors[0];
    expect(c?.configSchema).toMatchObject({
      properties: { server: { default: "https://acme.test" } },
    });
    expect(c?.nodes[0]).toMatchObject({ type: "acme.send", trigger: null, hasResume: false });
    expect(c?.nodes[0]).toMatchObject({
      assistant: null,
      hasVerify: false,
      verifyForSeconds: null,
    });
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it("says which arguments a rule may pin, and whether the node checks itself", () => {
    const checked = defineNode({
      ...send,
      type: "acme.post",
      assistant: { sends: true, summary: "Post to {to}", ruleFields: ["to"] },
      verify: async () => ({ state: "passed", message: "Posted" }),
      verifyForSeconds: 600,
    });
    const d = defineExtension({
      connectors: [{ ...connector, nodes: [send, checked] }],
    }).describe();
    expect(d.connectors[0]?.nodes[1]).toMatchObject({
      type: "acme.post",
      assistant: { sends: true, summary: "Post to {to}", ruleFields: ["to"] },
      hasVerify: true,
      verifyForSeconds: 600,
    });
  });
});

describe("checkDescription", () => {
  const desc = defineExtension({ connectors: [connector] }).describe();

  it("accepts names under the extension's ID", () => {
    expect(checkDescription(manifest(), desc)).toEqual([]);
    expect(kindsOf(manifest(), desc)).toEqual(["connector"]);
  });

  it("refuses names outside it, providers without permission, and unknown config hosts", () => {
    const other = { ...desc, connectors: [{ ...desc.connectors[0], id: "other" }] };
    expect(checkDescription(manifest(), other as typeof desc)[0]).toMatch(/must be named acme/);
    const provider = {
      ...desc,
      connectors: [{ ...desc.connectors[0], isExecutionProvider: true }],
    } as typeof desc;
    expect(checkDescription(manifest(), provider).join()).toMatch(/sandboxes permission/);
    expect(
      checkDescription(
        manifest({ permissions: { network: { configHosts: ["url"] } } }),
        desc,
      ).join(),
    ).toMatch(/"url"/);
    expect(
      checkDescription(manifest({ permissions: { network: { configHosts: ["server"] } } }), desc),
    ).toEqual([]);
  });

  it("refuses permissions on a package without code", () => {
    const m = manifest({ main: undefined, templates: ["t"], permissions: { approvals: true } });
    expect(checkDescription(m, null)).toEqual([
      "A package without code can't ask for permissions.",
    ]);
    expect(kindsOf(m, null)).toEqual(["workflows"]);
  });
});

describe("permissions", () => {
  it("describes and diffs", () => {
    const a = manifest({ permissions: { network: { hosts: ["ntfy.sh"] } } }).permissions;
    const b = manifest({
      permissions: { network: { hosts: ["*.ntfy.sh"], localNetwork: true }, approvals: true },
    }).permissions;
    expect(describePermissions(a).map((l) => l.text)).toEqual(["Connect to ntfy.sh"]);
    const d = diffPermissions(a, b);
    expect(d.added.map((l) => l.key)).toEqual(["host:*.ntfy.sh", "localNetwork", "approvals"]);
    expect(d.removed.map((l) => l.key)).toEqual(["host:ntfy.sh"]);
    expect(d.added.filter((l) => l.risk === "high")).toHaveLength(2);
  });

  it("formats fingerprints", () => {
    expect(formatFingerprint("3f2a91c07d4e22b1")).toBe("3f2a 91c0 7d4e 22b1");
  });
});

describe("versions", () => {
  it.each([
    ["1.4.0", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["1.2.9", "~1.2.0", true],
    ["1.3.0", "~1.2.0", false],
    ["3.0.0", ">=1.0.0", true],
    ["1.0.0", "1.0.0", true],
    ["1.0.1", "1.0.0", false],
    ["0.9.0", "^1.0.0", false],
  ])("%s in %s is %s", (v, r, ok) => {
    expect(satisfiesRange(v, r)).toBe(ok);
  });

  it("orders prereleases before releases", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
});
