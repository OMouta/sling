import {
  HARNESS_LABELS,
  HARNESSES,
  type Harness,
  MODE_POLICY,
  type PermissionMode,
  type SandboxSettingsView,
} from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { authClient } from "../lib/auth.ts";
import {
  costPerHourBody,
  providerInstallations,
  type SecretKey,
  secretsBody,
} from "../lib/sandbox.ts";
import { isSandboxSettingsView, sandboxApi, useSandboxSettings } from "../lib/sandboxApi.ts";
import type { ProviderInfo, Settings } from "../lib/types.ts";
import { qk, useConnectors, useInstallations } from "../lib/workflowApi.ts";

export function SettingsPage() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/api/settings"),
  });
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <PageHeader title="Settings" />
      {settings.isPending && <Spinner />}
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
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="p-5">
      <h2 className="font-medium">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

function ModelSection({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [provider, setProvider] = useState<ProviderInfo["id"]>(
    settings.model?.provider ?? "openai",
  );
  const info = settings.providers.find((p) => p.id === provider);
  const [model, setModel] = useState(settings.model?.model ?? info?.defaultModel ?? "");
  const [baseUrl, setBaseUrl] = useState(settings.model?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.put("/api/settings/model", {
        provider,
        model,
        baseUrl: info?.needsBaseUrl ? baseUrl : null,
        ...(apiKey ? { apiKey } : {}),
      }),
    onSuccess: () => {
      setApiKey("");
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; reply?: string; error?: string; ms?: number }>(
        "/api/settings/model/test",
      ),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <Section
      title="Model"
      description="The model behind Sling's assistant. Coding agents use their own login on each machine."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Provider">
          <Select
            value={provider}
            onChange={(e) => {
              const id = e.target.value as ProviderInfo["id"];
              setProvider(id);
              setModel(settings.providers.find((p) => p.id === id)?.defaultModel ?? "");
            }}
          >
            {settings.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model">
          <Input value={model} onChange={(e) => setModel(e.target.value)} required />
        </Field>
        {info?.needsBaseUrl && (
          <Field
            label="Base URL"
            hint="For Ollama on this server: http://host.docker.internal:11434/v1"
          >
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              required
            />
          </Field>
        )}
        <Field
          label="API key"
          hint={
            settings.model?.hasKey
              ? "A key is stored, encrypted. Leave empty to keep it."
              : "Stored encrypted."
          }
        >
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings.model?.hasKey ? "••••••••" : ""}
            autoComplete="off"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save
          </Button>
          <Button busy={test.isPending} disabled={!settings.model} onClick={() => test.mutate()}>
            Test connection
          </Button>
          {save.isSuccess && <span className="text-sm text-ok">Saved.</span>}
          {test.data &&
            (test.data.ok ? (
              <span className="text-sm text-ok">Works. Replied in {test.data.ms} ms.</span>
            ) : (
              <span className="text-sm text-danger">{test.data.error}</span>
            ))}
        </div>
        <ErrorText error={save.error ?? test.error} />
      </form>
    </Section>
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
      title="Default permission mode"
      description="New conversations start in this mode. You can switch any conversation later. Each machine can also cap the mode it accepts."
    >
      <div className="space-y-2">
        {settings.modes.map((m) => (
          <label
            key={m}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent"
          >
            <input
              type="radio"
              name="mode"
              className="mt-1"
              checked={settings.defaultMode === m}
              onChange={() => save.mutate(m)}
            />
            <span>
              <span className="font-medium">{MODE_POLICY[m].label}</span>
              <span className="block text-sm text-muted">{MODE_POLICY[m].description}</span>
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
      title="Sandboxes"
      description={
        <>
          When no machine can take a task, Sling can run it in a fresh sandbox from a provider under{" "}
          <Link to="/connectors" className="text-accent hover:underline">
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
        <div className="space-y-8">
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
        <p className="text-sm font-medium">Estimated cost per hour</p>
        <p className="text-xs text-muted">
          Optional, in your own currency. With a cost set, the Sandboxes page shows estimated spend.
        </p>
        {providers.length === 0 ? (
          <p className="text-sm text-muted">
            Add a sandbox provider under Connectors to set what it costs.
          </p>
        ) : (
          <ul className="space-y-2">
            {providers.map((p) => (
              <li key={p.id} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
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
          <span className="text-sm text-muted">
            Limits are whole numbers, and the concurrent limit and lifetime are at least 1.
          </span>
        )}
        {save.isSuccess && <span className="text-sm text-ok">Saved.</span>}
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
        Setup steps are in <code className="font-mono">docs/sandboxes.md</code>.
      </>
    ),
  },
];

function SandboxSecrets({ secrets }: { secrets: SandboxSettingsView["secrets"] }) {
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
        <h3 className="text-sm font-medium">Secrets</h3>
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
          onClear={() => {
            if (window.confirm(`Clear the stored ${s.label}?`)) clear.mutate(s.key);
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
        {save.isSuccess && <span className="text-sm text-ok">Saved.</span>}
      </div>
      <ErrorText error={save.error ?? clear.error} />
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
        <label htmlFor={id} className="text-sm font-medium">
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
      <p className="text-xs text-muted">{hint}</p>
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
      title="Sign-in security"
      description="This account can start work on your machines, so protect it with a passkey or a second factor."
    >
      <div className="space-y-6">
        <TwoFactor enabled={enabled} onChange={() => session.refetch()} />
        <Passkeys />
      </div>
    </Section>
  );
}

function TwoFactor({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const secret = setup ? new URL(setup.totpURI).searchParams.get("secret") : null;

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = enabled
      ? await authClient.twoFactor.disable({ password })
      : await authClient.twoFactor.enable({ password });
    setBusy(false);
    setPassword("");
    if (res.error) return setError(res.error.message ?? "That didn't work.");
    if (enabled) return onChange();
    setSetup(res.data as { totpURI: string; backupCodes: string[] });
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
    setBusy(false);
    if (res.error) return setError(res.error.message ?? "That code didn't work.");
    setSetup(null);
    setCode("");
    onChange();
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Authenticator app</h3>
        {enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
      </div>
      {setup ? (
        <form onSubmit={verify} className="mt-3 space-y-3">
          <p className="text-sm text-muted">
            Add this key to your authenticator app, then enter the code it shows.
          </p>
          <code className="block rounded-lg bg-surface-2 px-3 py-2 font-mono text-sm break-all">
            {secret}
          </code>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">
              Backup codes (save these somewhere safe)
            </summary>
            <code className="mt-2 block rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs leading-6">
              {setup.backupCodes.join(" ")}
            </code>
          </details>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              className="max-w-40"
              required
            />
            <Button type="submit" variant="primary" busy={busy}>
              Turn on
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={start} className="mt-3 flex flex-wrap gap-2">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            className="max-w-60"
            autoComplete="current-password"
            required
          />
          <Button type="submit" busy={busy} variant={enabled ? "danger" : "secondary"}>
            {enabled ? "Turn off" : "Set up"}
          </Button>
        </form>
      )}
      <ErrorText error={error} />
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

  return (
    <div>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Passkeys</h3>
        <Button size="sm" className="ml-auto" busy={busy} onClick={add}>
          Add passkey
        </Button>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {(list.data ?? []).map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <span className="flex-1">{p.name ?? "Passkey"}</span>
            <Button size="sm" variant="ghost" onClick={() => remove(p.id)}>
              Remove
            </Button>
          </li>
        ))}
        {list.data?.length === 0 && <li className="text-muted">None yet.</li>}
      </ul>
      <ErrorText error={error} />
    </div>
  );
}
