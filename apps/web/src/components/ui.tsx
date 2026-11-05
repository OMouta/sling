import { ChevronDown, LoaderCircle, type LucideIcon, X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ Buttons */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "ghost-danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg shadow-primary enabled:hover:bg-[#4a2fff]",
  secondary: "bg-surface-2 text-text shadow-raised enabled:hover:shadow-raised-hover",
  ghost: "text-muted enabled:hover:bg-surface-3 enabled:hover:text-text",
  danger: "bg-surface-2 text-danger shadow-raised enabled:hover:shadow-raised-hover",
  "ghost-danger": "text-danger enabled:hover:bg-[var(--tag-red-bg)]",
};

/**
 * Pill buttons. `md` is the default control height (30px); `sm` sits inside
 * cards and table rows. Pass `icon` for a leading icon, or `iconOnly` with an
 * `aria-label` for a round icon button.
 */
export function Button({
  variant = "secondary",
  size = "md",
  busy,
  icon: Icon,
  iconOnly,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  busy?: boolean;
  icon?: LucideIcon;
  iconOnly?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "pressable inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full text-xs font-medium whitespace-nowrap select-none disabled:cursor-not-allowed disabled:opacity-50",
        iconOnly
          ? size === "sm"
            ? "size-[26px]"
            : "size-[30px]"
          : size === "sm"
            ? "h-[26px] px-2.5"
            : "h-[30px] px-3",
        VARIANTS[variant],
        className,
      )}
    >
      {busy ? (
        <LoaderCircle className="animate-spin" aria-hidden="true" />
      ) : (
        Icon && <Icon aria-hidden="true" />
      )}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- Fields */

const fieldBase =
  "w-full rounded-lg bg-field px-2.5 text-[13px] text-text shadow-field outline-none transition-shadow duration-150 placeholder:text-subtle hover:shadow-field-hover focus:shadow-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(fieldBase, "h-8", className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(fieldBase, "py-2 leading-5", className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select
        {...rest}
        className={cx(fieldBase, "h-8 cursor-pointer appearance-none pr-7", className)}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-subtle"
      />
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children.
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-soft">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-4 text-subtle">{hint}</span>}
    </label>
  );
}

/* ------------------------------------------------------------- Containers */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-xl bg-surface shadow-card", className)}>{children}</div>;
}

/** A titled block inside a page: a heading row and a card. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("space-y-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{title}</h2>
          {description && <p className="mt-0.5 text-xs leading-4 text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/* --------------------------------------------------------- Tags and status */

export type Tone =
  | "neutral"
  | "ok"
  | "warn"
  | "danger"
  | "accent"
  | "blue"
  | "teal"
  | "yellow"
  | "purple";

const TAG_VAR: Record<Tone, string> = {
  neutral: "neutral",
  ok: "green",
  warn: "amber",
  danger: "red",
  accent: "purple",
  blue: "blue",
  teal: "teal",
  yellow: "yellow",
  purple: "purple",
};

/** A small rounded chip. Tones map onto the tag palette. */
export function Badge({
  tone = "neutral",
  dot,
  className,
  children,
}: {
  tone?: Tone;
  /** Show a leading status dot in the tag's text color. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const v = TAG_VAR[tone];
  return (
    <span
      className={cx(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        className,
      )}
      style={{
        background: `var(--tag-${v}-bg)`,
        borderColor: `var(--tag-${v}-border)`,
        color: `var(--tag-${v}-text)`,
      }}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const DOT_COLOR: Record<Tone, string> = {
  neutral: "bg-subtle",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent-text",
  blue: "bg-[var(--tag-blue-text)]",
  teal: "bg-status",
  yellow: "bg-[var(--tag-yellow-text)]",
  purple: "bg-[var(--tag-purple-text)]",
};

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && (
        <span
          className={cx(
            "absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping",
            DOT_COLOR[tone],
          )}
        />
      )}
      <span className={cx("relative inline-block size-2 rounded-full", DOT_COLOR[tone])} />
    </span>
  );
}

/** A numeric counter, as next to a nav item or a tab. */
export function Count({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return (
    <span
      className={cx(
        "tabular inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[5px] px-1 text-[11px] leading-none font-medium",
        tone === "warn"
          ? "bg-[var(--tag-amber-bg)] text-[var(--tag-amber-text)] shadow-[0_0_0_0.5px_var(--tag-amber-border)]"
          : "bg-surface-3 text-[var(--tag-neutral-text)] shadow-[0_0_0_0.5px_var(--line-strong)]",
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cx("animate-spin text-muted", className ?? "size-4")}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cx("block animate-pulse rounded-md bg-surface-3", className)} />;
}

const AVATAR_TONES = ["#4124fb", "#16a34a", "#d97706", "#db2777", "#0891b2", "#7c3aed", "#dc2626"];

/** Initials on a colored circle, picked from the name so it stays stable. */
export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  const clean = name.replace(/@.*/, "").replace(/[^a-zA-Z0-9 ._-]/g, "");
  const parts = clean.split(/[ ._-]+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center rounded-full font-medium text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.42)),
        background: AVATAR_TONES[h % AVATAR_TONES.length],
      }}
    >
      {initials}
    </span>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <p className="text-xs leading-4 text-danger">{message}</p>;
}

/** An empty state: an icon tile, a title, and a line or two of help. */
export function Empty({
  title,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center px-6 py-14 text-center", className)}>
      {Icon && (
        <span className="mb-4 grid size-10 place-items-center rounded-xl bg-surface-2 text-icon shadow-raised">
          <Icon size={16} aria-hidden="true" />
        </span>
      )}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] leading-5 text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Switch */

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  size = "md",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name. */
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-[background-color,box-shadow] duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-4 w-7" : "h-[18px] w-8",
        checked
          ? "bg-accent shadow-[inset_0_0_0_1px_rgb(255_255_255/0.15)]"
          : "bg-surface-3 shadow-[inset_0_0_0_1px_var(--line-strong)]",
      )}
    >
      <span
        className={cx(
          "inline-block rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.4)] transition-transform duration-150 ease-[var(--ease-out)]",
          size === "sm" ? "size-3" : "size-3.5",
          checked ? (size === "sm" ? "translate-x-3.5" : "translate-x-4") : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------------ Dialog */

/**
 * A modal panel. Escape and the backdrop close it. On phones it sits at the
 * bottom of the screen like a sheet.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener("keydown", onKey);
    const first = panel.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]), textarea, select, button[data-autofocus]",
    );
    first?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center overscroll-contain sm:items-center sm:p-4">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="anim-fade absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={cx(
          "anim-pop relative flex max-h-[90vh] w-full flex-col rounded-t-2xl bg-surface shadow-popover sm:rounded-2xl",
          wide ? "sm:max-w-4xl" : "sm:max-w-lg",
        )}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2 id={id} className="text-sm font-medium">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-xs leading-4 text-muted">{description}</p>}
          </div>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={X}
            onClick={onClose}
            aria-label="Close dialog"
            className="-mt-0.5 -mr-1.5"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
          {children}
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------------- Tabs */

/** Underlined tabs, as in a page's tab row. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { id: T; label: string; count?: number; icon?: LucideIcon }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cx("flex gap-5 overflow-x-auto", className)}>
      {tabs.map((t) => {
        const active = value === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cx(
              "relative flex shrink-0 cursor-pointer items-center gap-1.5 py-[15px] text-xs font-medium transition-colors duration-150",
              active ? "text-text" : "text-subtle hover:text-soft",
            )}
          >
            {Icon && <Icon aria-hidden="true" />}
            {t.label}
            {t.count !== undefined && t.count > 0 && <Count>{t.count}</Count>}
            {active && <span className="absolute inset-x-0 -bottom-px h-px bg-text" />}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- Toolbar filters */

/**
 * A pill with a label and the current value, as in a filter bar. A native
 * select sits on top so keyboard and screen readers get the real control.
 */
export function FilterSelect<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  onChange,
  icon: Icon,
}: {
  label: string;
  /** When the visible label is too short to name the control on its own. */
  ariaLabel?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  icon?: LucideIcon;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <span className="relative inline-flex h-[30px] shrink-0 items-center rounded-full bg-surface-2 pr-2.5 shadow-raised transition-shadow duration-150 hover:shadow-raised-hover has-[:focus-visible]:shadow-focus">
      <span className="flex items-center gap-1.5 pr-1.5 pl-3 text-xs text-subtle">
        {Icon && <Icon aria-hidden="true" />}
        <span className={Icon ? "max-sm:hidden" : undefined}>{label}</span>
      </span>
      <span className="text-xs font-medium text-text">{current}</span>
      <ChevronDown aria-hidden="true" size={12} className="ml-1 text-subtle" />
      <select
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="absolute inset-0 cursor-pointer appearance-none rounded-full opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/* --------------------------------------------------------------- Tables */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  className,
  align,
}: {
  children?: ReactNode;
  className?: string;
  align?: "right";
}) {
  return (
    <th
      scope="col"
      className={cx(
        "h-[38px] border-b border-border px-3 text-xs font-normal whitespace-nowrap text-subtle first:pl-5 last:pr-5",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Tr({
  children,
  onClick,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={cx(
        "border-b border-border transition-colors duration-150 hover:bg-hover",
        onClick && "cursor-pointer",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  className,
  align,
}: {
  children?: ReactNode;
  className?: string;
  align?: "right";
}) {
  return (
    <td
      className={cx(
        "h-[43px] px-3 whitespace-nowrap first:pl-5 last:pr-5",
        align === "right" && "tabular text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}

/* ------------------------------------------------------------------- Menu */

const MenuClose = createContext<() => void>(() => {});

/** A dropdown that opens from its trigger. Escape and outside clicks close it. */
export function Menu({
  trigger,
  label,
  align = "end",
  side = "bottom",
  children,
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  label: string;
  align?: "start" | "end";
  side?: "top" | "bottom";
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={root} className={cx("relative", className)}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cx(
            "anim-pop absolute z-40 min-w-52 rounded-xl bg-surface p-1 shadow-popover",
            side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
            align === "end" ? "right-0" : "left-0",
          )}
          style={{
            transformOrigin: `${side === "bottom" ? "top" : "bottom"} ${align === "end" ? "right" : "left"}`,
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [
              ...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)"),
            ];
            const i = items.indexOf(document.activeElement as HTMLElement);
            const next = e.key === "ArrowDown" ? i + 1 : i - 1;
            items[(next + items.length) % items.length]?.focus();
          }}
        >
          <MenuClose.Provider value={() => setOpen(false)}>{children}</MenuClose.Provider>
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon: Icon,
  onSelect,
  children,
  danger,
  trailing,
}: {
  icon?: LucideIcon;
  onSelect: () => void;
  children: ReactNode;
  danger?: boolean;
  trailing?: ReactNode;
}) {
  const close = useContext(MenuClose);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        close();
        onSelect();
      }}
      className={cx(
        "flex h-[30px] w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none focus-visible:bg-surface-3 hover:bg-surface-3",
        danger ? "text-danger" : "text-text",
      )}
    >
      {Icon && <Icon aria-hidden="true" className={danger ? "" : "text-subtle"} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="-mx-1 my-1 h-px bg-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pt-1.5 pb-1 text-xs text-subtle">{children}</div>;
}

/* ------------------------------------------------------------------- Misc */

/** A keyboard shortcut hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-surface-3 px-1 font-sans text-[11px] text-muted shadow-[0_0_0_0.5px_var(--line-strong)]">
      {children}
    </kbd>
  );
}

/** A labelled value, as in a details panel. */
export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-1 truncate text-[13px]">{children}</dd>
    </div>
  );
}

/** The action row at the bottom of a card. */
export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-2.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A small label above a card's title, with an optional icon. */
export function Kicker({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-subtle">
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

/** A code-ish value: branches, commits, IDs. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cx(
        "rounded-[5px] bg-surface-3 px-1 py-px font-mono text-[11.5px] text-soft",
        className,
      )}
    >
      {children}
    </code>
  );
}
