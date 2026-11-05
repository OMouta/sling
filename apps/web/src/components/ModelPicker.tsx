import {
  type AgentChoice,
  type AssistantChoice,
  effortLabel,
  HARNESS_LABELS,
  type Harness,
  MODE_POLICY,
  type ModelCatalogView,
  type ModelOption,
  type ModelProviderId,
  PERMISSION_MODES,
  type PermissionMode,
} from "@sling/core";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Search,
  Shield,
  ShieldAlert,
  Star,
  Zap,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  agentModels,
  agentSummary,
  assistantSummary,
  favoriteKey,
  findAgentModel,
  findAssistantModel,
  providerModels,
  shortLabel,
  toggleFavorite,
  useFavorites,
  useSaveProviderKey,
  withModel,
} from "../lib/models.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { Button, cx, ErrorText, Input, Kbd, Menu, MenuItem, Spinner } from "./ui.tsx";

type Rail = "favorites" | `a:${ModelProviderId}` | `g:${Harness}`;
type Kind = "assistant" | "agent";

interface Row {
  key: string;
  kind: Kind;
  owner: ModelProviderId | Harness;
  model: ModelOption | null;
  label: string;
  hint?: string;
}

export interface PickerProps {
  catalog: ModelCatalogView | undefined;
  assistant: AssistantChoice | null;
  agent: AgentChoice;
  onAssistant: (choice: AssistantChoice) => void;
  onAgent: (choice: AgentChoice) => void;
  mode?: PermissionMode;
  onMode?: (mode: PermissionMode) => void;
}

/**
 * The pills under a composer: the assistant's model, the coding agent, and
 * the permission mode. Each opens the picker on its own section.
 */
export function ChatControls(props: PickerProps & { className?: string }) {
  const [open, setOpen] = useState<Kind | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const a = assistantSummary(props.catalog, props.assistant);
  const g = agentSummary(props.catalog, props.agent);
  const pill =
    "pressable flex h-[26px] min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-xs text-soft transition-colors duration-150 hover:bg-surface-3 hover:text-text aria-expanded:bg-surface-3 aria-expanded:text-text";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div
      ref={root}
      className={cx("relative flex min-w-0 flex-wrap items-center gap-0.5", props.className)}
    >
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open === "assistant"}
        aria-label={`Assistant model: ${a.model}${a.effort ? `, ${a.effort}` : ""}`}
        title="The assistant you chat with"
        onClick={() => setOpen(open === "assistant" ? null : "assistant")}
        className={pill}
      >
        {props.assistant && <ProviderIcon provider={props.assistant.provider} size={13} />}
        <span className="truncate font-medium text-text">{a.model}</span>
        {a.effort && <span className="text-subtle">{a.effort}</span>}
        {props.assistant?.fast && <Zap aria-label="Fast" size={12} className="text-warn" />}
        <ChevronDown aria-hidden="true" size={12} className="text-faint" />
      </button>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open === "agent"}
        aria-label={`Coding agent: ${g.agent}, ${g.model}`}
        title="The coding agent for tasks this chat starts"
        onClick={() => setOpen(open === "agent" ? null : "agent")}
        className={pill}
      >
        <ProviderIcon provider={props.agent.harness} size={13} />
        <span className="font-medium text-text">{g.agent}</span>
        <span className="truncate text-subtle">
          {g.model}
          {g.effort ? ` · ${g.effort}` : ""}
        </span>
        {props.agent.fast && <Zap aria-label="Fast" size={12} className="text-warn" />}
        <ChevronDown aria-hidden="true" size={12} className="text-faint" />
      </button>
      {props.mode && props.onMode && <ModeMenu mode={props.mode} onMode={props.onMode} />}
      {open && <ModelPicker {...props} section={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ModeMenu({
  mode,
  onMode,
  side = "top",
  align = "start",
}: {
  mode: PermissionMode;
  onMode: (mode: PermissionMode) => void;
  side?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const Icon = mode === "full-access" ? ShieldAlert : Shield;
  return (
    <Menu
      label="Permission mode"
      side={side}
      align={align}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Permission mode: ${MODE_POLICY[mode].label}`}
          onClick={toggle}
          className={cx(
            "pressable flex h-[26px] cursor-pointer items-center gap-1.5 rounded-full px-2 text-xs transition-colors duration-150 hover:bg-surface-3",
            mode === "full-access" ? "text-danger" : "text-soft hover:text-text",
          )}
        >
          <Icon aria-hidden="true" size={13} />
          {MODE_POLICY[mode].label}
          {side === "top" ? (
            <ChevronUp aria-hidden="true" size={12} className="text-faint" />
          ) : (
            <ChevronDown aria-hidden="true" size={12} className="text-faint" />
          )}
        </button>
      )}
    >
      {PERMISSION_MODES.map((m) => (
        <MenuItem
          key={m}
          icon={m === "full-access" ? ShieldAlert : Shield}
          danger={m === "full-access"}
          onSelect={() => onMode(m)}
          trailing={m === mode ? <Check aria-hidden="true" className="text-text" /> : null}
        >
          <span className="block">{MODE_POLICY[m].label}</span>
        </MenuItem>
      ))}
    </Menu>
  );
}

const ASSISTANT_RAIL: ModelProviderId[] = ["openai", "anthropic", "openai-compatible"];
const AGENT_RAIL: Harness[] = ["codex", "claude-code"];

export function ModelPicker({
  catalog,
  assistant,
  agent,
  onAssistant,
  onAgent,
  mode,
  onMode,
  section,
  onClose,
}: PickerProps & { section: Kind; onClose: () => void }) {
  const [rail, setRail] = useState<Rail>(() =>
    section === "agent" ? `g:${agent.harness}` : `a:${assistant?.provider ?? "anthropic"}`,
  );
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const favorites = useFavorites();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const kind: Kind = rail === "favorites" ? section : rail.startsWith("g:") ? "agent" : "assistant";

  useEffect(() => {
    search.current?.focus({ preventScroll: true });
  }, []);

  const { rows, all } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (r: Row) =>
      !q || r.label.toLowerCase().includes(q) || (r.model?.id.toLowerCase().includes(q) ?? false);
    const assistantRows = (p: ModelProviderId): Row[] =>
      (providerModels(catalog, p)?.models ?? []).map((m) => ({
        key: favoriteKey("assistant", p, m.id),
        kind: "assistant",
        owner: p,
        model: m,
        label: m.label,
      }));
    const agentRows = (h: Harness): Row[] => [
      {
        key: favoriteKey("agent", h, ""),
        kind: "agent",
        owner: h,
        model: null,
        label: `${HARNESS_LABELS[h]} default`,
        hint: "What each machine has set",
      },
      ...(agentModels(catalog, h)?.models ?? []).map((m) => ({
        key: favoriteKey("agent", h, m.id),
        kind: "agent" as const,
        owner: h,
        model: m,
        label: m.label,
        ...(m.description ? { hint: m.description } : {}),
      })),
    ];
    const all: Row[] = [...ASSISTANT_RAIL.flatMap(assistantRows), ...AGENT_RAIL.flatMap(agentRows)];
    let rows: Row[];
    if (rail === "favorites") {
      rows = favorites.flatMap((k) => all.filter((r) => r.key === k)).filter(match);
    } else if (rail.startsWith("a:")) {
      rows = assistantRows(rail.slice(2) as ModelProviderId).filter(match);
    } else {
      rows = agentRows(rail.slice(2) as Harness).filter(match);
    }
    return { rows, all };
  }, [catalog, rail, query, favorites]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the cursor when the list changes.
  useEffect(() => setCursor(0), [rail, query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const isSelected = (r: Row) =>
    r.kind === "assistant"
      ? assistant?.provider === r.owner && assistant.model === r.model?.id
      : agent.harness === r.owner && (agent.model ?? null) === (r.model?.id ?? null);

  function pick(r: Row) {
    if (r.kind === "assistant" && r.model) {
      const base = assistant ?? {
        provider: r.owner as ModelProviderId,
        model: "",
        effort: null,
        fast: false,
      };
      onAssistant(
        withModel({ ...base, provider: r.owner as ModelProviderId, model: r.model.id }, r.model),
      );
    } else if (r.kind === "agent") {
      onAgent(
        withModel(
          { ...agent, harness: r.owner as Harness, model: r.model?.id ?? null },
          r.model ?? undefined,
        ),
      );
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && rows[cursor]) {
      e.preventDefault();
      pick(rows[cursor]);
    } else if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const key = favorites[Number(e.key) - 1];
      const target = all.find((r) => r.key === key);
      if (target) {
        e.preventDefault();
        pick(target);
      }
    }
  }

  // The column on the right follows the choice of the section being edited.
  const current =
    kind === "assistant" ? findAssistantModel(catalog, assistant) : findAgentModel(catalog, agent);
  const currentChoice = kind === "assistant" ? assistant : agent;
  const setEffort = (effort: string | null) => {
    if (kind === "assistant" && assistant) onAssistant({ ...assistant, effort });
    if (kind === "agent") onAgent({ ...agent, effort });
  };
  const setFast = (fast: boolean) => {
    if (kind === "assistant" && assistant) onAssistant({ ...assistant, fast });
    if (kind === "agent") onAgent({ ...agent, fast });
  };

  const provider = rail.startsWith("a:") ? (rail.slice(2) as ModelProviderId) : null;
  const providerInfo = provider ? providerModels(catalog, provider) : undefined;
  const harness = rail.startsWith("g:") ? (rail.slice(2) as Harness) : null;
  const harnessInfo = harness ? agentModels(catalog, harness) : undefined;

  return (
    <div
      role="dialog"
      aria-label="Choose models"
      onKeyDown={onKeyDown}
      className="anim-pop absolute bottom-full left-0 z-40 mb-2 flex w-[min(740px,calc(100vw-2rem))] origin-bottom-left flex-col overflow-hidden rounded-2xl bg-surface shadow-popover"
    >
      <div className="grid min-h-0 grid-cols-[52px_minmax(0,1fr)] sm:grid-cols-[52px_minmax(0,1fr)_220px]">
        <RailColumn rail={rail} onRail={setRail} catalog={catalog} />

        <div className="flex h-[min(380px,55vh)] min-w-0 flex-col border-l border-border">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search aria-hidden="true" size={14} className="text-subtle" />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={kind === "agent" ? "Search agent models" : "Search models"}
              aria-label="Search models"
              className="h-11 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle focus-visible:outline-none"
            />
          </div>
          <p className="px-3 pt-2.5 pb-1 text-[11px] text-subtle">
            {rail === "favorites"
              ? "Your starred models. ⌘1 to ⌘9 pick them."
              : kind === "assistant"
                ? "The assistant you chat with. It plans and starts tasks."
                : "Runs the coding tasks this chat starts, on your machines or in a sandbox."}
          </p>
          <div
            ref={list}
            role="listbox"
            aria-label="Models"
            className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5"
          >
            {provider && providerInfo && !providerInfo.connected ? (
              <ConnectProvider provider={provider} label={providerInfo.label} />
            ) : (
              <>
                {providerInfo?.error && (
                  <p className="mx-1.5 my-1 rounded-lg bg-[var(--tag-red-bg)] px-2.5 py-2 text-xs text-[var(--tag-red-text)]">
                    {providerInfo.error}
                  </p>
                )}
                {harnessInfo && harnessInfo.readyMachines === 0 && (
                  <p className="mx-1.5 my-1 rounded-lg bg-[var(--tag-amber-bg)] px-2.5 py-2 text-xs text-[var(--tag-amber-text)]">
                    No machine has {harnessInfo.label} ready. Tasks for it can still run in a
                    sandbox.
                  </p>
                )}
                {rows.length === 0 && (
                  <p className="px-3 py-8 text-center text-xs text-muted">
                    {rail === "favorites"
                      ? "Star a model to keep it here."
                      : query
                        ? "Nothing matches."
                        : harness
                          ? "The machines haven't reported any models yet."
                          : "No models."}
                  </p>
                )}
                {rows.map((r, i) => {
                  const fav = favorites.indexOf(r.key);
                  const selected = isSelected(r);
                  return (
                    <div
                      key={r.key}
                      data-index={i}
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                      onMouseMove={() => setCursor(i)}
                      onClick={() => pick(r)}
                      onKeyDown={() => {}}
                      className={cx(
                        "group flex h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px]",
                        i === cursor ? "bg-surface-3 text-text" : "text-soft",
                      )}
                    >
                      <ProviderIcon
                        provider={r.owner}
                        size={15}
                        className={r.model ? "" : "opacity-60"}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {r.label}
                        {r.hint && i === cursor && (
                          <span className="ml-2 text-xs text-subtle">{r.hint}</span>
                        )}
                      </span>
                      {selected && <Check aria-label="Selected" size={14} className="text-text" />}
                      <button
                        type="button"
                        aria-label={fav >= 0 ? `Unstar ${r.label}` : `Star ${r.label}`}
                        aria-pressed={fav >= 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(r.key);
                        }}
                        className={cx(
                          "grid size-6 cursor-pointer place-items-center rounded-md transition-opacity duration-150 hover:bg-surface",
                          fav >= 0
                            ? "text-warn"
                            : "text-subtle opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                        )}
                      >
                        <Star
                          size={13}
                          fill={fav >= 0 ? "currentColor" : "none"}
                          aria-hidden="true"
                        />
                      </button>
                      {fav >= 0 && fav < 9 && <Kbd>⌘{fav + 1}</Kbd>}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        <ReasoningColumn
          model={current}
          modelLabel={
            current ? shortLabel(current.label) : kind === "agent" ? "Agent default" : "No model"
          }
          effort={currentChoice?.effort ?? null}
          onEffort={setEffort}
        />
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <div
          role="radiogroup"
          aria-label="Speed"
          className="flex rounded-full bg-field p-0.5 shadow-field"
        >
          {[false, true].map((fast) => (
            // biome-ignore lint/a11y/useSemanticElements: styled radios inside a radiogroup.
            <button
              key={String(fast)}
              type="button"
              role="radio"
              aria-checked={(currentChoice?.fast ?? false) === fast}
              disabled={fast && !current?.fast}
              title={fast && !current?.fast ? "This model has no fast tier." : undefined}
              onClick={() => setFast(fast)}
              className={cx(
                "flex h-[24px] cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
                (currentChoice?.fast ?? false) === fast
                  ? "bg-surface-3 text-text shadow-active"
                  : "text-subtle hover:text-soft",
              )}
            >
              {fast && <Zap aria-hidden="true" size={12} />}
              {fast ? "Fast" : "Standard"}
            </button>
          ))}
        </div>
        {current?.fast && (
          <span className="text-[11px] text-subtle max-sm:hidden">Fast costs more per token.</span>
        )}
        <div className="ml-auto">
          {mode && onMode && <ModeMenu mode={mode} onMode={onMode} side="top" align="end" />}
        </div>
      </div>
    </div>
  );
}

function RailButton({
  active,
  label,
  onClick,
  children,
  dim,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
  dim?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cx(
        "relative grid size-10 cursor-pointer place-items-center rounded-xl transition-colors duration-150",
        active ? "bg-surface-3 text-text" : "text-subtle hover:bg-surface-2 hover:text-soft",
        dim && !active && "opacity-50",
      )}
    >
      {active && (
        <span className="absolute top-2 bottom-2 -left-[7px] w-[2px] rounded-full bg-accent-text" />
      )}
      {children}
    </button>
  );
}

function RailColumn({
  rail,
  onRail,
  catalog,
}: {
  rail: Rail;
  onRail: (r: Rail) => void;
  catalog: ModelCatalogView | undefined;
}) {
  return (
    <div className="flex flex-col items-center gap-1 overflow-y-auto py-2">
      <RailButton
        active={rail === "favorites"}
        label="Favorites"
        onClick={() => onRail("favorites")}
      >
        <Star size={17} aria-hidden="true" />
      </RailButton>
      <span className="my-1 h-px w-6 bg-border" />
      <span className="text-[9px] font-medium tracking-wider text-faint uppercase">Chat</span>
      {ASSISTANT_RAIL.map((p) => {
        const info = providerModels(catalog, p);
        return (
          <RailButton
            key={p}
            active={rail === `a:${p}`}
            label={`${info?.label ?? p}${info?.connected ? "" : " (not connected)"}`}
            dim={!info?.connected}
            onClick={() => onRail(`a:${p}`)}
          >
            <ProviderIcon provider={p} size={19} />
          </RailButton>
        );
      })}
      <span className="my-1 h-px w-6 bg-border" />
      <span className="text-[9px] font-medium tracking-wider text-faint uppercase">Agent</span>
      {AGENT_RAIL.map((h) => {
        const info = agentModels(catalog, h);
        return (
          <RailButton
            key={h}
            active={rail === `g:${h}`}
            label={`${HARNESS_LABELS[h]}${info?.readyMachines ? "" : " (no machine ready)"}`}
            dim={!info?.readyMachines}
            onClick={() => onRail(`g:${h}`)}
          >
            <ProviderIcon provider={h} size={19} />
          </RailButton>
        );
      })}
    </div>
  );
}

function ReasoningColumn({
  model,
  modelLabel,
  effort,
  onEffort,
}: {
  model: ModelOption | undefined;
  modelLabel: string;
  effort: string | null;
  onEffort: (effort: string | null) => void;
}) {
  const efforts = model?.efforts ?? [];
  return (
    <div className="hidden h-[min(380px,55vh)] min-w-0 flex-col border-l border-border sm:flex">
      <div className="flex h-11 items-center justify-between gap-2 border-b border-border px-3">
        <span className="text-[13px] text-soft">Reasoning</span>
        <span className="truncate text-xs text-subtle">{modelLabel}</span>
      </div>
      <div
        role="radiogroup"
        aria-label="Reasoning"
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {efforts.length === 0 ? (
          <p className="px-2.5 py-3 text-xs leading-4 text-subtle">
            {model ? "This model doesn't take a reasoning level." : "Uses the model's own setting."}
          </p>
        ) : (
          efforts.map((e) => {
            const selected = (effort ?? model?.defaultEffort) === e;
            return (
              // biome-ignore lint/a11y/useSemanticElements: styled radios inside a radiogroup.
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onEffort(e === model?.defaultEffort ? null : e)}
                className={cx(
                  "flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-150",
                  selected ? "bg-surface-3 text-text" : "text-soft hover:bg-surface-2",
                )}
              >
                <span className="flex-1">{effortLabel(e)}</span>
                {e === model?.defaultEffort && (
                  <span className="text-[11px] text-subtle">Default</span>
                )}
                {selected && <Check aria-hidden="true" size={14} />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Paste a provider's key right in the picker; its models load straight away. */
function ConnectProvider({ provider, label }: { provider: ModelProviderId; label: string }) {
  const save = useSaveProviderKey();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const compatible = provider === "openai-compatible";

  async function submit(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setError(null);
    try {
      await save(provider, {
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        ...(compatible ? { baseUrl: baseUrl.trim() } : {}),
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 px-3 py-4" onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
          <KeyRound aria-hidden="true" size={14} />
        </span>
        <div>
          <p className="text-[13px] font-medium">Connect {label}</p>
          <p className="text-xs text-muted">
            {compatible
              ? "Point Sling at Ollama, OpenRouter, LM Studio, or any OpenAI-style server."
              : "Paste an API key. It's stored encrypted and never shown again."}
          </p>
        </div>
      </div>
      {compatible && (
        <Input
          aria-label={`Base URL for ${label}`}
          placeholder="http://localhost:11434/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      )}
      <Input
        type="password"
        aria-label={`API key for ${label}`}
        placeholder={
          compatible ? "API key, if it needs one" : provider === "anthropic" ? "sk-ant-…" : "sk-…"
        }
        autoComplete="off"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          busy={busy}
          disabled={compatible ? !baseUrl.trim() : !key.trim()}
        >
          Connect
        </Button>
        <Link to="/settings" hash="model" className="text-xs text-subtle hover:text-text">
          All providers in Settings
        </Link>
        {busy && <Spinner className="size-3.5" />}
      </div>
      <ErrorText error={error} />
    </form>
  );
}
