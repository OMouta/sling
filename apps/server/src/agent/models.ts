import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type ModelProviderId, schema } from "@sling/db";
import type { LanguageModel } from "ai";
import { and, eq } from "drizzle-orm";
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

export class NoModelConfigured extends Error {
  constructor() {
    super("No model provider is configured. Add one in Settings.");
  }
}

export async function defaultModelConfig(ctx: AppContext, workspaceId: string) {
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

export async function resolveModel(ctx: AppContext, workspaceId: string): Promise<LanguageModel> {
  const cfg = await defaultModelConfig(ctx, workspaceId);
  if (!cfg) throw new NoModelConfigured();
  let apiKey = "";
  if (cfg.credentialId) {
    const [cred] = await ctx.db
      .select()
      .from(schema.credentials)
      .where(
        and(
          eq(schema.credentials.id, cfg.credentialId),
          eq(schema.credentials.workspaceId, workspaceId),
        ),
      );
    if (cred) apiKey = decryptSecret(ctx.secretsKey, cred.ciphertext);
  }
  return MODEL_PROVIDERS[cfg.provider].create({ model: cfg.model, apiKey, baseUrl: cfg.baseUrl });
}
