import type { ConnectorView, InstallationView, SetupNoteView, SetupResultView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, CircleAlert, CircleCheck, Info } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { ApiError, api } from "../lib/api.ts";
import { defaultsFor, type FormField, formFields, type Primitive } from "../lib/schemaForm.ts";
import { qk } from "../lib/workflowApi.ts";
import { SchemaField } from "./SchemaForm.tsx";
import { Button, cx, Dialog, ErrorText, Field, Input } from "./ui.tsx";

type Source = "credentials" | "config";
interface Row {
  field: FormField;
  source: Source;
}

/** Credentials and settings in one list: by `order`, then credentials before config. */
function rowsOf(connector: ConnectorView): Row[] {
  const rows: (Row & { rank: number })[] = [
    ...formFields(connector.credentialsSchema).map((field, i) => ({
      field,
      source: "credentials" as const,
      rank: field.meta.order ?? i,
    })),
    ...formFields(connector.configSchema).map((field, i) => ({
      field,
      source: "config" as const,
      rank: field.meta.order ?? 1000 + i,
    })),
  ];
  return rows.sort((a, b) => a.rank - b.rank).map(({ field, source }) => ({ field, source }));
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

const TONE = {
  info: { icon: Info, className: "text-muted" },
  ok: { icon: CircleCheck, className: "text-ok" },
  warn: { icon: CircleAlert, className: "text-warn" },
  error: { icon: CircleAlert, className: "text-danger" },
} as const;

function Note({ note }: { note: SetupNoteView }) {
  const { icon: Icon, className } = TONE[note.tone];
  return (
    <p className={cx("flex items-start gap-1.5 text-xs leading-4", className)}>
      <Icon aria-hidden="true" size={13} className="mt-px shrink-0" />
      <span className="min-w-0">
        {note.text}
        {note.link && (
          <>
            {" "}
            <a
              href={note.link.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 whitespace-nowrap text-accent-text underline-offset-2 hover:underline"
            >
              {note.link.label}
              <ArrowUpRight aria-hidden="true" size={12} />
            </a>
          </>
        )}
      </span>
    </p>
  );
}

/**
 * Adds or edits a connector installation. Asks only for what the connector
 * can't work out itself: its setup lookup fills in servers, offers pickers,
 * and points at where to get a password, as you type.
 */
export function ConnectorSetupDialog({
  connector,
  installation,
  title,
  onClose,
  onSaved,
}: {
  connector: ConnectorView;
  installation?: InstallationView;
  title?: string;
  onClose: () => void;
  onSaved?: (installation: InstallationView) => void;
}) {
  const qc = useQueryClient();
  const editing = installation !== undefined;
  const rows = useMemo(() => rowsOf(connector), [connector]);
  const [name, setName] = useState(installation?.name ?? "");
  // Credentials are write-only: editing starts blank and sends only what you type.
  const [credentials, setCredentials] = useState<Record<string, unknown>>(() =>
    editing ? {} : defaultsFor(connector.credentialsSchema),
  );
  const initialConfig = useMemo(
    () => ({ ...defaultsFor(connector.configSchema), ...(installation?.config ?? {}) }),
    [connector, installation],
  );
  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig);
  const touched = useRef(new Set<string>());
  const [found, setFound] = useState<SetupResultView>({});
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  // Once shown, a field stays put, even after a later lookup fills it.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const credentialsStored = editing && installation.hasCredentials;

  const current = (key: string): unknown =>
    key in config ? config[key] : key in credentials ? credentials[key] : undefined;
  const visible = (f: FormField): boolean => {
    for (const [key, allowed] of Object.entries(f.meta.showWhen ?? {})) {
      const row = rows.find((r) => r.field.key === key);
      const v = current(key) ?? row?.field.default;
      if (!allowed.includes(v as Primitive)) return false;
    }
    if (f.meta.hidden) return false;
    if (f.meta.picker && !(found.options?.[f.key]?.length ?? 0)) return false;
    return true;
  };
  const shown = rows.filter((r) => visible(r.field));
  const main = shown.filter((r) => !r.field.meta.advanced || revealed.has(r.field.key));
  const advanced = shown.filter((r) => r.field.meta.advanced && !revealed.has(r.field.key));

  // ---------------------------------------------------------------- setup lookup
  const lookupKeys = rows.filter((r) => r.field.meta.lookup).map((r) => r.field.key);
  const lookupInput = JSON.stringify(lookupKeys.map(current));
  const latest = useRef({ credentials, config });
  latest.current = { credentials, config };
  const seq = useRef(0);
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reruns only when a lookup field changes, or on a retry.
  useEffect(() => {
    if (!connector.hasSetup) return;
    const n = ++seq.current;
    const delay = first.current ? 0 : 450;
    first.current = false;
    const timer = setTimeout(async () => {
      try {
        const result = await api.post<SetupResultView>(`/api/connectors/${connector.id}/setup`, {
          credentials: latest.current.credentials,
          config: latest.current.config,
          ...(editing ? { installationId: installation.id } : {}),
        });
        if (n !== seq.current || !result) return;
        const fill = (prev: Record<string, unknown>, next?: Record<string, unknown>) => {
          if (!next) return prev;
          const out = { ...prev };
          for (const [k, v] of Object.entries(next)) if (!touched.current.has(k)) out[k] = v;
          return out;
        };
        setCredentials((prev) => fill(prev, result.credentials));
        setConfig((prev) => fill(prev, result.config));
        setFound(result);
        if (result.reveal?.length) {
          setRevealed((prev) => new Set([...prev, ...(result.reveal ?? [])]));
        }
      } catch {
        // The form works without the lookup.
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [lookupInput, retry]);
  useEffect(() => {
    if (!found.retryAfterMs) return;
    const t = setTimeout(() => setRetry((n) => n + 1), found.retryAfterMs);
    return () => clearTimeout(t);
  }, [found]);

  // ---------------------------------------------------------------- saving
  const missing = shown.filter((r) => {
    if (!r.field.required || r.field.kind === "boolean") return false;
    if (r.source === "credentials" && credentialsStored) return false;
    return isEmpty(r.source === "credentials" ? credentials[r.field.key] : config[r.field.key]);
  });

  const save = useMutation({
    mutationFn: async (force: boolean) => {
      setFailed(null);
      if (!editing) {
        return api.post<InstallationView>("/api/installations", {
          connectorId: connector.id,
          ...(found.name ? { name: found.name } : {}),
          credentials,
          config,
          check: !force,
        });
      }
      const body: Record<string, unknown> = {};
      if (name.trim() && name.trim() !== installation.name) body.name = name.trim();
      if (JSON.stringify(config) !== JSON.stringify(initialConfig)) body.config = config;
      const typed = Object.fromEntries(Object.entries(credentials).filter(([, v]) => !isEmpty(v)));
      if (Object.keys(typed).length > 0) body.credentials = typed;
      // Only new credentials or settings need checking.
      if (body.config || body.credentials) body.check = !force;
      return api.patch<InstallationView>(`/api/installations/${installation.id}`, body);
    },
    onSuccess: (res) => {
      if (res && typeof res === "object" && "id" in res) {
        qc.setQueryData<InstallationView[]>(qk.installations(), (list) => {
          if (!list) return list;
          return list.some((x) => x.id === res.id)
            ? list.map((x) => (x.id === res.id ? res : x))
            : [...list, res];
        });
        onSaved?.(res);
      }
      void qc.invalidateQueries({ queryKey: qk.installations() });
      onClose();
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        err.status === 422 &&
        (err.body as { check?: string } | null)?.check === "failed"
      ) {
        setFailed(err.message);
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing.length === 0) save.mutate(failed !== null);
  };

  const edit = (source: Source) => (next: Record<string, unknown>, key: string) => {
    touched.current.add(key);
    setFailed(null);
    if (source === "credentials") setCredentials(next);
    else setConfig(next);
  };

  const notesFor = (key?: string) =>
    (found.notes ?? []).filter((n) => (key ? n.field === key : !n.field || !shownKey(n.field)));
  const shownKey = (key: string) =>
    main.some((r) => r.field.key === key) || (more && advanced.some((r) => r.field.key === key));

  const renderRow = (r: Row) => {
    const value = r.source === "credentials" ? credentials : config;
    const notes = notesFor(r.field.key);
    return (
      <SchemaField
        key={`${r.source}.${r.field.key}`}
        field={r.field}
        value={value}
        onChange={edit(r.source)}
        form={{
          secretFields: r.source === "credentials" ? connector.secretFields : undefined,
          placeholder: r.source === "credentials" && credentialsStored ? "Stored" : undefined,
          secretPlaceholder: credentialsStored ? "Stored (hidden)" : undefined,
          options: found.options,
          override: () =>
            notes.length > 0
              ? {
                  after: (
                    <div className="space-y-1">
                      {notes.map((n) => (
                        <Note key={n.text} note={n} />
                      ))}
                    </div>
                  ),
                }
              : null,
        }}
      />
    );
  };

  const general = notesFor();
  const action = editing ? "Save" : "Add";

  return (
    <Dialog
      title={title ?? (editing ? `Edit ${installation.name}` : `Add ${connector.name}`)}
      description={connector.description}
      onClose={onClose}
      footer={
        <>
          {missing.length > 0 && !failed && (
            <p className="mr-auto text-xs text-muted">
              Still needed: {missing.map((r) => r.field.label).join(", ")}
            </p>
          )}
          {!failed && <ErrorText error={save.error} />}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="connector-setup"
            busy={save.isPending}
            disabled={missing.length > 0 || (editing && !name.trim())}
          >
            {failed ? `${action} anyway` : action}
          </Button>
        </>
      }
    >
      <form id="connector-setup" onSubmit={submit} className="space-y-4">
        {general.length > 0 && (
          <div className="space-y-1">
            {general.map((n) => (
              <Note key={n.text} note={n} />
            ))}
          </div>
        )}
        {editing && (
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
        )}
        {main.map(renderRow)}
        {advanced.length > 0 && (
          <div>
            <button
              type="button"
              aria-expanded={more}
              onClick={() => setMore((v) => !v)}
              className="-ml-1 inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1 text-xs text-muted transition-colors duration-150 hover:text-text"
            >
              <ChevronRight
                aria-hidden="true"
                size={14}
                className={cx("transition-transform duration-150", more && "rotate-90")}
              />
              More settings
            </button>
            {more && <div className="mt-3 space-y-4">{advanced.map(renderRow)}</div>}
          </div>
        )}
        {connector.setupHelp && !connector.hasSetup && <SetupHelp text={connector.setupHelp} />}
        {failed && (
          <p
            role="alert"
            className="flex items-start gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-xs leading-4 text-danger"
          >
            <CircleAlert aria-hidden="true" size={13} className="mt-px shrink-0" />
            <span className="min-w-0">{failed}</span>
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** An extension's own setup steps, closed until asked for. */
function SetupHelp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-ml-1 inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1 text-xs text-muted transition-colors duration-150 hover:text-text"
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          className={cx("transition-transform duration-150", open && "rotate-90")}
        />
        Where to find these
      </button>
      {open && (
        <div className="prose-chat mt-2 rounded-lg bg-surface-2 p-3 text-xs leading-5 text-muted shadow-raised">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  );
}
