import type {
  AssistantChoice,
  AssistantProvider,
  Harness,
  ModelCatalogView,
  ModelOption,
  ModelProviderId,
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
    queryFn: ({ signal }) => api.get<ModelCatalogView>("/api/models", { signal }),
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

export function providerModels(catalog: ModelCatalogView | undefined, provider: AssistantProvider) {
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
