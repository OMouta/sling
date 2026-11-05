import {
  AGENT_MODEL_PATTERN,
  type AgentChoice,
  type AssistantChoice,
  type ChatSettings,
  DEFAULT_HARNESS,
  EFFORT_PATTERN,
  HARNESSES,
  isHarness,
  MODEL_ID_PATTERN,
  MODEL_PROVIDER_IDS,
} from "@sling/core";
import { schema } from "@sling/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { defaultModelConfig } from "./models.ts";

export const AssistantChoiceSchema = z.object({
  provider: z.enum(MODEL_PROVIDER_IDS),
  model: z.string().regex(MODEL_ID_PATTERN),
  effort: z.string().regex(EFFORT_PATTERN).nullable().default(null),
  fast: z.boolean().default(false),
});

export const AgentChoiceSchema = z.object({
  harness: z.enum(HARNESSES),
  model: z.string().regex(AGENT_MODEL_PATTERN).nullable().default(null),
  effort: z.string().regex(EFFORT_PATTERN).nullable().default(null),
  fast: z.boolean().default(false),
});

/** A change to a conversation's (or the workspace's) choices. Omitted parts stay as they are. */
export const ChatSettingsPatch = z.object({
  assistant: AssistantChoiceSchema.nullable().optional(),
  agent: AgentChoiceSchema.nullable().optional(),
});

export function mergeSettings(
  current: ChatSettings | null | undefined,
  patch: z.infer<typeof ChatSettingsPatch>,
): ChatSettings {
  return {
    assistant: patch.assistant !== undefined ? patch.assistant : (current?.assistant ?? null),
    agent: patch.agent !== undefined ? patch.agent : (current?.agent ?? null),
  };
}

/** What a new conversation starts with. */
export async function chatDefaults(
  ctx: Pick<AppContext, "db">,
  workspaceId: string,
): Promise<{ assistant: AssistantChoice | null; agent: AgentChoice }> {
  const [ws] = await ctx.db
    .select({
      chatDefaults: schema.workspaces.chatDefaults,
      defaultHarness: schema.workspaces.defaultHarness,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId));
  let assistant = ws?.chatDefaults?.assistant ?? null;
  if (!assistant) {
    const cfg = await defaultModelConfig(ctx, workspaceId);
    if (cfg) assistant = { provider: cfg.provider, model: cfg.model, effort: null, fast: false };
  }
  const harness = isHarness(ws?.defaultHarness) ? ws.defaultHarness : DEFAULT_HARNESS;
  const agent = ws?.chatDefaults?.agent ?? { harness, model: null, effort: null, fast: false };
  return { assistant, agent };
}

/** The choices in effect for a conversation: its own, then the workspace defaults. */
export async function effectiveChat(
  ctx: Pick<AppContext, "db">,
  workspaceId: string,
  conversationId: string | null,
): Promise<{ assistant: AssistantChoice | null; agent: AgentChoice }> {
  const defaults = await chatDefaults(ctx, workspaceId);
  if (!conversationId) return defaults;
  const [conv] = await ctx.db
    .select({ settings: schema.conversations.settings })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, workspaceId),
      ),
    );
  return {
    assistant: conv?.settings?.assistant ?? defaults.assistant,
    agent: conv?.settings?.agent ?? defaults.agent,
  };
}
