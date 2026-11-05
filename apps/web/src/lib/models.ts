import {
  type AgentChoice,
  type AssistantChoice,
  effortLabel,
  type Harness,
  type ModelCatalogView,
  type ModelOption,
  type ModelProviderId,
} from "@sling/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api } from "./api.ts";

export const modelsKey = ["models"] as const;

/** The column chats and the composer share. Wide, with a cap for reading. */
export const CHAT_WIDTH = "max-w-[920px]";

export function useModelCatalog() {
  return useQuery({
    queryKey: modelsKey,
    queryFn: () => api.get<ModelCatalogView>("/api/models"),
    staleTime: 5 * 60_000,
  });
}

/** Saves a provider's key and refreshes the catalog with its models. */
export function useSaveProviderKey() {
  const qc = useQueryClient();
  return async (provider: ModelProviderId, body: { apiKey?: string; baseUrl?: string | null }) => {
    const catalog = await api.put<ModelCatalogView>(`/api/settings/providers/${provider}`, body);
    qc.setQueryData(modelsKey, catalog);
    void qc.invalidateQueries({ queryKey: ["settings"] });
    return catalog;
  };
}

export function providerModels(catalog: ModelCatalogView | undefined, provider: ModelProviderId) {
  return catalog?.assistant.find((p) => p.provider === provider);
}

export function agentModels(catalog: ModelCatalogView | undefined, harness: Harness) {
  return catalog?.agents.find((a) => a.harness === harness);
}

/** "Claude Opus 5.5" reads as "Opus 5.5" in a pill. */
export function shortLabel(label: string): string {
  return label.replace(/^Claude\s+/i, "");
}

export function findAssistantModel(
  catalog: ModelCatalogView | undefined,
  choice: AssistantChoice | null,
): ModelOption | undefined {
  if (!choice) return undefined;
  return providerModels(catalog, choice.provider)?.models.find((m) => m.id === choice.model);
}

export function findAgentModel(
  catalog: ModelCatalogView | undefined,
  choice: AgentChoice,
): ModelOption | undefined {
  if (!choice.model) return undefined;
  return agentModels(catalog, choice.harness)?.models.find((m) => m.id === choice.model);
}

/** What the assistant pill says: the model, then its effort, if one is set. */
export function assistantSummary(
  catalog: ModelCatalogView | undefined,
  choice: AssistantChoice | null,
): { model: string; effort: string | null } {
  if (!choice) return { model: "Pick a model", effort: null };
  const m = findAssistantModel(catalog, choice);
  return {
    model: shortLabel(m?.label ?? choice.model),
    effort: choice.effort ? effortLabel(choice.effort) : null,
  };
}

export function agentSummary(
  catalog: ModelCatalogView | undefined,
  choice: AgentChoice,
): { agent: string; model: string; effort: string | null } {
  const a = agentModels(catalog, choice.harness);
  const m = findAgentModel(catalog, choice);
  return {
    agent: a?.label ?? choice.harness,
    model: choice.model ? (m?.label ?? choice.model) : "Default",
    effort: choice.effort ? effortLabel(choice.effort) : null,
  };
}

/** Picking another model keeps the effort and fast tier only where the new model has them. */
export function withModel<T extends { effort: string | null; fast: boolean }>(
  choice: T,
  model: ModelOption | undefined,
): T {
  return {
    ...choice,
    effort: model && choice.effort && model.efforts.includes(choice.effort) ? choice.effort : null,
    fast: Boolean(model?.fast && choice.fast),
  };
}

// ------------------------------------------------------------- favorites

const FAVORITES_KEY = "sling.favoriteModels";
const listeners = new Set<() => void>();
let cached: string[] | null = null;

function readFavorites(): string[] {
  if (cached) return cached;
  try {
    const v = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    cached = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    cached = [];
  }
  return cached;
}

/** A favorite is `assistant:<provider>:<model>` or `agent:<harness>:<model>`. */
export function favoriteKey(kind: "assistant" | "agent", owner: string, model: string): string {
  return `${kind}:${owner}:${model}`;
}

export function toggleFavorite(key: string) {
  const list = readFavorites();
  cached = list.includes(key) ? list.filter((k) => k !== key) : [...list, key].slice(-9);
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(cached));
  } catch {
    // Not persisted; still applies for this tab.
  }
  for (const l of listeners) l();
}

export function useFavorites(): string[] {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, readFavorites);
}
