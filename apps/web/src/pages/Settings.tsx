import { MODE_POLICY, type PermissionMode } from "@sling/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
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
import type { ProviderInfo, Settings } from "../lib/types.ts";

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
  description?: string;
  children: React.ReactNode;
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
      description="The model behind Sling's assistant. Codex uses its own login on each machine."
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
