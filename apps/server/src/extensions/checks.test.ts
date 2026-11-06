import {
  type ExtensionDescription,
  ExtensionPermissionsSchema,
  type NodeDescription,
} from "@sling/connector-sdk";
import { diffPermissions } from "@sling/connector-sdk/host";
import { describe, expect, it } from "vitest";
import {
  checkRequirements,
  contentsOf,
  hostOf,
  nameClashes,
  namespaceOf,
  nodeTypeProblems,
  permissionsKey,
} from "./checks.ts";

const perms = (p: unknown) => ExtensionPermissionsSchema.parse(p);

function node(type: string, trigger = false): NodeDescription {
  return {
    type,
    version: 1,
    title: type,
    description: "",
    category: trigger ? "trigger" : "action",
    inputs: [],
    outputs: [],
    execInput: !trigger,
    execOutputs: [{ name: "next" }],
    dynamicExecOutputs: null,
    configSchema: { type: "object", properties: {} },
    expressionFields: [],
    installationFields: [],
    idempotent: true,
    retry: null,
    trigger: trigger ? { event: type } : null,
    hasResume: false,
  };
}

function description(connectors: { id: string; nodes: NodeDescription[] }[]): ExtensionDescription {
  return {
    format: "sling.description/v1",
    sdkVersion: "1.0.0",
    connectors: connectors.map((c) => ({
      id: c.id,
      name: c.id,
      description: "",
      setupHelp: null,
      credentialsSchema: {},
      secretFields: [],
      configSchema: {},
      hasSource: false,
      isExecutionProvider: false,
      nodes: c.nodes,
    })),
  };
}

describe("permissionsKey", () => {
  it("is the same for the same permissions in any order", () => {
    const a = perms({ network: { hosts: ["a.test", "b.test"], configHosts: ["server"] } });
    const b = perms({ network: { configHosts: ["server"], hosts: ["b.test", "a.test"] } });
    expect(permissionsKey(a)).toBe(permissionsKey(b));
    expect(permissionsKey(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any permission does", () => {
    const base = perms({ network: { hosts: ["a.test"] } });
    const keys = [
      base,
      perms({ network: { hosts: ["a.test", "c.test"] } }),
      perms({ network: { hosts: ["a.test"], localNetwork: true } }),
      perms({ network: { hosts: ["a.test"] }, approvals: true }),
      perms({ network: { hosts: ["a.test"] }, sandboxes: true }),
    ].map(permissionsKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the permission diff for an update", () => {
  it("lists what's added and removed against what was granted", () => {
    const granted = perms({ network: { hosts: ["a.test", "b.test"], configHosts: ["server"] } });
    const next = perms({ network: { hosts: ["a.test", "*.c.test"] }, sandboxes: true });
    const diff = diffPermissions(granted, next);
    expect(diff.added.map((l) => [l.key, l.risk])).toEqual([
      ["host:*.c.test", "normal"],
      ["sandboxes", "high"],
    ]);
    expect(diff.removed.map((l) => l.key)).toEqual(["host:b.test", "configHost:server"]);
    expect(diffPermissions(granted, granted)).toEqual({ added: [], removed: [] });
  });
});

describe("checkRequirements", () => {
  const manifest = (extensions: Record<string, string>, connectors: string[] = []) => ({
    id: "pkg",
    requires: { extensions, connectors },
  });
  const input = {
    installed: new Map([
      ["ntfy", "1.2.0"],
      ["old", "0.9.0"],
    ]),
    hasConnector: (id: string) => id === "discord",
    findInCatalogs: (id: string) => (id === "old" || id === "fly" ? "included" : null),
  };

  it("passes when everything is installed at a matching version", () => {
    expect(checkRequirements(manifest({ ntfy: "^1.0.0" }, ["discord"]), input)).toEqual({
      missing: { extensions: [], connectors: [] },
      problems: [],
    });
  });

  it("lists what's missing or too old, with a catalog that has it", () => {
    const r = checkRequirements(
      manifest({ ntfy: "^2.0.0", old: "^1.0.0", fly: "~1.0.0", gone: "1.0.0" }, [
        "discord",
        "imap",
      ]),
      input,
    );
    expect(r.missing).toEqual({
      extensions: [
        { id: "ntfy", range: "^2.0.0", catalogId: null },
        { id: "old", range: "^1.0.0", catalogId: "included" },
        { id: "fly", range: "~1.0.0", catalogId: "included" },
        { id: "gone", range: "1.0.0", catalogId: null },
      ],
      connectors: ["imap"],
    });
    expect(r.problems).toEqual([
      "It needs the ntfy extension (^2.0.0), and version 1.2.0 is installed.",
      "It needs the old extension (^1.0.0), and version 0.9.0 is installed.",
      "It needs the fly extension (~1.0.0), which isn't installed.",
      "It needs the gone extension (1.0.0), which isn't installed.",
      "It needs the imap connector, which this server doesn't have.",
    ]);
  });

  it("ignores a package requiring itself", () => {
    expect(checkRequirements(manifest({ pkg: "^1.0.0" }), input).problems).toEqual([]);
  });
});

describe("nameClashes", () => {
  const index = {
    connectors: new Map<string, string | null>([
      ["discord", null],
      ["ntfy", "ntfy"],
    ]),
    namespaces: new Map<string, string | null>([
      ["core", null],
      ["discord", null],
      ["ntfy", "ntfy"],
    ]),
  };

  it("refuses names built-in nodes or another extension use", () => {
    expect(nameClashes("core", description([{ id: "core", nodes: [] }]), index)).toEqual([
      "The name core is already used by Sling's built-in nodes.",
    ]);
    expect(
      nameClashes("other", description([{ id: "ntfy", nodes: [node("other.x")] }]), index),
    ).toEqual(["Connector ntfy is already registered by the ntfy extension."]);
  });

  it("lets an update reuse its own names", () => {
    expect(nameClashes("ntfy", description([{ id: "ntfy", nodes: [] }]), index)).toEqual([]);
  });

  it("has nothing to check in a workflow package", () => {
    expect(nameClashes("core", null, index)).toEqual([]);
  });

  it("takes the namespace from before the first dot", () => {
    expect(namespaceOf("acme-crm.contacts.create")).toBe("acme-crm");
    expect(namespaceOf("acme")).toBe("acme");
  });
});

describe("nodeTypeProblems", () => {
  it("refuses node types a workflow definition couldn't hold", () => {
    const d = description([
      { id: "acme-crm", nodes: [node("acme-crm.create_contact"), node("acme-crm.Bad Name")] },
    ]);
    expect(nodeTypeProblems(d)).toEqual([
      'Node acme-crm.Bad Name isn\'t a valid node type. Use lowercase letters, digits, "_" and "-", separated by dots.',
    ]);
  });
});

describe("contentsOf", () => {
  it("lists connectors, nodes with triggers marked, and templates", () => {
    const d = description([{ id: "chat", nodes: [node("chat.message", true), node("chat.send")] }]);
    expect(contentsOf(d, [{ key: "chat/hello", name: "Hello" }])).toEqual({
      connectors: [{ id: "chat", name: "chat", isExecutionProvider: false }],
      nodes: [
        { type: "chat.message", version: 1, title: "chat.message", isTrigger: true },
        { type: "chat.send", version: 1, title: "chat.send", isTrigger: false },
      ],
      templates: [{ key: "chat/hello", name: "Hello" }],
    });
  });
});

describe("hostOf", () => {
  it("takes the hostname of a URL or a bare host", () => {
    expect(hostOf("https://NTFY.example.com:8443/topic")).toBe("ntfy.example.com");
    expect(hostOf("wss://push.example.com")).toBe("push.example.com");
    expect(hostOf("ntfy.example.com")).toBe("ntfy.example.com");
    expect(hostOf("http://[::1]:8080")).toBe("[::1]");
  });

  it("ignores anything else", () => {
    for (const v of ["", "  ", 42, null, "ftp://files.example.com", "file:///etc/passwd"]) {
      expect(hostOf(v)).toBeNull();
    }
  });
});
