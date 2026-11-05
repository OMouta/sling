import type { Harness } from "./harness.ts";

/** Providers the assistant can run on. */
export const MODEL_PROVIDER_IDS = ["openai", "anthropic", "openai-compatible"] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return typeof value === "string" && (MODEL_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Reasoning effort names, lowest first. Each model takes a subset. */
export const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** What a model ID or effort may look like. The values reach CLI flags and config overrides. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@-]{1,128}$/;
export const AGENT_MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
export const EFFORT_PATTERN = /^[a-z]{2,16}$/;

/** The assistant's model for a conversation. */
export interface AssistantChoice {
  provider: ModelProviderId;
  model: string;
  /** Null takes the model's default. */
  effort: string | null;
  /** The provider's faster, pricier tier, where the model has one. */
  fast: boolean;
}

/** The coding agent, and its model, for tasks a conversation starts. */
export interface AgentChoice {
  harness: Harness;
  /** Null takes the agent's own default on each machine. */
  model: string | null;
  effort: string | null;
  fast: boolean;
}

/** Per-conversation choices. Null parts fall back to the workspace defaults. */
export interface ChatSettings {
  assistant: AssistantChoice | null;
  agent: AgentChoice | null;
}

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  /** Effort levels the model takes, lowest first. Empty when it has none. */
  efforts: string[];
  defaultEffort: string | null;
  fast: boolean;
}

export interface ProviderModelsView {
  provider: ModelProviderId;
  label: string;
  /** An API key (or base URL) is stored. */
  connected: boolean;
  /** Why the model list couldn't be fetched, when it couldn't. */
  error: string | null;
  models: ModelOption[];
}

export interface AgentModelsView {
  harness: Harness;
  label: string;
  /** Machines where the agent is installed and logged in. */
  readyMachines: number;
  /** The model the agent uses when none is picked, if the machines agree on one. */
  defaultModel: string | null;
  models: ModelOption[];
}

/** GET /api/models */
export interface ModelCatalogView {
  assistant: ProviderModelsView[];
  agents: AgentModelsView[];
  /** What a new conversation starts with. */
  defaults: { assistant: AssistantChoice | null; agent: AgentChoice };
}
