import type { SetupOptionView } from "@sling/core";
import { Check } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { blankRow, type FormField, setField } from "../lib/schemaForm.ts";
import { Button, cx, Dialog, Input, Select, Switch, Textarea } from "./ui.tsx";

export interface FieldOverride {
  /** Replaces the default control. */
  control?: ReactNode;
  /** Shown at the end of the label row, for example a mode toggle. */
  accessory?: ReactNode;
  /** Shown under the field, after its description. */
  after?: ReactNode;
}

export interface SchemaFormProps {
  fields: FormField[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, key: string) => void;
  override?: (field: FormField, value: unknown, set: (v: unknown) => void) => FieldOverride | null;
  /** Keys rendered as password inputs. */
  secretFields?: readonly string[];
  /** Placeholder for secret fields that already have a stored value. */
  secretPlaceholder?: string;
  /** Placeholder for every field, for credentials that are stored but never sent back. */
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  /** Choices for a field, by key. A string field becomes a picker, a list a checklist. */
  options?: Record<string, SetupOptionView[]>;
  /** The heading above already asks for it, so the label is for screen readers only. */
  bareLabel?: boolean;
  /** No required markers, for forms that say what's missing another way. */
  hideRequired?: boolean;
}

/** A form generated from JSON Schema fields. */
export function SchemaForm(props: SchemaFormProps) {
  const { fields, value, onChange } = props;
  if (fields.length === 0) return <p className="text-xs text-muted">No settings.</p>;
  return (
    <div className={props.compact ? "space-y-3" : "space-y-4"}>
      {fields.map((f) => (
        <FieldRow
          key={f.key}
          field={f}
          value={value[f.key]}
          set={(v) => onChange(setField(value, f, v), f.key)}
          form={props}
        />
      ))}
    </div>
  );
}

/** One field of a schema form, for forms that lay fields out themselves. */
export function SchemaField({
  field,
  value,
  onChange,
  form,
}: {
  field: FormField;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>, key: string) => void;
  form: Omit<SchemaFormProps, "fields" | "value" | "onChange">;
}) {
  return (
    <FieldRow
      field={field}
      value={value[field.key]}
      set={(v) => onChange(setField(value, field, v), field.key)}
      form={{ ...form, fields: [field], value, onChange }}
    />
  );
}

function FieldRow({
  field,
  value,
  set,
  form,
}: {
  field: FormField;
  value: unknown;
  set: (v: unknown) => void;
  form: SchemaFormProps;
}) {
  const id = useId();
  const custom = form.override?.(field, value, set) ?? null;
  const secret = form.secretFields?.includes(field.key) ?? false;
  const placeholder =
    (secret ? (form.secretPlaceholder ?? form.placeholder) : form.placeholder) ??
    field.meta.placeholder ??
    undefined;
  const options = form.options?.[field.key];
  const picked = options && options.length > 0 ? options : null;
  const control = custom?.control ?? (
    <Control
      id={id}
      field={field}
      value={value}
      set={set}
      secret={secret}
      placeholder={placeholder}
      disabled={form.disabled}
      options={picked}
    />
  );
  const labelFor =
    field.kind === "boolean" ||
    field.kind === "stringList" ||
    (field.kind === "enum" && (field.widget === "segmented" || field.widget === "cards"))
      ? undefined
      : id;
  return (
    <div className="space-y-1.5" data-field={field.key}>
      <div
        className={cx(
          "flex items-center justify-between gap-2",
          form.bareLabel && !custom?.accessory && "sr-only",
        )}
      >
        <label
          htmlFor={labelFor}
          className={cx("text-xs font-medium text-soft", form.bareLabel && "sr-only")}
        >
          {field.label}
          {field.required && !form.hideRequired && (
            <span className="ml-0.5 text-danger" title="Required">
              *
            </span>
          )}
        </label>
        {custom?.accessory}
      </div>
      {control}
      {field.description && <p className="text-xs text-muted">{field.description}</p>}
      {custom?.after}
    </div>
  );
}

function Control({
  id,
  field,
  value,
  set,
  secret,
  placeholder,
  disabled,
  options,
}: {
  id: string;
  field: FormField;
  value: unknown;
  set: (v: unknown) => void;
  secret: boolean;
  placeholder?: string;
  disabled?: boolean;
  options: SetupOptionView[] | null;
}) {
  const fallback =
    field.default !== undefined && typeof field.default !== "object"
      ? String(field.default)
      : undefined;
  if (options && field.kind === "string") {
    return (
      <OptionSelect
        id={id}
        value={typeof value === "string" ? value : ""}
        options={options}
        // A picker's choices come from the lookup; "none" is only there until one is picked.
        offerNone={!field.required && !field.meta.picker}
        placeholder={field.meta.placeholder ?? undefined}
        disabled={disabled}
        onChange={set}
      />
    );
  }
  if (options && field.kind === "stringList") {
    return (
      <CheckList
        label={field.label}
        value={Array.isArray(value) ? value.map(String) : []}
        options={options}
        emptyMeansAll={field.meta.emptyMeansAll}
        allowOther={field.meta.allowOther}
        placeholder={field.meta.placeholder ?? undefined}
        disabled={disabled}
        onChange={set}
      />
    );
  }
  if (field.kind === "enum" && field.widget === "cards") {
    const current = value === undefined ? field.default : value;
    return (
      <OptionCards
        label={field.label}
        options={field.options.map((o) => ({
          value: String(o.value),
          label: o.label,
          detail: o.detail,
        }))}
        value={String(current)}
        disabled={disabled}
        onChange={(v) => set(field.options.find((o) => String(o.value) === v)?.value)}
      />
    );
  }
  if (field.kind === "enum" && field.widget === "segmented") {
    const current = value === undefined ? field.default : value;
    return (
      <SegmentedControl
        label={field.label}
        options={field.options.map((o) => ({ value: String(o.value), label: o.label }))}
        value={String(current)}
        disabled={disabled}
        onChange={(v) => set(field.options.find((o) => String(o.value) === v)?.value)}
      />
    );
  }
  switch (field.kind) {
    case "string":
      return (
        <Input
          id={id}
          type={secret ? "password" : "text"}
          autoComplete={secret ? "new-password" : "off"}
          value={typeof value === "string" ? value : value == null ? "" : String(value)}
          placeholder={placeholder ?? fallback}
          maxLength={field.maxLength}
          disabled={disabled}
          onChange={(e) => set(e.target.value === "" && field.nullable ? null : e.target.value)}
        />
      );
    case "jsonata":
      return (
        <Textarea
          id={id}
          rows={2}
          spellCheck={false}
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder ?? "JSONata, for example inputs.value.status = 200"}
          disabled={disabled}
          className="font-mono text-xs"
          onChange={(e) => set(e.target.value)}
        />
      );
    case "textarea":
      return (
        <LongText
          id={id}
          label={field.label}
          value={typeof value === "string" ? value : ""}
          placeholder={placeholder}
          disabled={disabled}
          onChange={set}
        />
      );
    case "number":
      return (
        <NumberInput
          id={id}
          value={typeof value === "number" ? value : undefined}
          integer={field.integer}
          min={field.min}
          max={field.max}
          placeholder={placeholder ?? fallback}
          disabled={disabled}
          onChange={set}
        />
      );
    case "boolean":
      return (
        <Switch
          checked={value === true || (value === undefined && field.default === true)}
          onChange={set}
          label={field.label}
          disabled={disabled}
        />
      );
    case "enum": {
      const index = field.options.findIndex(
        (o) => o.value === (value === undefined ? field.default : value),
      );
      return (
        <Select
          id={id}
          value={index === -1 ? "" : String(index)}
          disabled={disabled}
          onChange={(e) => {
            const i = e.target.value;
            set(i === "" ? undefined : field.options[Number(i)]?.value);
          }}
        >
          {(index === -1 || !field.required) && <option value="">—</option>}
          {field.options.map((o, i) => (
            <option key={String(o.value)} value={String(i)}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    }
    case "stringList":
      return (
        <ChipList
          id={id}
          label={field.label}
          placeholder={field.meta.placeholder ?? undefined}
          value={Array.isArray(value) ? value.map(String) : []}
          disabled={disabled}
          onChange={set}
        />
      );
    case "objectList":
      return (
        <RowList
          field={field}
          value={Array.isArray(value) ? (value as Record<string, unknown>[]) : []}
          disabled={disabled}
          onChange={set}
        />
      );
    case "object":
      return (
        <fieldset className="rounded-xl bg-surface-2/50 p-3 shadow-card">
          <SchemaForm
            compact
            fields={field.fields}
            value={value && typeof value === "object" ? (value as Record<string, unknown>) : {}}
            onChange={(next) => set(next)}
            disabled={disabled}
          />
        </fieldset>
      );
    default:
      return (
        <JsonInput
          id={id}
          value={value === undefined ? field.default : value}
          disabled={disabled}
          onChange={set}
        />
      );
  }
}

/** Picks one of the setup lookup's choices. A stored value it didn't offer stays pickable. */
function OptionSelect({
  id,
  value,
  options,
  offerNone,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  options: SetupOptionView[];
  offerNone: boolean;
  /** The label of the empty choice. */
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const known = value === "" || options.some((o) => o.value === value);
  return (
    <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {(offerNone || value === "") && (
        <option value="">{placeholder ?? (offerNone ? "None" : "Pick one")}</option>
      )}
      {!known && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.detail ? `${o.label} · ${o.detail}` : o.label}
        </option>
      ))}
    </Select>
  );
}

/** Ticks choices from the setup lookup, with an "Add" row when other values are allowed. */
function CheckList({
  label,
  value,
  options,
  emptyMeansAll,
  allowOther,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string[];
  options: SetupOptionView[];
  emptyMeansAll: boolean;
  allowOther: boolean;
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const all = options.map((o) => o.value);
  const extra = value.filter((v) => !all.includes(v));
  const rows: SetupOptionView[] = [...options, ...extra.map((v) => ({ value: v, label: v }))];
  const isOn = (v: string) => value.includes(v) || (emptyMeansAll && value.length === 0);
  const toggle = (v: string) => {
    const on = rows.filter((r) => isOn(r.value)).map((r) => r.value);
    const next = on.includes(v) ? on.filter((x) => x !== v) : [...on, v];
    // Everything ticked is stored as nothing, so new ones are picked up too.
    onChange(emptyMeansAll && all.every((x) => next.includes(x)) && extra.length === 0 ? [] : next);
  };
  const add = () => {
    const v = draft.trim();
    if (v && !value.includes(v))
      onChange([...rows.filter((r) => isOn(r.value)).map((r) => r.value), v]);
    setDraft("");
  };
  return (
    <ul
      aria-label={label}
      className="divide-y divide-border overflow-hidden rounded-lg bg-field shadow-field"
    >
      {rows.map((o) => {
        const on = isOn(o.value);
        return (
          <li key={o.value}>
            <label className="flex min-h-9 cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[13px] has-disabled:cursor-not-allowed">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={on}
                disabled={disabled}
                onChange={() => toggle(o.value)}
              />
              <span
                aria-hidden="true"
                className={cx(
                  "grid size-4 shrink-0 place-items-center rounded-[5px] shadow-field transition-colors duration-150 peer-focus-visible:shadow-focus",
                  on ? "bg-accent text-accent-fg" : "bg-surface-3",
                )}
              >
                {on && <Check size={11} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.detail && <span className="shrink-0 text-xs text-subtle">{o.detail}</span>}
            </label>
          </li>
        );
      })}
      {allowOther && (
        <li>
          <input
            aria-label={`Add to ${label}`}
            className="h-9 w-full bg-transparent px-3 text-[13px] outline-none placeholder:text-subtle"
            placeholder={placeholder ?? "Add another"}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        </li>
      )}
    </ul>
  );
}

/** A choice as large options, each with a line saying what it means. Arrow keys move between them. */
export function OptionCards({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: { value: string; label: ReactNode; detail?: ReactNode; icon?: ReactNode }[];
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, by: number) => {
    const next = (from + by + options.length) % options.length;
    const o = options[next];
    if (!o) return;
    onChange(o.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2">
      {options.map((o, i) => {
        const on = value === o.value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled radios inside a radiogroup.
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (!options.some((x) => x.value === value) && i === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cx(
              "flex cursor-pointer items-start gap-3 rounded-xl p-3.5 text-left transition-shadow duration-150 focus-visible:shadow-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
              on
                ? "bg-surface-2 shadow-[inset_0_0_0_1.5px_var(--color-accent)]"
                : "bg-field shadow-field hover:shadow-field-hover",
            )}
          >
            {o.icon && <span className="mt-0.5 shrink-0 text-icon">{o.icon}</span>}
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-text">{o.label}</span>
              {o.detail && (
                <span className="mt-0.5 block text-xs leading-4 text-muted">{o.detail}</span>
              )}
            </span>
            <span
              aria-hidden="true"
              className={cx(
                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full transition-colors duration-150",
                on ? "bg-accent" : "shadow-[inset_0_0_0_1.5px_var(--color-line-strong)]",
              )}
            >
              {on && <span className="size-1.5 rounded-full bg-white" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A short choice as buttons in a pill. */
function SegmentedControl({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-fit max-w-full rounded-full bg-field p-0.5 shadow-field"
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: styled radios inside a radiogroup.
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-[26px] cursor-pointer rounded-full px-3 text-xs whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
            value === o.value
              ? "bg-surface-3 text-text shadow-active"
              : "text-subtle enabled:hover:text-soft",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A number field that keeps what you typed until it parses. */
function NumberInput({
  id,
  value,
  integer,
  min,
  max,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  value: number | undefined;
  integer: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const emitted = useRef(value);
  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      setText(value === undefined ? "" : String(value));
    }
  }, [value]);
  return (
    <Input
      id={id}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      step={integer ? 1 : "any"}
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        const n = e.target.value === "" ? undefined : Number(e.target.value);
        if (n === undefined || Number.isFinite(n)) {
          emitted.current = n;
          onChange(n);
        }
      }}
    />
  );
}

function showJson(v: unknown): string {
  return v === undefined ? "" : JSON.stringify(v, null, 2);
}

/** A JSON textarea that only passes on values that parse. */
export function JsonInput({
  id,
  value,
  disabled,
  rows = 5,
  onChange,
}: {
  id?: string;
  value: unknown;
  disabled?: boolean;
  rows?: number;
  onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => showJson(value));
  const [error, setError] = useState<string | null>(null);
  const emitted = useRef(value);
  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      setText(showJson(value));
      setError(null);
    }
  }, [value]);
  return (
    <div className="space-y-1">
      <Textarea
        id={id}
        rows={rows}
        spellCheck={false}
        className={cx("font-mono text-xs", error && "border-danger")}
        value={text}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === "") {
            setError(null);
            emitted.current = undefined;
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(e.target.value);
            setError(null);
            emitted.current = parsed;
            onChange(parsed);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Invalid JSON");
          }
        }}
      />
      {error && <p className="text-xs text-danger">Invalid JSON: {error}</p>}
    </div>
  );
}

/** Multi-line text with a large editor for prompts and templates. */
export function LongText({
  id,
  label,
  value,
  placeholder,
  disabled,
  monospace: initialMono = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  monospace?: boolean;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mono, setMono] = useState(initialMono);
  return (
    <div className="space-y-1.5">
      <Textarea
        id={id}
        rows={4}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        className={cx(mono && "font-mono text-xs")}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)} disabled={disabled}>
          Open editor
        </Button>
      </div>
      {open && (
        <Dialog
          wide
          title={label}
          onClose={() => setOpen(false)}
          footer={
            <>
              <span className="mr-auto flex items-center gap-2 text-[13px]">
                <Switch checked={mono} onChange={setMono} label="Monospace" size="sm" />
                Monospace
              </span>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </>
          }
        >
          <Textarea
            aria-label={label}
            rows={22}
            value={value}
            spellCheck={!mono}
            className={cx("min-h-[50vh]", mono && "font-mono text-xs")}
            onChange={(e) => onChange(e.target.value)}
          />
        </Dialog>
      )}
    </div>
  );
}

function ChipList({
  id,
  label,
  placeholder,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  placeholder?: string;
  value: string[];
  disabled?: boolean;
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s && !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setDraft("");
  };
  return (
    <div className="rounded-lg bg-field p-1.5 shadow-field transition-shadow duration-150 focus-within:shadow-focus">
      <ul className="flex flex-wrap gap-1.5" aria-label={label}>
        {value.map((v, i) => (
          <li
            key={v}
            className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-3 pr-1 pl-2 text-xs"
          >
            <span className="max-w-56 truncate font-mono text-xs">{v}</span>
            <button
              type="button"
              aria-label={`Remove ${v}`}
              disabled={disabled}
              className="rounded px-1 text-muted hover:text-text"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </li>
        ))}
        <li className="min-w-32 flex-1">
          <input
            id={id}
            aria-label={`Add to ${label}`}
            className="h-7 w-full bg-transparent px-1.5 text-[13px] outline-none placeholder:text-subtle focus-visible:outline-none"
            placeholder={value.length ? "Add another" : (placeholder ?? "Type and press Enter")}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              } else if (e.key === "Backspace" && draft === "" && value.length) {
                onChange(value.slice(0, -1));
              }
            }}
          />
        </li>
      </ul>
    </div>
  );
}

function RowList({
  field,
  value,
  disabled,
  onChange,
}: {
  field: Extract<FormField, { kind: "objectList" }>;
  value: Record<string, unknown>[];
  disabled?: boolean;
  onChange: (v: Record<string, unknown>[]) => void;
}) {
  const setRow = (i: number, row: Record<string, unknown>) =>
    onChange(value.map((r, j) => (j === i ? row : r)));
  return (
    <div className="space-y-2">
      {value.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own.
        <div key={i} className="flex items-start gap-2 rounded-lg bg-surface-2/50 p-2 shadow-card">
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
            {field.fields.map((sub) => (
              <RowCell
                key={sub.key}
                field={sub}
                value={row[sub.key]}
                disabled={disabled}
                onChange={(v) => setRow(i, setField(row, sub, v))}
              />
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove row ${i + 1}`}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...value, blankRow(field.fields)])}
      >
        Add {field.label.toLowerCase().replace(/s$/, "")}
      </Button>
    </div>
  );
}

function RowCell({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FormField;
  value: unknown;
  disabled?: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = useId();
  const label = `${field.label}${field.required ? " *" : ""}`;
  if (field.kind === "boolean") {
    return (
      <span className="flex h-8 items-center gap-2 text-[13px]">
        <Switch checked={value === true} onChange={onChange} label={field.label} size="sm" />
        {field.label}
      </span>
    );
  }
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Control
        id={id}
        field={field}
        value={value}
        set={onChange}
        secret={false}
        placeholder={label}
        disabled={disabled}
        options={null}
      />
    </div>
  );
}
