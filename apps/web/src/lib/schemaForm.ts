/**
 * Maps a JSON Schema object (as zod's `toJSONSchema` writes it) to form
 * fields. Pure, so the mapping can be tested without a DOM. Anything the form
 * can't render as a control falls back to a JSON editor.
 */

export type Schema = Record<string, unknown>;

export type Primitive = string | number | boolean;

/** How a field shows in a setup form, from the schema's own keys (zod `.meta()`). */
export interface FieldMeta {
  placeholder: string | null;
  /** Kept under "More settings" unless it has to be filled in. */
  advanced: boolean;
  /** Changing it runs the connector's setup lookup again. */
  lookup: boolean;
  /** Shown only while each of these fields has one of the values. */
  showWhen: Record<string, Primitive[]> | null;
  /** Hidden until the setup lookup offers choices for it. */
  picker: boolean;
  /** Nothing picked means everything. */
  emptyMeansAll: boolean;
  /** A picker that also takes a typed value. */
  allowOther: boolean;
  order: number | null;
}

interface FieldBase {
  key: string;
  label: string;
  description: string | null;
  required: boolean;
  /** `null` is also allowed. */
  nullable: boolean;
  default: unknown;
  /** The schema's `widget` hint, for callers that render special pickers. */
  widget: string | null;
  meta: FieldMeta;
}

export type FormField = FieldBase &
  (
    | { kind: "string"; minLength?: number; maxLength?: number; format?: string }
    | { kind: "textarea" }
    | { kind: "jsonata" }
    | { kind: "json" }
    | { kind: "number"; integer: boolean; min?: number; max?: number }
    | { kind: "boolean" }
    | { kind: "enum"; options: { value: Primitive; label: string }[] }
    | { kind: "stringList" }
    | { kind: "objectList"; fields: FormField[] }
    | { kind: "object"; fields: FormField[] }
  );

export type FieldKind = FormField["kind"];

/** Keys whose plain wording reads better than the field name. */
const KEY_LABELS: Record<string, string> = {
  installationId: "Account",
  providerInstallationId: "Sandbox provider",
};

/** "timeoutMs" → "Timeout ms", "allowed_user_ids" → "Allowed user ids". */
export function humanize(key: string): string {
  const known = KEY_LABELS[key];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function asSchema(v: unknown): Schema {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Schema) : {};
}

/** Types a schema allows, with `null` reported separately. */
function typesOf(s: Schema): { types: string[]; nullable: boolean } {
  const t = s.type;
  const list = Array.isArray(t) ? t.map(String) : typeof t === "string" ? [t] : [];
  return { types: list.filter((x) => x !== "null"), nullable: list.includes("null") };
}

/**
 * Unwraps `anyOf: [X, { type: "null" }]` and `type: [X, "null"]` into X plus a
 * nullable flag, and `anyOf` of constants into an enum.
 */
function normalize(input: Schema): { schema: Schema; nullable: boolean } {
  const variants = (input.anyOf ?? input.oneOf) as unknown;
  if (Array.isArray(variants)) {
    const all = variants.map(asSchema);
    const nonNull = all.filter((v) => v.type !== "null");
    const nullable = nonNull.length < all.length;
    if (nonNull.length === 1) {
      const { anyOf: _a, oneOf: _o, ...rest } = input;
      const inner = normalize({ ...rest, ...nonNull[0] });
      return { schema: inner.schema, nullable: nullable || inner.nullable };
    }
    if (nonNull.length > 1 && nonNull.every((v) => "const" in v)) {
      const { anyOf: _a, oneOf: _o, ...rest } = input;
      return {
        schema: {
          ...rest,
          enum: nonNull.map((v) => v.const),
          enumLabels: nonNull.map((v) => (typeof v.title === "string" ? v.title : null)),
        },
        nullable,
      };
    }
    return { schema: input, nullable };
  }
  const { types, nullable } = typesOf(input);
  if (nullable && types.length === 1) return { schema: { ...input, type: types[0] }, nullable };
  return { schema: input, nullable };
}

function isPrimitive(v: unknown): v is Primitive {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function showWhenOf(v: unknown): Record<string, Primitive[]> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, Primitive[]> = {};
  for (const [k, raw] of Object.entries(v)) {
    const list = (Array.isArray(raw) ? raw : [raw]).filter(isPrimitive);
    if (list.length > 0) out[k] = list;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function metaOf(s: Schema): FieldMeta {
  return {
    placeholder: typeof s.placeholder === "string" ? s.placeholder : null,
    advanced: s.advanced === true,
    lookup: s.lookup === true,
    showWhen: showWhenOf(s.showWhen),
    picker: s.picker === true,
    emptyMeansAll: s.emptyMeansAll === true,
    allowOther: s.allowOther === true,
    order: typeof s.order === "number" ? s.order : null,
  };
}

/** Map one property to a field. `depth` is 0 at the top level of the form. */
export function fieldFor(key: string, raw: Schema, required: boolean, depth = 0): FormField {
  const { schema, nullable } = normalize(raw);
  const base: FieldBase = {
    key,
    label: typeof schema.title === "string" ? schema.title : humanize(key),
    description: typeof schema.description === "string" ? schema.description : null,
    // zod lists fields with defaults as required; they can't be missing, so no marker.
    required: required && schema.default === undefined,
    nullable,
    default: schema.default,
    widget: typeof schema.widget === "string" ? schema.widget : null,
    meta: metaOf(schema),
  };
  const widget = schema.widget;
  if (widget === "json") return { ...base, kind: "json" };

  const enumValues = Array.isArray(schema.enum)
    ? schema.enum
    : "const" in schema
      ? [schema.const]
      : null;
  if (enumValues?.every(isPrimitive)) {
    const labels = Array.isArray(schema.enumLabels) ? schema.enumLabels : [];
    return {
      ...base,
      kind: "enum",
      options: enumValues.map((value, i) => ({
        value,
        label: typeof labels[i] === "string" ? (labels[i] as string) : String(value),
      })),
    };
  }

  const { types } = typesOf(schema);
  if (types.length !== 1) return { ...base, kind: "json" };
  const type = types[0];

  switch (type) {
    case "string":
      if (widget === "textarea") return { ...base, kind: "textarea" };
      if (widget === "jsonata") return { ...base, kind: "jsonata" };
      return {
        ...base,
        kind: "string",
        ...(typeof schema.minLength === "number" ? { minLength: schema.minLength } : {}),
        ...(typeof schema.maxLength === "number" ? { maxLength: schema.maxLength } : {}),
        ...(typeof schema.format === "string" ? { format: schema.format } : {}),
      };
    case "number":
    case "integer":
      return {
        ...base,
        kind: "number",
        integer: type === "integer",
        ...(typeof schema.minimum === "number" ? { min: schema.minimum } : {}),
        ...(typeof schema.maximum === "number" ? { max: schema.maximum } : {}),
      };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "array": {
      const items = normalize(asSchema(schema.items)).schema;
      const itemTypes = typesOf(items).types;
      if (itemTypes.length === 1 && itemTypes[0] === "string" && !Array.isArray(items.enum)) {
        return { ...base, kind: "stringList" };
      }
      if (itemTypes.length === 1 && itemTypes[0] === "object" && depth === 0) {
        const sub = objectFields(items, depth + 1);
        if (sub && sub.length > 0 && sub.every((f) => isScalarKind(f.kind))) {
          return { ...base, kind: "objectList", fields: sub };
        }
      }
      return { ...base, kind: "json" };
    }
    case "object": {
      if (depth === 0) {
        const sub = objectFields(schema, depth + 1);
        if (sub && sub.length > 0) return { ...base, kind: "object", fields: sub };
      }
      return { ...base, kind: "json" };
    }
    default:
      return { ...base, kind: "json" };
  }
}

function isScalarKind(kind: FieldKind): boolean {
  return kind === "string" || kind === "number" || kind === "boolean" || kind === "enum";
}

/** Fields of an object schema with fixed properties, or null for a map. */
function objectFields(schema: Schema, depth: number): FormField[] | null {
  const props = asSchema(schema.properties);
  const keys = Object.keys(props);
  if (keys.length === 0) return null;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return keys.map((k) => fieldFor(k, asSchema(props[k]), required.has(k), depth));
}

/** Top-level fields of an object schema. */
export function formFields(schema: Schema): FormField[] {
  return objectFields(normalize(schema).schema, 0) ?? [];
}

/**
 * Initial values from schema defaults. Required nested objects get their own
 * defaults filled in so their fields start valid.
 */
export function defaultsFor(schema: Schema): Record<string, unknown> {
  const s = normalize(schema).schema;
  const props = asSchema(s.properties);
  const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(props)) {
    const prop = normalize(asSchema(raw)).schema;
    if (prop.default !== undefined) {
      out[key] = structuredClone(prop.default);
    } else if (required.has(key) && typesOf(prop).types[0] === "object" && prop.properties) {
      out[key] = defaultsFor(prop);
    }
  }
  return out;
}

/** A blank row for an object list, from the item fields' defaults. */
export function blankRow(fields: FormField[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.default !== undefined) row[f.key] = structuredClone(f.default);
    else if (f.kind === "string") row[f.key] = "";
    else if (f.kind === "boolean" && f.required) row[f.key] = false;
    else if (f.kind === "enum" && f.required && f.options[0]) row[f.key] = f.options[0].value;
  }
  return row;
}

/**
 * Sets `key` in a config object, dropping it when the value is empty and the
 * field is optional, so blank optional fields don't reach the server as "".
 */
export function setField(
  value: Record<string, unknown>,
  field: Pick<FormField, "key" | "required">,
  next: unknown,
): Record<string, unknown> {
  const copy = { ...value };
  if (next === undefined || (!field.required && next === "")) delete copy[field.key];
  else copy[field.key] = next;
  return copy;
}

/** Keys of required fields that have no value. */
export function missingRequired(fields: FormField[], value: Record<string, unknown>): string[] {
  return fields
    .filter((f) => f.required && f.kind !== "boolean")
    .filter((f) => {
      const v = value[f.key];
      return v === undefined || v === null || v === "";
    })
    .map((f) => f.key);
}
