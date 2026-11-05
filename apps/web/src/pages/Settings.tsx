import {
  type AssistantChoice,
  HARNESS_LABELS,
  HARNESSES,
  type Harness,
  MODE_POLICY,
  type ModelCatalogView,
  type PermissionMode,
  type SandboxSettingsView,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Box,
  Cpu,
  Fingerprint,
  KeyRound,
  type LucideIcon,
  Plus,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { type FormEvent, lazy, type ReactNode, Suspense, useEffect, useId, useState } from "react";
import { ChatControls } from "../components/ModelPicker.tsx";
import { Page } from "../components/Page.tsx";
import { ProviderIcon } from "../components/ProviderIcon.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  Input,
  Select,
  Skeleton,
  Spinner,
  useConfirm,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import { ago, plural } from "../lib/format.ts";
import { modelsKey, useModelCatalog, useSaveProviderKey } from "../lib/models.ts";
import {
  costPerHourBody,
  providerInstallations,
  type SecretKey,
  secretsBody,
} from "../lib/sandbox.ts";
import { isSandboxSettingsView, sandboxApi, useSandboxSettings } from "../lib/sandboxApi.ts";
import type { ProviderInfo, Settings } from "../lib/types.ts";
import { qk, useConnectors, useInstallations } from "../lib/workflowApi.ts";

const SECTIONS: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "model", label: "Models", icon: Cpu },
  { id: "mode", label: "Permission mode", icon: ShieldCheck },
  { id: "sandboxes", label: "Sandboxes", icon: Box },
  { id: "security", label: "Sign-in security", icon: KeyRound },
];

export function SettingsPage() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/api/settings"),
  });
  const [current, setCurrent] = useState("model");
  return (
    <Page title="Settings">
      <div className="mx-auto flex w-full max-w-5xl gap-10 px-5 py-6">
        <nav
          aria-label="Settings sections"
          className="sticky top-6 hidden w-44 shrink-0 self-start lg:block"
        >
          <ul className="space-y-px">
            {SECTIONS.map((sec) => {
              const Icon = sec.icon;
              return (
                <li key={sec.id}>
                  <a
                    href={`#${sec.id}`}
                    onClick={() => setCurrent(sec.id)}
                    className={cx(
                      "group flex h-[30px] items-center gap-2 rounded-lg px-2 text-[13px] font-medium transition-colors duration-150",
                      current === sec.id
                        ? "bg-surface-3 text-text shadow-active"
                        : "text-muted hover:text-text",
                    )}
                  >
                    <Icon
                      aria-hidden="true"
                      className={cx(
                        "transition-colors duration-150",
                        current === sec.id ? "text-icon" : "text-subtle group-hover:text-icon",
                      )}
                    />
                    {sec.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 space-y-10">
          {settings.isPending && <Skeleton className="h-64 w-full rounded-xl" />}
          <ErrorText error={settings.error} />
          {settings.data && (
            <>
              <ModelSection settings={settings.data} />
              <ModeSection settings={settings.data} />
            </>
          )}
          <SandboxSection />
          <SecuritySection />
        </div>
      </div>
    </Page>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 space-y-3">
      <div>
        <h2 id={`${id}-title`} className="text-sm font-medium">
          {title}
        </h2>
        {description && (
          <p className="mt-1 max-w-2xl text-xs leading-[18px] text-muted">{description}</p>
        )}
      </div>
      <Card className="p-5">{children}</Card>
    </section>
  );
}

function ModelSection({ settings }: { settings: Settings }) {
  const catalog = useModelCatalog();
  const clis = (catalog.data?.assistant ?? []).filter((p) => p.kind === "cli");
  const anyKey = settings.providers.some((p) => p.connected);
  return (
    <Section
      id="model"
      title="Models"
      description="Sling chats through Codex or Claude Code on your machines, on the login you already have, so it uses your subscription. The assistant picks the coding agent and model for each task."
    >
      <div className="space-y-6 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-6">
        <ChatDefaults />
        <ul aria-label="Coding agents for chat" className="space-y-2">
          {clis.map((p) => (
            <li key={p.provider} className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 shadow-raised">
                <ProviderIcon provider={p.provider} size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{p.label}</p>
                <p className="text-xs text-muted">
                  {p.readyMachines > 0
                    ? `Ready on ${plural(p.readyMachines, "machine")}, ${plural(p.models.length, "model")}.`
                    : "Not logged in on any paired machine."}
                </p>
              </div>
              {p.readyMachines > 0 ? (
                <Badge tone="ok" dot>
                  Ready
                </Badge>
              ) : (
                <Link
                  to="/machines"
                  className="text-xs text-subtle transition-colors duration-150 hover:text-text"
                >
                  Machines
                </Link>
              )}
            </li>
          ))}
        </ul>
        <details className="group" open={anyKey}>
          <summary className="flex cursor-pointer items-center gap-2 text-[13px] font-medium select-none marker:text-subtle">
            API keys
            <span className="text-xs font-normal text-subtle">
              Optional. For chatting when no machine is on, or with another provider.
            </span>
          </summary>
          <ul aria-label="Model providers" className="mt-4 space-y-4">
            {settings.providers.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </ul>
        </details>
      </div>
    </Section>
  );
}

function ProviderRow({ provider: p }: { provider: ProviderInfo }) {
  const qc = useQueryClient();
  const saveKey = useSaveProviderKey();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? "");
  const save = useMutation({
    mutationFn: () =>
      saveKey(p.id, {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(p.needsBaseUrl ? { baseUrl: baseUrl.trim() || null } : {}),
      }),
    onSuccess: () => setApiKey(""),
  });
  const remove = useMutation({
    mutationFn: () => api.del<ModelCatalogView>(`/api/settings/providers/${p.id}`),
    onSuccess: (catalog) => {
      if (catalog) qc.setQueryData(modelsKey, catalog);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; models?: number; ms?: number; error?: string }>(
        `/api/settings/providers/${p.id}/test`,
      ),
  });
  const id = useId();
  const canSave = p.needsBaseUrl ? Boolean(baseUrl.trim()) : Boolean(apiKey.trim());

  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
        <ProviderIcon provider={p.id} size={17} />
      </span>
      <form
        className="min-w-0 flex-1 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={id} className="text-[13px] font-medium">
            {p.label}
          </label>
          {p.connected ? (
            <Badge tone="ok" dot>
              Connected
            </Badge>
          ) : (
            <Badge>Not connected</Badge>
          )}
          <span className="ml-auto flex items-center gap-1">
            {p.connected && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  busy={test.isPending}
                  onClick={() => test.mutate()}
                >
                  Test
                </Button>
                <Button
                  size="sm"
                  variant="ghost-danger"
                  busy={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Remove
                </Button>
              </>
            )}
          </span>
        </div>
        {p.needsBaseUrl && (
          <Input
            aria-label={`Base URL for ${p.label}`}
            placeholder="http://host.docker.internal:11434/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        )}
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            aria-label={`API key for ${p.label}`}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              p.hasKey
                ? "Stored. Paste a new key to replace it."
                : p.needsBaseUrl
                  ? "API key, if the server needs one"
                  : "Paste an API key"
            }
            autoComplete="off"
          />
          <Button type="submit" busy={save.isPending} disabled={!canSave}>
            {p.connected ? "Replace" : "Connect"}
          </Button>
        </div>
        {test.data &&
          (test.data.ok ? (
            <p className="text-xs text-ok">
              Works. {plural(test.data.models ?? 0, "model")} available, in {test.data.ms} ms.
            </p>
          ) : (
            <p className="text-xs text-danger">{test.data.error}</p>
          ))}
        <ErrorText error={save.error ?? remove.error ?? test.error} />
      </form>
    </li>
  );
}

/** What a new chat starts with, picked with the same picker as the composer. */
function ChatDefaults() {
  const qc = useQueryClient();
  const catalog = useModelCatalog();
  const save = useMutation({
    mutationFn: (patch: { assistant: AssistantChoice }) =>
      api.put<ModelCatalogView["defaults"]>("/api/settings/chat-defaults", patch),
    onSuccess: (defaults) => {
      qc.setQueryData<ModelCatalogView>(modelsKey, (c) => (c ? { ...c, defaults } : c));
      void qc.invalidateQueries({ queryKey: ["sandbox-settings"] });
    },
  });
  const defaults = catalog.data?.defaults;
  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium">New chats start with</p>
      <div className="w-fit rounded-xl bg-field p-1.5 shadow-field">
        {defaults ? (
          <ChatControls
            catalog={catalog.data}
            assistant={defaults.assistant}
            onAssistant={(assistant) => save.mutate({ assistant })}
          />
        ) : (
          <Spinner className="m-1 size-4" />
        )}
      </div>
      <p className="text-xs text-subtle">Any chat can switch from its composer.</p>
      <ErrorText error={save.error} />
    </div>
  );
}

function ModeSection({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (defaultMode: PermissionMode) => api.put("/api/settings/mode", { defaultMode }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  return (
    <Section
      id="mode"
      title="Default permission mode"
      description="New conversations start in this mode. You can switch any conversation later. Each machine can also cap the mode it accepts."
    >
      <div className="space-y-2">
        {settings.modes.map((m) => (
          <label
            key={m}
            className="flex cursor-pointer items-start gap-3 rounded-xl bg-surface-2 p-3 shadow-raised transition-shadow duration-150 hover:shadow-raised-hover has-[:checked]:shadow-[0_0_0_1px_var(--accent-text),inset_0_1px_0_0_rgb(255_255_255/0.08)] has-[:focus-visible]:shadow-focus"
          >
            <input
              type="radio"
              name="mode"
              className="mt-0.5 size-3.5 accent-[var(--accent)]"
              checked={settings.defaultMode === m}
              onChange={() => save.mutate(m)}
            />
            <span>
              <span className="text-[13px] font-medium">{MODE_POLICY[m].label}</span>
              <span className="mt-0.5 block text-xs leading-4 text-muted">
                {MODE_POLICY[m].description}
              </span>
            </span>
          </label>
        ))}
      </div>
      <ErrorText error={save.error} />
    </Section>
  );
}

function SandboxSection() {
  const settings = useSandboxSettings();
  return (
    <Section
      id="sandboxes"
      title="Sandboxes"
      description={
        <>
          When no machine can take a task, Sling can run it in a fresh sandbox from a provider under{" "}
          <Link to="/connectors" className="text-accent-text hover:underline">
            Connectors
          </Link>
          . A sandbox clones an allowed repo from its remote, runs the coding agent, and is
          destroyed.
        </>
      }
    >
      {settings.isPending && <Spinner />}
      <ErrorText error={settings.error} />
      {settings.data && (
        <div className="space-y-8 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-8">
          <SandboxLimits settings={settings.data} />
          <SandboxSecrets secrets={settings.data.secrets} />
        </div>
      )}
    </Section>
  );
}

/** A whole number at or above `min`, or null. */
function wholeNumber(text: string, min: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text);
  return n >= min ? n : null;
}

function SandboxLimits({ settings }: { settings: SandboxSettingsView }) {
  const qc = useQueryClient();
  const installations = useInstallations();
  const connectors = useConnectors();
  const providers = providerInstallations(installations.data ?? [], connectors.data ?? []);
  const [harness, setHarness] = useState<Harness>(settings.defaultHarness);
  const [concurrent, setConcurrent] = useState(String(settings.concurrentLimit));
  const [lifetime, setLifetime] = useState(String(settings.lifetimeMinutes));
  const [budget, setBudget] = useState(String(settings.monthlyMinutesBudget));
  const [costs, setCosts] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(settings.costPerHour).map(([id, n]) => [id, String(n)])),
  );

  const values = {
    concurrentLimit: wholeNumber(concurrent, 1),
    lifetimeMinutes: wholeNumber(lifetime, 1),
    monthlyMinutesBudget: wholeNumber(budget, 0),
  };
  const valid = Object.values(values).every((v) => v !== null);

  const save = useMutation({
    mutationFn: () =>
      sandboxApi.saveSettings({
        defaultHarness: harness,
        concurrentLimit: values.concurrentLimit ?? settings.concurrentLimit,
        lifetimeMinutes: values.lifetimeMinutes ?? settings.lifetimeMinutes,
        monthlyMinutesBudget: values.monthlyMinutesBudget ?? settings.monthlyMinutesBudget,
        costPerHour: costPerHourBody(costs),
      }),
    onSuccess: (res) => {
      if (isSandboxSettingsView(res)) qc.setQueryData(qk.sandboxSettings(), res);
      void qc.invalidateQueries({ queryKey: qk.sandboxSettings() });
      // Usage on the Sandboxes page shows the limit and budget.
      void qc.invalidateQueries({ queryKey: qk.sandboxes() });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (valid) save.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field
        label="Default coding agent"
        hint="Used when a request doesn't name one, on machines and in sandboxes."
      >
        <Select value={harness} onChange={(e) => setHarness(e.target.value as Harness)}>
          {HARNESSES.map((h) => (
            <option key={h} value={h}>
              {HARNESS_LABELS[h]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Concurrent sandboxes" hint="More requests wait.">
          <Input
            type="number"
            min={1}
            step={1}
            value={concurrent}
            onChange={(e) => setConcurrent(e.target.value)}
            required
          />
        </Field>
        <Field label="Lifetime (minutes)" hint="Longer ones are destroyed.">
          <Input
            type="number"
            min={1}
            step={1}
            value={lifetime}
            onChange={(e) => setLifetime(e.target.value)}
            required
          />
        </Field>
        <Field label="Minutes a month" hint="Requests over this are refused.">
          <Input
            type="number"
            min={0}
            step={1}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            required
          />
        </Field>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-soft">Estimated cost per hour</p>
        <p className="text-xs text-muted">
          Optional, in your own currency. With a cost set, the Sandboxes page shows estimated spend.
        </p>
        {providers.length === 0 ? (
          <p className="text-xs text-muted">
            Add a sandbox provider under Connectors to set what it costs.
          </p>
        ) : (
          <ul className="space-y-2">
            {providers.map((p) => (
              <li key={p.id} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
                <Input
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  aria-label={`Cost per hour for ${p.name}`}
                  placeholder="Not set"
                  className="max-w-32"
                  value={costs[p.id] ?? ""}
                  onChange={(e) => setCosts({ ...costs, [p.id]: e.target.value })}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" busy={save.isPending} disabled={!valid}>
          Save
        </Button>
        {!valid && (
          <span className="text-xs text-muted">
            Limits are whole numbers, and the concurrent limit and lifetime are at least 1.
          </span>
        )}
        {save.isSuccess && <span className="text-xs text-ok">Saved.</span>}
      </div>
      <ErrorText error={save.error} />
    </form>
  );
}

const SECRETS: { key: SecretKey; label: string; hint: ReactNode }[] = [
  {
    key: "openaiApiKey",
    label: "OpenAI API key",
    hint: "Codex logs in with it inside the sandbox.",
  },
  {
    key: "anthropicApiKey",
    label: "Anthropic API key",
    hint: "Claude Code uses it inside the sandbox.",
  },
  {
    key: "gitToken",
    label: "GitHub token",
    hint: (
      <>
        Use a fine-grained token limited to the repos you allow in sandboxes, with{" "}
        <strong className="font-medium text-text">Contents</strong> and{" "}
        <strong className="font-medium text-text">Pull requests</strong> set to read and write. The
        Runner uses it to clone, push, and open pull requests, and never passes it to the agent.
        Setup steps are in <code className="font-mono text-soft">docs/sandboxes.md</code>.
      </>
    ),
  },
];

function SandboxSecrets({ secrets }: { secrets: SandboxSettingsView["secrets"] }) {
  const { confirm, dialog } = useConfirm();
  const qc = useQueryClient();
  const [typed, setTyped] = useState<Partial<Record<SecretKey, string>>>({});
  const body = secretsBody(typed);
  // The secrets endpoint answers with `{ secrets }` only, so merge it into the
  // cached settings rather than replacing them.
  const onSaved = (res: { secrets: SandboxSettingsView["secrets"] } | null) => {
    if (res?.secrets) {
      qc.setQueryData<SandboxSettingsView>(qk.sandboxSettings(), (old) =>
        old ? { ...old, secrets: res.secrets } : old,
      );
    }
    void qc.invalidateQueries({ queryKey: qk.sandboxSettings() });
  };
  const save = useMutation({
    mutationFn: () => sandboxApi.saveSecrets(body),
    onSuccess: (res) => {
      setTyped({});
      onSaved(res);
    },
  });
  const clear = useMutation({
    mutationFn: (key: SecretKey) => sandboxApi.saveSecrets({ [key]: "" }),
    onSuccess: onSaved,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (Object.keys(body).length > 0) save.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h3 className="text-[13px] font-medium">Secrets</h3>
        <p className="mt-1 text-xs text-muted">
          Stored encrypted and never shown again. Sling passes them only to the sandbox running a
          task, and they're gone when it's destroyed. A provider with a custom image can bring its
          own logins instead.
        </p>
      </div>
      {SECRETS.map((s) => (
        <SecretField
          key={s.key}
          label={s.label}
          hint={s.hint}
          stored={secrets[s.key]}
          value={typed[s.key] ?? ""}
          onChange={(v) => setTyped({ ...typed, [s.key]: v })}
          clearing={clear.isPending && clear.variables === s.key}
          onClear={async () => {
            const ok = await confirm({
              title: `Clear the stored ${s.label}?`,
              body: "Sandboxes that need it fail to start until you add another.",
              action: "Clear",
              danger: true,
            });
            if (ok) clear.mutate(s.key);
          }}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          busy={save.isPending}
          disabled={Object.keys(body).length === 0}
        >
          Save secrets
        </Button>
        {save.isSuccess && <span className="text-xs text-ok">Saved.</span>}
      </div>
      <ErrorText error={save.error ?? clear.error} />
      {dialog}
    </form>
  );
}

function SecretField({
  label,
  hint,
  stored,
  value,
  onChange,
  clearing,
  onClear,
}: {
  label: string;
  hint: ReactNode;
  stored: boolean;
  value: string;
  onChange: (value: string) => void;
  clearing: boolean;
  onClear: () => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <div className="flex min-h-8 items-center gap-2">
        <label htmlFor={id} className="text-xs font-medium text-soft">
          {label}
        </label>
        {stored ? <Badge tone="ok">Stored</Badge> : <Badge>Not set</Badge>}
        {stored && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            busy={clearing}
            aria-label={`Clear ${label}`}
            onClick={onClear}
          >
            Clear
          </Button>
        )}
      </div>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={stored ? "Stored (hidden). Type to replace it." : ""}
        autoComplete="off"
      />
      <p className="text-xs leading-4 text-subtle">{hint}</p>
    </div>
  );
}

function SecuritySection() {
  const session = authClient.useSession();
  const enabled = Boolean(
    (session.data?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled,
  );
  return (
    <Section
      id="security"
      title="Sign-in security"
      description="This account can start work on your machines, so protect it with a passkey or a second factor."
    >
      <div className="space-y-6 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-6">
        <TwoFactor
          enabled={enabled}
          email={session.data?.user.email ?? ""}
          onChange={() => session.refetch()}
        />
        <Passkeys />
      </div>
    </Section>
  );
}

const TwoFactorDialog = lazy(() =>
  import("../components/TwoFactorDialog.tsx").then((m) => ({ default: m.TwoFactorDialog })),
);

function TwoFactor({
  enabled,
  email,
  onChange,
}: {
  enabled: boolean;
  email: string;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
        <Smartphone aria-hidden="true" size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          Authenticator app
          {enabled ? (
            <Badge tone="ok" dot>
              On
            </Badge>
          ) : (
            <Badge>Off</Badge>
          )}
        </p>
        <p className="text-xs text-muted">
          {enabled
            ? "Signing in asks for a code from your authenticator app."
            : "Ask for a code from your phone when signing in."}
        </p>
      </div>
      <Button variant={enabled ? "ghost-danger" : "secondary"} onClick={() => setOpen(true)}>
        {enabled ? "Turn off" : "Set up"}
      </Button>
      {open && (
        <Suspense fallback={null}>
          <TwoFactorDialog
            action={enabled ? "disable" : "enable"}
            email={email}
            onClose={() => setOpen(false)}
            onDone={onChange}
          />
        </Suspense>
      )}
    </div>
  );
}

function Passkeys() {
  const list = authClient.useListPasskeys();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setError(null), []);

  async function add() {
    setBusy(true);
    setError(null);
    const res = await authClient.passkey.addPasskey({ name: navigator.platform || "Passkey" });
    setBusy(false);
    if (res?.error) setError(res.error.message ?? "Couldn't add the passkey.");
    list.refetch();
  }

  async function remove(id: string) {
    await authClient.passkey.deletePasskey({ id });
    list.refetch();
  }

  const passkeys = list.data ?? [];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
          <Fingerprint aria-hidden="true" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            Passkeys
            {passkeys.length > 0 && <Badge tone="ok">{passkeys.length}</Badge>}
          </p>
          <p className="text-xs text-muted">Sign in with Touch ID, Face ID, or a security key.</p>
        </div>
        <Button icon={Plus} busy={busy} onClick={add}>
          Add passkey
        </Button>
      </div>
      {passkeys.length > 0 && (
        <ul className="mt-3 ml-12 divide-y divide-border rounded-xl bg-field shadow-field">
          {passkeys.map((p) => (
            <li key={p.id} className="flex h-10 items-center gap-2 px-3 text-[13px]">
              <KeyRound aria-hidden="true" className="text-subtle" />
              <span className="min-w-0 flex-1 truncate">{p.name ?? "Passkey"}</span>
              <span className="text-xs text-subtle">added {ago(String(p.createdAt))}</span>
              <Button
                size="sm"
                variant="ghost-danger"
                aria-label={`Remove ${p.name ?? "passkey"}`}
                onClick={() => remove(p.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 ml-12">
        <ErrorText error={error} />
      </div>
    </div>
  );
}
