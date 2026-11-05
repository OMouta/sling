import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { blankRow, type FormField, setField } from "../lib/schemaForm.ts";
import { Button, cx, Dialog, Input, Select, Switch, Textarea } from "./ui.tsx";

export interface FieldOverride {
  /** Replaces the default control. */
  control?: ReactNode;
  /** Shown at the end of the label row, for example a mode toggle. */
  accessory?: ReactNode;
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
}

/** A form generated from JSON Schema fields. */
export function SchemaForm(props: SchemaFormProps) {
  const { fields, value, onChange } = props;
  if (fields.length === 0) return <p className="text-sm text-muted">No settings.</p>;
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
  const placeholder = secret ? (form.secretPlaceholder ?? form.placeholder) : form.placeholder;
  const control = custom?.control ?? (
    <Control
      id={id}
      field={field}
      value={value}
      set={set}
      secret={secret}
      placeholder={placeholder}
      disabled={form.disabled}
    />
  );
  const labelFor = field.kind === "boolean" || field.kind === "stringList" ? undefined : id;
  return (
    <div className="space-y-1.5" data-field={field.key}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={labelFor} className="text-sm font-medium">
          {field.label}
          {field.required && (
            <span className="ml-0.5 text-danger" title="Required">
              *
            </span>
          )}
        </label>
        {custom?.accessory}
      </div>
      {control}
      {field.description && <p className="text-xs text-muted">{field.description}</p>}
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
}: {
  id: string;
  field: FormField;
  value: unknown;
  set: (v: unknown) => void;
  secret: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const fallback =
    field.default !== undefined && typeof field.default !== "object"
      ? String(field.default)
      : undefined;
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
        <fieldset className="rounded-lg border border-border p-3">
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
              <span className="mr-auto flex items-center gap-2 text-sm">
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
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
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
    <div className="rounded-lg border border-border bg-surface p-1.5 focus-within:border-accent">
      <ul className="flex flex-wrap gap-1.5" aria-label={label}>
        {value.map((v, i) => (
          <li
            key={v}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-surface-2 pr-1 pl-2 text-sm"
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
            className="h-7 w-full bg-transparent px-1.5 text-sm outline-none placeholder:text-muted"
            placeholder={value.length ? "Add another" : "Type and press Enter"}
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
        <div key={i} className="flex items-start gap-2 rounded-lg border border-border p-2">
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
      <span className="flex h-9 items-center gap-2 text-sm">
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
      />
    </div>
  );
}
