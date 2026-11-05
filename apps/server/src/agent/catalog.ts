import {
  type AgentModelsView,
  HARNESS_LABELS,
  HARNESSES,
  harnessCapability,
  MODEL_ID_PATTERN,
  type ModelCatalogView,
  type ModelOption,
  type ModelProviderId,
  type ProviderModelsView,
} from "@sling/core";
import { schema } from "@sling/db";
import { and, eq, isNull } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { chatDefaults } from "./chat-settings.ts";
import { apiKeyFor, MODEL_PROVIDERS, providerConfig } from "./models.ts";

/**
 * Which models each provider offers, from the provider's own model list, so
 * nobody types a model name. Lists are cached for a few minutes per key.
 */

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; models: ModelOption[] }>();

export function clearModelCache(workspaceId: string) {
  for (const key of cache.keys()) if (key.startsWith(`${workspaceId}:`)) cache.delete(key);
}

interface Listed {
  id: string;
  label?: string;
  created?: number;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = body.match(/"message"\s*:\s*"([^"]{1,200})"/)?.[1];
    throw new Error(detail ? `${res.status}: ${detail}` : `The provider answered ${res.status}.`);
  }
  return res.json();
}

function listedFrom(data: unknown): Listed[] {
  const rows = (data as { data?: unknown[] })?.data;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => {
    const o = r as {
      id?: unknown;
      display_name?: unknown;
      created?: unknown;
      created_at?: unknown;
    };
    if (typeof o.id !== "string" || !MODEL_ID_PATTERN.test(o.id)) return [];
    const created =
      typeof o.created === "number"
        ? o.created * 1000
        : typeof o.created_at === "string"
          ? Date.parse(o.created_at)
          : undefined;
    return [
      {
        id: o.id,
        ...(typeof o.display_name === "string" ? { label: o.display_name } : {}),
        ...(created !== undefined && Number.isFinite(created) ? { created } : {}),
      },
    ];
  });
}

const OPENAI_SKIP =
  /(audio|realtime|tts|transcribe|whisper|dall-e|image|embedding|moderation|search|instruct|babbage|davinci|computer-use|-\d{4}-\d{2}-\d{2}$)/;

/** Models on an OpenAI-style server that can't chat: embeddings, rerankers, speech. */
const NOT_CHAT = /(embed|rerank|whisper|tts|transcrib|moderation|bge-|e5-)/i;

export function isChatModel(id: string): boolean {
  return !NOT_CHAT.test(id);
}

/** OpenAI's reasoning models take an effort level and the priority tier. */
export function openaiMeta(id: string): Omit<ModelOption, "id" | "label" | "description"> {
  const reasoning = /^(o\d|gpt-5|gpt-6)/.test(id);
  return {
    efforts: reasoning ? ["low", "medium", "high"] : [],
    defaultEffort: reasoning ? "medium" : null,
    fast: reasoning,
  };
}

export function openaiLabel(id: string): string {
  return id.replace(/^gpt-/, "GPT-").replace(/^chatgpt-/, "ChatGPT-");
}

/** Effort levels and fast mode by Claude model family. */
export function anthropicMeta(id: string): Omit<ModelOption, "id" | "label" | "description"> {
  let efforts: string[] = [];
  if (/^claude-(fable|mythos)-/.test(id) || /^claude-(opus|sonnet|haiku)-5/.test(id)) {
    efforts = ["low", "medium", "high", "xhigh", "max"];
  } else if (/^claude-opus-4-[78]/.test(id)) {
    efforts = ["low", "medium", "high", "xhigh", "max"];
  } else if (/^claude-(opus|sonnet)-4-6/.test(id)) {
    efforts = ["low", "medium", "high", "max"];
  } else if (/^claude-opus-4-5/.test(id)) {
    efforts = ["low", "medium", "high"];
  }
  const mediumDefault = /^claude-(opus-5-5|haiku-5-5)/.test(id);
  return {
    efforts,
    defaultEffort: efforts.length ? (mediumDefault ? "medium" : "high") : null,
    fast: /^claude-opus-(5-5|5|4-8)$/.test(id),
  };
}

async function listModels(
  provider: ModelProviderId,
  apiKey: string,
  baseUrl: string | null,
): Promise<ModelOption[]> {
  if (provider === "openai") {
    const listed = listedFrom(
      await fetchJson("https://api.openai.com/v1/models", { authorization: `Bearer ${apiKey}` }),
    );
    return listed
      .filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !OPENAI_SKIP.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({ id: m.id, label: openaiLabel(m.id), description: "", ...openaiMeta(m.id) }));
  }
  if (provider === "anthropic") {
    const listed = listedFrom(
      await fetchJson("https://api.anthropic.com/v1/models?limit=100", {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      }),
    );
    return listed
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({
        id: m.id,
        label: m.label ?? m.id,
        description: "",
        ...anthropicMeta(m.id),
      }));
  }
  if (!baseUrl) return [];
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const listed = listedFrom(
    await fetchJson(url, apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  );
  return listed
    .filter((m) => isChatModel(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      description: "",
      efforts: [],
      defaultEffort: null,
      fast: false,
    }));
}

async function providerModels(
  ctx: AppContext,
  workspaceId: string,
  provider: ModelProviderId,
): Promise<ProviderModelsView> {
  const info = MODEL_PROVIDERS[provider];
  const base = { provider, label: info.label };
  const cfg = await providerConfig(ctx, workspaceId, provider);
  const connected = Boolean(
    cfg && (cfg.credentialId || (provider === "openai-compatible" && cfg.baseUrl)),
  );
  if (!cfg || !connected) return { ...base, connected: false, error: null, models: [] };
  const key = `${workspaceId}:${provider}:${cfg.credentialId ?? ""}:${cfg.baseUrl ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { ...base, connected, error: null, models: hit.models };
  }
  try {
    const models = await listModels(provider, await apiKeyFor(ctx, workspaceId, cfg), cfg.baseUrl);
    cache.set(key, { at: Date.now(), models });
    return { ...base, connected, error: null, models };
  } catch (err) {
    // The stored default model still works, so offer it even when the list doesn't load.
    const fallback = cfg.model
      ? [
          {
            id: cfg.model,
            label: provider === "openai" ? openaiLabel(cfg.model) : cfg.model,
            description: "",
            ...(provider === "anthropic"
              ? anthropicMeta(cfg.model)
              : provider === "openai"
                ? openaiMeta(cfg.model)
                : { efforts: [], defaultEffort: null, fast: false }),
          },
        ]
      : [];
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, connected, error: `Couldn't load models: ${message}`, models: fallback };
  }
}

async function agentModels(ctx: AppContext, workspaceId: string): Promise<AgentModelsView[]> {
  const runners = await ctx.db
    .select({ capabilities: schema.runners.capabilities, online: schema.runners.online })
    .from(schema.runners)
    .where(
      and(
        eq(schema.runners.workspaceId, workspaceId),
        eq(schema.runners.ephemeral, false),
        isNull(schema.runners.revokedAt),
      ),
    );
  return HARNESSES.map((harness) => {
    const name = harnessCapability(harness);
    const byId = new Map<string, ModelOption>();
    const defaults = new Set<string>();
    let readyMachines = 0;
    for (const r of runners) {
      const cap = r.capabilities.find((c) => c.name === name);
      if (!cap) continue;
      if (cap.ready) readyMachines++;
      for (const m of cap.models ?? []) {
        if (m.isDefault) defaults.add(m.id);
        if (byId.has(m.id)) continue;
        byId.set(m.id, {
          id: m.id,
          label: m.displayName || m.id,
          description: m.description,
          efforts: m.efforts,
          defaultEffort: m.defaultEffort || null,
          fast: m.fast,
        });
      }
    }
    return {
      harness,
      label: HARNESS_LABELS[harness],
      readyMachines,
      defaultModel: defaults.size === 1 ? ([...defaults][0] ?? null) : null,
      models: [...byId.values()],
    };
  });
}

export async function modelCatalog(
  ctx: AppContext,
  workspaceId: string,
): Promise<ModelCatalogView> {
  const providers = Object.keys(MODEL_PROVIDERS) as ModelProviderId[];
  const [assistant, agents, defaults] = await Promise.all([
    Promise.all(providers.map((p) => providerModels(ctx, workspaceId, p))),
    agentModels(ctx, workspaceId),
    chatDefaults(ctx, workspaceId),
  ]);
  return { assistant, agents, defaults };
}
