import { describe, expect, it } from "vitest";
import { catalog, connectors } from "../test/fixtures.ts";
import {
  blankRow,
  defaultsFor,
  type FormField,
  fieldFor,
  formFields,
  humanize,
  setField,
} from "./schemaForm.ts";

const schemaOf = (type: string) => {
  const s = catalog.nodes.find((n) => n.type === type);
  if (!s) throw new Error(type);
  return s.configSchema;
};

const byKey = (fields: FormField[], key: string) => {
  const f = fields.find((x) => x.key === key);
  if (!f) throw new Error(key);
  return f;
};

describe("JSON Schema to form fields", () => {
  it("maps primitives, enums and integers", () => {
    const fields = formFields(schemaOf("http.request"));
    expect(byKey(fields, "method")).toMatchObject({
      kind: "enum",
      options: [
        { value: "GET", label: "GET" },
        { value: "POST", label: "POST" },
        { value: "HEAD", label: "HEAD" },
      ],
      default: "GET",
      required: false,
    });
    expect(byKey(fields, "url")).toMatchObject({
      kind: "string",
      required: true,
      description: "Full URL",
      label: "Url",
    });
    expect(byKey(fields, "timeoutMs")).toMatchObject({
      kind: "number",
      integer: true,
      min: 1,
      max: 60000,
      label: "Timeout ms",
    });
  });

  it("renders maps without fixed properties as JSON", () => {
    expect(byKey(formFields(schemaOf("http.request")), "headers").kind).toBe("json");
  });

  it("honors widget hints", () => {
    expect(byKey(formFields(schemaOf("ai.prompt")), "prompt").kind).toBe("textarea");
    expect(fieldFor("schema", { type: "object", widget: "json" }, true).kind).toBe("json");
  });

  it("unwraps nullable types", () => {
    const f = byKey(formFields(schemaOf("ai.prompt")), "model");
    expect(f).toMatchObject({ kind: "string", nullable: true, required: false });
    const anyOf = fieldFor("n", { anyOf: [{ type: "number" }, { type: "null" }] }, false);
    expect(anyOf).toMatchObject({ kind: "number", nullable: true });
  });

  it("maps arrays of strings to a list and arrays of flat objects to rows", () => {
    expect(byKey(formFields(schemaOf("email.received")), "from").kind).toBe("stringList");
    const cases = byKey(formFields(schemaOf("core.switch")), "cases");
    expect(cases.kind).toBe("objectList");
    if (cases.kind !== "objectList") return;
    expect(cases.fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["name", "string", true],
      ["when", "string", true],
    ]);
  });

  it("nests objects one level, then falls back to JSON", () => {
    const f = fieldFor(
      "smtp",
      {
        type: "object",
        properties: {
          host: { type: "string" },
          port: { type: "integer" },
          tls: { type: "object", properties: { verify: { type: "boolean" } } },
        },
        required: ["host"],
      },
      true,
    );
    expect(f.kind).toBe("object");
    if (f.kind !== "object") return;
    expect(f.fields.map((x) => [x.key, x.kind, x.required])).toEqual([
      ["host", "string", true],
      ["port", "number", false],
      ["tls", "json", false],
    ]);
  });

  it("maps constants and anyOf of constants to selects", () => {
    expect(fieldFor("k", { type: "string", const: "x" }, true)).toMatchObject({
      kind: "enum",
      options: [{ value: "x", label: "x" }],
    });
    const f = fieldFor("mode", { anyOf: [{ const: "a", title: "Alpha" }, { const: "b" }] }, true);
    expect(f).toMatchObject({
      kind: "enum",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "b" },
      ],
    });
  });

  it("falls back to JSON for unions", () => {
    expect(fieldFor("until", { type: ["string", "number"] }, false).kind).toBe("json");
  });

  it("uses title as the label when present", () => {
    expect(fieldFor("x", { type: "string", title: "Channel ID" }, false).label).toBe("Channel ID");
    expect(humanize("allowed_user_ids")).toBe("Allowed user ids");
    expect(humanize("approverUserIds")).toBe("Approver user ids");
  });

  it("doesn't mark fields with defaults as required", () => {
    const fields = formFields(schemaOf("discord.send_message"));
    expect(byKey(fields, "installationId").required).toBe(true);
    expect(byKey(fields, "approvalButtons").required).toBe(false);
  });

  it("reads connector schemas", () => {
    const discord = connectors[0];
    if (!discord) throw new Error("fixture");
    expect(formFields(discord.credentialsSchema).map((f) => [f.key, f.kind])).toEqual([
      ["botToken", "string"],
    ]);
    expect(formFields(discord.configSchema).map((f) => f.kind)).toEqual([
      "stringList",
      "stringList",
    ]);
  });
});

describe("defaults and values", () => {
  it("collects defaults", () => {
    expect(defaultsFor(schemaOf("http.request"))).toEqual({ method: "GET", timeoutMs: 10000 });
    expect(defaultsFor(schemaOf("core.switch"))).toEqual({ cases: [] });
  });

  it("copies default objects instead of sharing them", () => {
    const schema = schemaOf("core.switch");
    const a = defaultsFor(schema);
    const b = defaultsFor(schema);
    expect(a.cases).not.toBe(b.cases);
  });

  it("fills required nested objects", () => {
    expect(
      defaultsFor({
        type: "object",
        properties: {
          smtp: {
            type: "object",
            properties: { port: { type: "integer", default: 587 } },
          },
        },
        required: ["smtp"],
      }),
    ).toEqual({ smtp: { port: 587 } });
  });

  it("builds blank rows for object lists", () => {
    const cases = byKey(formFields(schemaOf("core.switch")), "cases");
    if (cases.kind !== "objectList") throw new Error("kind");
    expect(blankRow(cases.fields)).toEqual({ name: "", when: "" });
  });

  it("drops cleared optional fields and keeps required ones", () => {
    expect(setField({ a: "x", b: 1 }, { key: "a", required: false }, "")).toEqual({ b: 1 });
    expect(setField({ a: "x" }, { key: "a", required: true }, "")).toEqual({ a: "" });
    expect(setField({ a: "x" }, { key: "a", required: true }, undefined)).toEqual({});
  });
});

describe("engine widget hints", () => {
  it("maps jsonata fields to a JSONata editor", () => {
    const f = fieldFor("condition", { type: "string", widget: "jsonata" }, true);
    expect(f.kind).toBe("jsonata");
    expect(f.widget).toBe("jsonata");
  });

  it("keeps the workflow hint on a string field so the inspector can render a picker", () => {
    const f = fieldFor("workflowId", { type: "string", widget: "workflow" }, true);
    expect(f.kind).toBe("string");
    expect(f.widget).toBe("workflow");
  });
});
