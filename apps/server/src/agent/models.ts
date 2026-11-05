import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type AssistantChoice, isCliProvider } from "@sling/core";
import { type ModelProviderId, schema } from "@sling/db";
import type { LanguageModel } from "ai";
import { and, desc, eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { decryptSecret } from "../crypto.ts";

/**
 * Sling's own provider interface. The AI SDK does the heavy lifting, but
 * nothing outside this file imports a provider package directly.
 */
export interface ModelProvider {
  id: ModelProviderId;
  label: string;
  needsBaseUrl: boolean;
  defaultModel: string;
  create(options: { model: string; apiKey: string; baseUrl: string | null }): LanguageModel;
}

export const MODEL_PROVIDERS: Record<ModelProviderId, ModelProvider> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    needsBaseUrl: false,
    defaultModel: "gpt-5.1",
    create: ({ model, apiKey }) => createOpenAI({ apiKey })(model),
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    needsBaseUrl: false,
    defaultModel: "claude-sonnet-5-5",
    create: ({ model, apiKey }) => createAnthropic({ apiKey })(model),
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible (Ollama, OpenRouter, LM Studio)",
    needsBaseUrl: true,
    defaultModel: "llama3.3",
    create: ({ model, apiKey, baseUrl }) =>
      createOpenAICompatible({
        name: "custom",
        baseURL: baseUrl ?? "",
        apiKey,
        includeUsage: true,
      }).chatModel(model),
  },
};

/** Per-provider request options, as the AI SDK takes them. */
export type ProviderOptions = Record<string, Record<string, string | boolean>>;

export class NoModelConfigured extends Error {
  constructor(provider?: string) {
    super(
      provider
        ? `There's no ${provider} API key. Add one in Settings, or pick another model.`
        : "No model provider is configured. Add one in Settings.",
    );
  }
}

export async function defaultModelConfig(ctx: Pick<AppContext, "db">, workspaceId: string) {
  const [row] = await ctx.db
    .select()
    .from(schema.modelConfigs)
    .where(
      and(
        eq(schema.modelConfigs.workspaceId, workspaceId),
        eq(schema.modelConfigs.isDefault, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function providerConfig(
  ctx: Pick<AppContext, "db">,
  workspaceId: string,
  provider: ModelProviderId,
) {
  const [row] = await ctx.db
    .select()
    .from(schema.modelConfigs)
    .where(
      and(
        eq(schema.modelConfigs.workspaceId, workspaceId),
        eq(schema.modelConfigs.provider, provider),
      ),
    )
    .orderBy(desc(schema.modelConfigs.isDefault))
    .limit(1);
  return row ?? null;
}

type ConfigRow = NonNullable<Awaited<ReturnType<typeof defaultModelConfig>>>;

export async function apiKeyFor(
  ctx: Pick<AppContext, "db" | "secretsKey">,
  workspaceId: string,
  cfg: ConfigRow,
): Promise<string> {
  if (!cfg.credentialId) return "";
  const [cred] = await ctx.db
    .select()
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.id, cfg.credentialId),
        eq(schema.credentials.workspaceId, workspaceId),
      ),
    );
  return cred ? decryptSecret(ctx.secretsKey, cred.ciphertext) : "";
}

/**
 * The workspace's default model. `modelName` swaps the model while keeping
 * the provider and its key, for nodes that ask for a different one.
 */
export async function resolveModel(
  ctx: AppContext,
  workspaceId: string,
  modelName?: string,
): Promise<LanguageModel> {
  const cfg = await defaultModelConfig(ctx, workspaceId);
  if (!cfg) throw new NoModelConfigured();
  return MODEL_PROVIDERS[cfg.provider].create({
    model: modelName?.trim() || cfg.model,
    apiKey: await apiKeyFor(ctx, workspaceId, cfg),
    baseUrl: cfg.baseUrl,
  });
}

/**
 * The assistant's model for a conversation, with its effort level and fast
 * tier as provider options. Null uses the workspace's default model.
 */
export async function resolveAssistant(
  ctx: AppContext,
  workspaceId: string,
  choice: AssistantChoice | null,
): Promise<{ model: LanguageModel; providerOptions: ProviderOptions }> {
  if (!choice) return { model: await resolveModel(ctx, workspaceId), providerOptions: {} };
  const provider = choice.provider;
  if (isCliProvider(provider))
    throw new Error(`${provider} runs on a machine, not through an API.`);
  const cfg = await providerConfig(ctx, workspaceId, provider);
  if (!cfg) throw new NoModelConfigured(MODEL_PROVIDERS[provider].label);
  const model = MODEL_PROVIDERS[provider].create({
    model: choice.model,
    apiKey: await apiKeyFor(ctx, workspaceId, cfg),
    baseUrl: cfg.baseUrl,
  });
  return { model, providerOptions: providerOptionsFor(choice) };
}

export function providerOptionsFor(choice: AssistantChoice): ProviderOptions {
  const { effort, fast } = choice;
  switch (choice.provider) {
    case "openai":
      return {
        openai: {
          ...(effort ? { reasoningEffort: effort } : {}),
          ...(fast ? { serviceTier: "priority" } : {}),
        },
      };
    case "anthropic":
      return {
        anthropic: {
          ...(effort ? { effort } : {}),
          ...(fast ? { speed: "fast" } : {}),
        },
      };
    default:
      return {};
  }
}
