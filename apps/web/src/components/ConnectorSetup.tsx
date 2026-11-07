import type { ConnectorView, InstallationView, SetupNoteView, SetupResultView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, CircleAlert, CircleCheck, Info } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { ApiError, api } from "../lib/api.ts";
import { defaultsFor, type FormField, formFields, type Primitive } from "../lib/schemaForm.ts";
import { connectUrl, signInFor } from "../lib/signIn.ts";
import { qk } from "../lib/workflowApi.ts";
import { SchemaField } from "./SchemaForm.tsx";
import { Button, cx, Field, Input } from "./ui.tsx";
import { type ReviewRow, Wizard, type WizardStep } from "./Wizard.tsx";

type Source = "credentials" | "config";
interface Row {
  field: FormField;
  source: Source;
  rank: number;
}

/** The step heading for fields that don't name one. */
const DETAILS = "Details";

/** Credentials and settings in one list: by `order`, then credentials before config. */
function rowsOf(connector: ConnectorView): Row[] {
  const rows: Row[] = [
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
  return rows.sort((a, b) => a.rank - b.rank);
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

function Notes({ notes }: { notes: SetupNoteView[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="space-y-1">
      {notes.map((n) => (
        <Note key={`${n.tone}.${n.text}`} note={n} />
      ))}
    </div>
  );
}

/**
 * Adds or edits a connector installation, one step at a time. Asks only for
 * what the connector can't work out itself: its setup lookup fills in
 * servers, offers pickers, and points at where to get a password, as you type.
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
  const [lookingUp, setLookingUp] = useState(Boolean(connector.hasSetup));
  const [failed, setFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState<InstallationView | null>(null);
  const [retry, setRetry] = useState(0);
  // Set by "Add anyway", for the one finish it starts.
  const force = useRef(false);
  // Once shown, a field stays put, even after a later lookup fills it.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const credentialsStored = editing && installation.hasCredentials;

  const current = (key: string): unknown =>
    key in config ? config[key] : key in credentials ? credentials[key] : undefined;
  const rowValue = (r: Row) => (r.source === "credentials" ? credentials : config)[r.field.key];
  /** Whether the field applies at all, with what's picked so far. */
  const applies = (f: FormField): boolean => {
    for (const [key, allowed] of Object.entries(f.meta.showWhen ?? {})) {
      const row = rows.find((r) => r.field.key === key);
      const v = current(key) ?? row?.field.default;
      if (!allowed.includes(v as Primitive)) return false;
    }
    return !f.meta.hidden;
  };
  const visible = (f: FormField): boolean =>
    applies(f) && !(f.meta.picker && !(found.options?.[f.key]?.length ?? 0));
  // Ends on the provider's consent page, so what's only known after it, such as
  // the account's calendars, isn't asked for now.
  const withDefaults = Object.fromEntries(
    rows.map((r) => [r.field.key, current(r.field.key) ?? r.field.default]),
  );
  const signIn = signInFor(connector, withDefaults);
  const signingIn = signIn !== null && !editing;
  const required = (r: Row) =>
    r.field.required ||
    (signIn !== null && r.source === "credentials" && signIn.fields.includes(r.field.key));
  const [redirecting, setRedirecting] = useState(false);
  const filled = (r: Row) =>
    !isEmpty(rowValue(r)) || (r.source === "credentials" && credentialsStored);
  // An advanced field comes up front when the lookup couldn't fill it, or, for a
  // connector without a lookup, while it's required and empty. Nothing that still
  // needs an answer waits under More settings.
  const upFront = (r: Row) =>
    !r.field.meta.advanced ||
    revealed.has(r.field.key) ||
    (!connector.hasSetup && required(r) && !filled(r));

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
    setLookingUp(true);
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
      } finally {
        if (n === seq.current) setLookingUp(false);
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [lookupInput, retry]);
  useEffect(() => {
    if (!found.retryAfterMs) return;
    const t = setTimeout(() => setRetry((n) => n + 1), found.retryAfterMs);
    return () => clearTimeout(t);
  }, [found]);

  // ---------------------------------------------------------------- steps
  const shown = rows.filter((r) => visible(r.field));
  // A picker the lookup hasn't filled yet still holds its step's place, so the
  // steps don't change count, or Add turn into Continue, while you type.
  const waiting = (r: Row) =>
    Boolean(connector.hasSetup) &&
    !signingIn &&
    r.field.meta.picker &&
    !r.field.meta.advanced &&
    applies(r.field) &&
    !visible(r.field);
  const asks = (r: Row) => visible(r.field) && upFront(r);
  const groups = new Map<string, Row[]>();
  for (const r of rows.filter((x) => visible(x.field) || waiting(x))) {
    const key = r.field.meta.step ?? DETAILS;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const ordered = [...groups.entries()].sort(
    (a, b) => Math.min(...a[1].map((r) => r.rank)) - Math.min(...b[1].map((r) => r.rank)),
  );
  // A step is asked only when it has something to ask; the rest of its fields
  // wait under the last step's More settings.
  const included = ([, rs]: [string, Row[]]) => rs.some(asks) || rs.some(waiting);
  const asked = ordered.filter(included);
  const tucked = ordered
    .filter((g) => !included(g))
    .flatMap(([, rs]) => rs)
    .filter((r) => visible(r.field));
  const stepGroups: [string, Row[]][] = asked.length > 0 ? asked : [[DETAILS, []]];

  const notes = found.notes ?? [];
  const shownKeys = new Set(shown.map((r) => r.field.key));
  const notesFor = (key: string) => notes.filter((n) => n.field === key);
  const general = notes.filter((n) => !n.field || !shownKeys.has(n.field));

  const edit = (source: Source) => (next: Record<string, unknown>, key: string) => {
    touched.current.add(key);
    setFailed(null);
    if (source === "credentials") setCredentials(next);
    else setConfig(next);
  };

  const renderRow = (r: Row, bare: boolean) => (
    <SchemaField
      key={`${r.source}.${r.field.key}`}
      field={r.field}
      value={r.source === "credentials" ? credentials : config}
      onChange={edit(r.source)}
      form={{
        secretFields: r.source === "credentials" ? connector.secretFields : undefined,
        placeholder: r.source === "credentials" && credentialsStored ? "Stored" : undefined,
        secretPlaceholder: credentialsStored ? "Stored (hidden)" : undefined,
        options: found.options,
        bareLabel: bare,
        hideRequired: true,
        override: () => {
          const own = notesFor(r.field.key);
          return own.length > 0 ? { after: <Notes notes={own} /> } : null;
        },
      }}
    />
  );

  const steps: WizardStep[] = stepGroups.map(([heading, rs], i) => {
    const front = rs.filter(asks);
    const more = [
      ...rs.filter((r) => visible(r.field) && !upFront(r)),
      ...(i === stepGroups.length - 1 ? tucked : []),
    ];
    const missing = front.some((r) => required(r) && r.field.kind !== "boolean" && !filled(r));
    const wrong = front.some((r) => notesFor(r.field.key).some((n) => n.tone === "error"));
    const looksUp = front.some((r) => r.field.meta.lookup) || rs.some(waiting);
    // One field under a heading that asks for it needs no label of its own.
    const bare = front.length === 1 && heading !== DETAILS;
    return {
      id: heading,
      title: heading === DETAILS ? `Connect ${connector.name}` : heading,
      blocked: missing || wrong,
      busy: looksUp && lookingUp,
      content: (
        <>
          <Notes notes={general} />
          {front.map((r) => renderRow(r, bare))}
          {more.length > 0 && (
            <Disclosure label="More settings" open={editing}>
              {more.map((r) => renderRow(r, false))}
            </Disclosure>
          )}
          {i === 0 && connector.setupHelp && !connector.hasSetup && (
            <Disclosure label="Where to find these">
              <div className="prose-chat rounded-lg bg-surface-2 p-3 text-xs leading-5 text-muted shadow-raised">
                <Markdown>{connector.setupHelp}</Markdown>
              </div>
            </Disclosure>
          )}
        </>
      ),
    };
  });

  // ---------------------------------------------------------------- saving
  const save = useMutation({
    mutationFn: async (force: boolean) => {
      setFailed(null);
      if (!editing) {
        return api.post<InstallationView>("/api/installations", {
          connectorId: connector.id,
          ...(found.name ? { name: found.name } : {}),
          credentials,
          config,
          // Nothing can be checked before the consent; the sign-in is the check.
          check: !force && !signingIn,
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
        setSaved(res);
        onSaved?.(res);
      }
      void qc.invalidateQueries({ queryKey: qk.installations() });
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

  const finish = async (force: boolean) => {
    try {
      const saved = await save.mutateAsync(force);
      if (signIn && signingIn && saved && typeof saved === "object" && "id" in saved) {
        setRedirecting(true);
        window.location.assign(connectUrl(signIn, saved.id));
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  // ---------------------------------------------------------------- review, for editing
  const shownValue = (r: Row): string => {
    const v = rowValue(r);
    if (r.source === "credentials" && connector.secretFields.includes(r.field.key)) {
      if (!isEmpty(v)) return "Changed";
      return credentialsStored ? "Stored" : "Not set";
    }
    if (r.source === "credentials" && credentialsStored && isEmpty(v)) return "Stored";
    if (typeof v === "boolean") return v ? "On" : "Off";
    const options = found.options?.[r.field.key];
    const named = (x: unknown) => options?.find((o) => o.value === x)?.label ?? String(x);
    if (Array.isArray(v)) {
      if (v.length === 0) return r.field.meta.emptyMeansAll ? "All" : "None";
      return v.map(named).join(", ");
    }
    if (r.field.kind === "enum") {
      return r.field.options.find((o) => o.value === v)?.label ?? String(v ?? "");
    }
    return isEmpty(v) ? "Not set" : named(v);
  };
  const review: ReviewRow[] | undefined = editing
    ? steps.flatMap((s, i) => {
        const rs = stepGroups[i]?.[1] ?? [];
        const all = [...rs, ...(i === steps.length - 1 ? tucked : [])].filter((r) =>
          visible(r.field),
        );
        return all.map((r) => ({ stepId: s.id, label: r.field.label, value: shownValue(r) }));
      })
    : undefined;

  const okNotes = notes.filter((n) => n.tone === "ok");
  const action = editing ? "Save" : signingIn ? "Connect" : "Add";
  const problem: ReactNode = failed ?? (save.error instanceof Error ? save.error.message : null);

  return (
    <Wizard
      title={title ?? (editing ? `Edit ${installation.name}` : `Add ${connector.name}`)}
      steps={steps}
      finishLabel={action}
      onFinish={() => {
        const anyway = force.current;
        force.current = false;
        return finish(anyway);
      }}
      finishing={save.isPending || redirecting}
      error={problem}
      secondary={
        failed
          ? (run: () => void) => (
              <Button
                busy={save.isPending}
                onClick={() => {
                  force.current = true;
                  run();
                }}
              >
                {action} anyway
              </Button>
            )
          : null
      }
      review={review}
      reviewTop={
        editing ? (
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
        ) : undefined
      }
      done={
        editing ? undefined : (
          <>
            <p className="text-sm font-medium">{saved?.name ?? connector.name} is connected</p>
            {okNotes.length > 0 && (
              <p className="mt-1 text-xs leading-4 text-muted">
                {okNotes.map((n) => n.text).join(" · ")}
              </p>
            )}
          </>
        )
      }
      onClose={onClose}
    />
  );
}

function Disclosure({
  label,
  open: initial = false,
  children,
}: {
  label: string;
  open?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initial);
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
        {label}
      </button>
      {open && <div className="mt-3 space-y-4">{children}</div>}
    </div>
  );
}
