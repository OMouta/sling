/**
 * Port types. A port type is a primitive, `list<T>`, or a named type from
 * NAMED_TYPES. Exec ports are separate and have no type.
 */

export const PRIMITIVE_TYPES = ["any", "string", "number", "boolean", "json"] as const;
export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

/** A JSON Schema fragment, used by the editor to list fields for expressions. */
export type JsonSchema = Record<string, unknown>;

export interface NamedType {
  name: string;
  description: string;
  schema: JsonSchema;
}

const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };
const nullableStr = { type: ["string", "null"] };
const address = {
  type: "object",
  properties: { name: nullableStr, address: str },
  required: ["address"],
};

export const NAMED_TYPES: Record<string, NamedType> = {
  email: {
    name: "email",
    description: "An email message",
    schema: {
      type: "object",
      properties: {
        id: str,
        messageId: nullableStr,
        folder: str,
        from: address,
        to: { type: "array", items: address },
        cc: { type: "array", items: address },
        subject: str,
        date: str,
        text: str,
        html: nullableStr,
        inReplyTo: nullableStr,
      },
      required: ["id", "folder", "from", "to", "subject", "date", "text"],
    },
  },
  "discord.message": {
    name: "discord.message",
    description: "A Discord message the bot received",
    schema: {
      type: "object",
      properties: {
        id: str,
        channelId: str,
        guildId: nullableStr,
        isDM: bool,
        author: {
          type: "object",
          properties: { id: str, username: str },
          required: ["id", "username"],
        },
        content: str,
        mentionsBot: bool,
        createdAt: str,
      },
      required: ["id", "channelId", "isDM", "author", "content"],
    },
  },
  "telegram.message": {
    name: "telegram.message",
    description: "A Telegram message the bot received",
    schema: {
      type: "object",
      properties: {
        id: str,
        chatId: str,
        chatType: str,
        chatName: str,
        from: {
          type: "object",
          properties: { id: str, username: nullableStr, name: str },
          required: ["id", "name"],
        },
        text: str,
        date: str,
      },
      required: ["id", "chatId", "chatType", "from", "text", "date"],
    },
  },
  conversation: {
    name: "conversation",
    description: "A Sling conversation",
    schema: {
      type: "object",
      properties: { id: str, key: nullableStr, mode: str, title: str },
      required: ["id", "mode"],
    },
  },
  task: {
    name: "task",
    description: "A Sling coding task and how it settled",
    schema: {
      type: "object",
      properties: {
        id: str,
        title: str,
        state: str,
        runnerName: str,
        repoName: str,
        branch: str,
        summary: nullableStr,
        error: nullableStr,
        settleReason: str,
        prUrl: nullableStr,
      },
      required: ["id", "title", "state"],
    },
  },
  approval: {
    name: "approval",
    description: "A pending approval",
    schema: {
      type: "object",
      properties: {
        id: str,
        kind: str,
        title: str,
        summary: str,
        expiresAt: str,
        url: str,
      },
      required: ["id", "kind", "title", "url"],
    },
  },
  "http.response": {
    name: "http.response",
    description: "An HTTP response",
    schema: {
      type: "object",
      properties: {
        status: num,
        ok: bool,
        headers: { type: "object" },
        body: {},
        durationMs: num,
      },
      required: ["status", "ok", "headers", "durationMs"],
    },
  },
};

export type PortType = string;

export type ParsedType =
  | { kind: "primitive"; name: PrimitiveType }
  | { kind: "named"; name: string }
  | { kind: "list"; of: ParsedType };

export function parseType(t: PortType): ParsedType | null {
  const list = /^list<(.+)>$/.exec(t);
  if (list?.[1]) {
    const inner = parseType(list[1]);
    return inner ? { kind: "list", of: inner } : null;
  }
  if ((PRIMITIVE_TYPES as readonly string[]).includes(t)) {
    return { kind: "primitive", name: t as PrimitiveType };
  }
  if (t in NAMED_TYPES) return { kind: "named", name: t };
  return null;
}

export function isKnownType(t: PortType): boolean {
  return parseType(t) !== null;
}

/**
 * Whether a value of type `from` may flow into a port of type `to`:
 * the same type, either side `any`, `json` as the target, or lists whose
 * element types are assignable.
 */
export function isAssignable(from: PortType, to: PortType): boolean {
  const a = parseType(from);
  const b = parseType(to);
  if (!a || !b) return false;
  return assignable(a, b);
}

function assignable(a: ParsedType, b: ParsedType): boolean {
  if (a.kind === "primitive" && a.name === "any") return true;
  if (b.kind === "primitive" && (b.name === "any" || b.name === "json")) return true;
  if (a.kind === "list" && b.kind === "list") return assignable(a.of, b.of);
  if (a.kind !== b.kind) return false;
  return a.kind !== "list" && b.kind !== "list" && a.name === b.name;
}
