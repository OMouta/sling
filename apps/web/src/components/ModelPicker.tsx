import {
  type AssistantChoice,
  type AssistantProvider,
  effortLabel,
  MODE_POLICY,
  type ModelCatalogView,
  type ModelOption,
  PERMISSION_MODES,
  type PermissionMode,
  providerVendor,
} from "@sling/core";
import { Link } from "@tanstack/react-router";
import { Check, ChevronUp, Laptop, Search, Shield, ShieldAlert, Star, Zap } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  favoriteKey,
  findAssistantModel,
  shortLabel,
  toggleFavorite,
  useFavorites,
  withModel,
} from "../lib/models.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { cx, Kbd, Menu, MenuItem } from "./ui.tsx";

export interface PickerProps {
  catalog: ModelCatalogView | undefined;
  assistant: AssistantChoice | null;
  onAssistant: (choice: AssistantChoice) => void;
  mode?: PermissionMode;
  onMode?: (mode: PermissionMode) => void;
  /** Offers "Workspace default" first, for a choice that can be no model of its own. */
  onDefault?: () => void;
}

interface Row {
  key: string;
  provider: AssistantProvider;
  model: ModelOption;
}

type Rail = "favorites" | AssistantProvider;

/**
 * The providers a chat can use now, one per vendor: the subscription through a
 * machine's CLI when one is on, else the API key.
 */
function usable(catalog: ModelCatalogView | undefined) {
  const seen = new Set<string>();
  return (catalog?.assistant ?? []).filter((p) => {
    if (!p.connected || seen.has(providerVendor(p.provider))) return false;
    seen.add(providerVendor(p.provider));
    return true;
  });
}

const WORKSPACE_DEFAULT = "Workspace default";

export function modelLabel(
  catalog: ModelCatalogView | undefined,
  choice: AssistantChoice | null,
  orDefault = false,
) {
  if (!choice) return orDefault ? WORKSPACE_DEFAULT : "Pick a model";
  const m = findAssistantModel(catalog, choice);
  if (m) return shortLabel(m.label);
  if (!choice.model) {
    return catalog?.assistant.find((p) => p.provider === choice.provider)?.label ?? "Default";
  }
  return choice.model;
}

/**
 * Where a popover goes so it's never clipped: above its button when it fits,
 * otherwise below, kept inside the window, in a layer over the whole page.
 * Null until it's been measured.
 */
function useAnchoredStyle(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  popover: RefObject<HTMLElement | null>,
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = popover.current;
      if (!a || !p) return;
      const gap = 8;
      const edge = 12;
      const above = a.top - gap - edge;
      const below = window.innerHeight - a.bottom - gap - edge;
      const up = above >= p.offsetHeight || above >= below;
      const left = Math.max(edge, Math.min(a.left, window.innerWidth - p.offsetWidth - edge));
      setStyle(
        up
          ? { left, bottom: window.innerHeight - a.top + gap, transformOrigin: "bottom left" }
          : { left, top: a.bottom + gap, transformOrigin: "top left" },
      );
    };
    place();
    window.addEventListener("resize", place);
    // Any scrolling container can move the button.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, popover]);
  return style;
}

/**
 * The controls under a composer: the model pill, which opens the picker,
 * and on its own, the conversation's permission mode.
 */
export function ChatControls(props: PickerProps & { className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const { catalog, assistant, mode, onMode } = props;
  const current = findAssistantModel(catalog, assistant);
  const label = modelLabel(catalog, assistant, Boolean(props.onDefault));
  // The default shows as what it is now.
  const icon = assistant?.provider ?? (props.onDefault && catalog?.defaults.assistant?.provider);
  const effort = assistant?.effort ?? current?.defaultEffort ?? null;
  const style = useAnchoredStyle(open, button, popover);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !popover.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div ref={root} className={cx("flex min-w-0 items-center gap-1", props.className)}>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${label}${effort ? `, ${effortLabel(effort)}` : ""}`}
        onClick={() => setOpen((o) => !o)}
        className="pressable flex h-[30px] min-w-0 cursor-pointer items-center gap-2 rounded-full px-2.5 text-[13px] transition-colors duration-150 hover:bg-surface-3 aria-expanded:bg-surface-3"
      >
        {icon && <ProviderIcon provider={icon} size={15} />}
        <span className="truncate font-medium text-text">{label}</span>
        {effort && <span className="shrink-0 text-muted">{effortLabel(effort)}</span>}
        {assistant?.fast && (
          <Zap aria-label="Fast" size={13} className="shrink-0 text-warn" fill="currentColor" />
        )}
      </button>
      {mode && onMode && (
        <div className="ml-auto shrink-0">
          <ModeMenu mode={mode} onMode={onMode} />
        </div>
      )}
      {open &&
        createPortal(
          <ModelPicker
            {...props}
            ref={popover}
            style={style}
            onClose={() => {
              setOpen(false);
              button.current?.focus({ preventScroll: true });
            }}
          />,
          document.body,
        )}
    </div>
  );
}

/** The conversation's permission mode, with what each one allows. */
export function ModeMenu({
  mode,
  onMode,
}: {
  mode: PermissionMode;
  onMode: (mode: PermissionMode) => void;
}) {
  const Icon = mode === "full-access" ? ShieldAlert : Shield;
  return (
    <Menu
      label="Permission mode"
      side="top"
      align="end"
      menuClassName="w-80 max-sm:w-72"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Permission mode: ${MODE_POLICY[mode].label}`}
          onClick={toggle}
          className={cx(
            "pressable flex h-[30px] cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[13px] transition-colors duration-150 aria-expanded:bg-surface-3",
            mode === "full-access"
              ? "text-danger hover:bg-[var(--tag-red-bg)]"
              : "text-muted hover:bg-surface-3 hover:text-soft",
          )}
        >
          <Icon aria-hidden="true" size={14} />
          <span className="max-sm:hidden">{MODE_POLICY[mode].label}</span>
          <ChevronUp aria-hidden="true" size={13} className="opacity-60" />
        </button>
      )}
    >
      {PERMISSION_MODES.map((m) => (
        <MenuItem
          key={m}
          icon={m === "full-access" ? ShieldAlert : Shield}
          danger={m === "full-access"}
          description={MODE_POLICY[m].description}
          onSelect={() => onMode(m)}
          trailing={m === mode ? <Check aria-hidden="true" className="text-text" /> : null}
        >
          {MODE_POLICY[m].label}
        </MenuItem>
      ))}
    </Menu>
  );
}

export function ModelPicker({
  catalog,
  assistant,
  onAssistant,
  onDefault,
  onClose,
  ref,
  style,
}: PickerProps & {
  onClose: () => void;
  ref?: RefObject<HTMLDivElement | null>;
  /** Where it goes, from its button. Hidden until it's placed. */
  style?: CSSProperties | null;
}) {
  const favorites = useFavorites();
  const providers = usable(catalog);
  const [rail, setRail] = useState<Rail>(() =>
    favorites.length > 0
      ? "favorites"
      : (assistant?.provider ?? providers[0]?.provider ?? "favorites"),
  );
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => search.current?.focus({ preventScroll: true }), []);

  const all = useMemo<Row[]>(
    () =>
      providers.flatMap((p) =>
        p.models.map((m) => ({
          key: favoriteKey("assistant", p.provider, m.id),
          provider: p.provider,
          model: m,
        })),
      ),
    [providers],
  );
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A search looks across every provider.
    if (q) {
      return all.filter(
        (r) => r.model.label.toLowerCase().includes(q) || r.model.id.toLowerCase().includes(q),
      );
    }
    return rail === "favorites"
      ? favorites.flatMap((k) => all.filter((r) => r.key === k))
      : all.filter((r) => r.provider === rail);
  }, [all, rail, query, favorites]);

  const typed = query.trim().toLowerCase();
  // The workspace default comes first, unless a search leaves it out.
  const lead = onDefault && (!typed || WORKSPACE_DEFAULT.toLowerCase().includes(typed)) ? 1 : 0;
  const fallback = catalog?.defaults.assistant ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the cursor when the list changes.
  useEffect(() => setCursor(0), [rail, query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const current = findAssistantModel(catalog, assistant);
  const pick = (r: Row) => {
    const base = assistant ?? { provider: r.provider, model: "", effort: null, fast: false };
    onAssistant(withModel({ ...base, provider: r.provider, model: r.model.id }, r.model));
  };
  const setEffort = (effort: string | null) => {
    if (assistant) onAssistant({ ...assistant, effort });
  };
  const setFast = (fast: boolean) => {
    if (assistant) onAssistant({ ...assistant, fast });
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length + lead - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter" && lead && cursor === 0) {
      e.preventDefault();
      onDefault?.();
    } else if (e.key === "Enter" && rows[cursor - lead]) {
      e.preventDefault();
      pick(rows[cursor - lead] as Row);
    } else if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const target = all.find((r) => r.key === favorites[Number(e.key) - 1]);
      if (target) {
        e.preventDefault();
        pick(target);
      }
    }
  }

  // On a Claude plan, Claude Code's fast mode is paid from usage credits.
  const creditsForFast = assistant?.provider === "claude-code" && Boolean(current?.fast);
  const efforts = current?.efforts ?? [];
  const selectedEffort = assistant?.effort ?? current?.defaultEffort ?? null;
  const effortButton = (e: string, compact: boolean) => (
    // biome-ignore lint/a11y/useSemanticElements: styled radios inside a radiogroup.
    <button
      key={e}
      type="button"
      role="radio"
      aria-checked={selectedEffort === e}
      onClick={() => setEffort(e === current?.defaultEffort ? null : e)}
      className={
        compact
          ? cx(
              "h-[26px] shrink-0 cursor-pointer rounded-full px-2.5 text-xs",
              selectedEffort === e ? "bg-surface-3 text-text shadow-active" : "text-subtle",
            )
          : cx(
              "flex h-[38px] w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors duration-150",
              selectedEffort === e ? "text-text" : "text-soft hover:bg-surface-2",
            )
      }
    >
      {compact ? (
        effortLabel(e)
      ) : (
        <>
          <span className="flex-1">{effortLabel(e)}</span>
          {e === current?.defaultEffort && selectedEffort !== e && (
            <span className="text-xs text-subtle">Default</span>
          )}
          {selectedEffort === e && <Check aria-hidden="true" size={15} />}
        </>
      )}
    </button>
  );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Choose a model"
      onKeyDown={onKeyDown}
      style={{ ...(style ?? { left: 0, top: 0, visibility: "hidden" }) }}
      className={cx(
        "fixed z-50 flex w-[min(620px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl bg-surface shadow-popover",
        style && "anim-pop",
      )}
    >
      <div className="grid h-[min(360px,55vh)] grid-cols-[56px_minmax(0,1fr)] sm:grid-cols-[56px_minmax(0,1fr)_200px]">
        <div className="flex flex-col items-center gap-1.5 border-r border-border py-2.5">
          <RailButton
            active={rail === "favorites"}
            label="Favorites"
            onClick={() => setRail("favorites")}
          >
            <Star
              size={18}
              aria-hidden="true"
              fill={rail === "favorites" ? "currentColor" : "none"}
            />
          </RailButton>
          <span className="my-0.5 h-px w-7 bg-border" />
          {providers.map((p) => (
            <RailButton
              key={p.provider}
              active={rail === p.provider}
              label={
                p.kind === "cli" ? `${p.label} on ${p.machines.join(", ")}` : `${p.label} API key`
              }
              onClick={() => setRail(p.provider)}
            >
              <ProviderIcon provider={p.provider} size={20} />
            </RailButton>
          ))}
        </div>

        <div className="flex min-w-0 flex-col">
          <div className="mx-3 flex items-center gap-2 border-b-2 border-accent-text/60 transition-colors duration-150 focus-within:border-accent-text">
            <Search aria-hidden="true" size={15} className="text-subtle" />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              aria-label="Search models"
              className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle focus-visible:outline-none"
            />
          </div>
          <div
            ref={list}
            role="listbox"
            aria-label="Models"
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {lead > 0 && (
              <div
                data-index={0}
                role="option"
                aria-selected={!assistant}
                tabIndex={-1}
                onMouseMove={() => setCursor(0)}
                onClick={() => onDefault?.()}
                onKeyDown={() => {}}
                className={cx(
                  "flex h-[38px] cursor-pointer items-center gap-3 rounded-lg px-2.5 text-sm",
                  cursor === 0 ? "bg-surface-3 text-text" : "text-soft",
                )}
              >
                {fallback ? (
                  <ProviderIcon provider={fallback.provider} size={17} />
                ) : (
                  <span className="size-[17px] shrink-0" />
                )}
                <span className="min-w-0 truncate">{WORKSPACE_DEFAULT}</span>
                {!assistant && (
                  <Check aria-label="Selected" size={15} className="shrink-0 text-text" />
                )}
                <span className="flex-1" />
                {fallback && (
                  <span className="truncate text-xs text-subtle">
                    {modelLabel(catalog, fallback)}
                  </span>
                )}
              </div>
            )}
            {providers.length === 0 ? (
              <NoProvider />
            ) : rows.length === 0 ? (
              lead > 0 && typed ? null : (
                <p className="px-3 py-10 text-center text-[13px] text-muted">
                  {rail === "favorites" && !query
                    ? "Star a model to keep it here."
                    : "No models match."}
                </p>
              )
            ) : (
              rows.map((r, n) => {
                const i = n + lead;
                const fav = favorites.indexOf(r.key);
                const selected =
                  assistant?.provider === r.provider && assistant.model === r.model.id;
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
                      "group flex h-[38px] cursor-pointer items-center gap-3 rounded-lg px-2.5 text-sm",
                      i === cursor ? "bg-surface-3 text-text" : "text-soft",
                    )}
                  >
                    <ProviderIcon provider={r.provider} size={17} />
                    <span className="min-w-0 truncate">{r.model.label}</span>
                    {selected && (
                      <Check aria-label="Selected" size={15} className="shrink-0 text-text" />
                    )}
                    <span className="flex-1" />
                    <button
                      type="button"
                      aria-label={fav >= 0 ? `Unstar ${r.model.label}` : `Star ${r.model.label}`}
                      aria-pressed={fav >= 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(r.key);
                      }}
                      className={cx(
                        "hit grid size-6 shrink-0 cursor-pointer place-items-center rounded-md opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
                        fav >= 0 ? "text-warn" : "text-subtle",
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
              })
            )}
          </div>
        </div>

        <div className="hidden min-w-0 flex-col border-l border-border sm:flex">
          <div className="mx-3 flex h-11 items-center justify-between gap-2 border-b border-border">
            <span className="text-sm text-soft">Reasoning</span>
            {(assistant || !onDefault) && (
              <span className="truncate text-[13px] text-subtle">
                {modelLabel(catalog, assistant)}
              </span>
            )}
          </div>
          <div
            role="radiogroup"
            aria-label="Reasoning"
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {!assistant && onDefault ? null : efforts.length === 0 ? (
              <p className="px-2.5 py-3 text-xs leading-4 text-subtle">
                This model doesn't take a reasoning level.
              </p>
            ) : (
              efforts.map((e) => effortButton(e, false))
            )}
          </div>
        </div>
      </div>

      {efforts.length > 0 && (
        <div
          role="radiogroup"
          aria-label="Reasoning level"
          className="flex gap-1 overflow-x-auto border-t border-border px-3 py-2 sm:hidden"
        >
          {efforts.map((e) => effortButton(e, true))}
        </div>
      )}

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
              aria-checked={(assistant?.fast ?? false) === fast}
              disabled={fast && !current?.fast}
              title={
                !fast
                  ? undefined
                  : !current?.fast
                    ? "This model has no fast tier."
                    : creditsForFast
                      ? "Claude bills fast mode to usage credits, outside your plan's limits."
                      : undefined
              }
              onClick={() => setFast(fast)}
              className={cx(
                "flex h-[26px] cursor-pointer items-center gap-1 rounded-full px-3 text-[13px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
                (assistant?.fast ?? false) === fast
                  ? "bg-surface-3 text-text shadow-active"
                  : "text-subtle hover:text-soft",
              )}
            >
              {fast && <Zap aria-hidden="true" size={13} fill="currentColor" />}
              {fast ? "Fast" : "Standard"}
            </button>
          ))}
        </div>
        {assistant?.fast && creditsForFast && (
          <span className="text-xs text-subtle">Billed to usage credits</span>
        )}
      </div>
    </div>
  );
}

function RailButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
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
        active ? "text-text" : "text-subtle hover:bg-surface-2 hover:text-soft",
      )}
    >
      {active && (
        <span className="absolute top-2 -right-[8px] bottom-2 w-[2.5px] rounded-full bg-accent-text" />
      )}
      {children}
    </button>
  );
}

function NoProvider() {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="mb-3 grid size-9 place-items-center rounded-xl bg-surface-2 text-icon shadow-raised">
        <Laptop aria-hidden="true" size={16} />
      </span>
      <p className="text-[13px] font-medium">No model to chat with yet</p>
      <p className="mt-1 max-w-xs text-xs leading-4 text-muted">
        Pair a machine with Codex or Claude Code logged in.
      </p>
      <Link
        to="/machines"
        search={{ pair: true }}
        className="mt-3 flex h-[26px] items-center rounded-full bg-surface-2 px-3 text-xs font-medium shadow-raised hover:shadow-raised-hover"
      >
        Pair a machine
      </Link>
    </div>
  );
}
