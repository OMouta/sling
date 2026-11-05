import type { ConnectorView, InstallationView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useMemo, useState } from "react";
import Markdown from "react-markdown";
import { SchemaForm } from "../components/SchemaForm.tsx";
import { InstallationStatusLabel } from "../components/StatusBadge.tsx";
import {
  Button,
  Card,
  Dialog,
  Dot,
  Empty,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Spinner,
  Switch,
} from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { ago, plural } from "../lib/format.ts";
import { isProviderConnector } from "../lib/sandbox.ts";
import { useSandboxRepos, useSandboxSettings } from "../lib/sandboxApi.ts";
import { defaultsFor, formFields, missingRequired } from "../lib/schemaForm.ts";
import { qk, useConnectors, useInstallations } from "../lib/workflowApi.ts";

type TestResult = { ok: true; detail?: string } | { ok: false; error: string };

type FormTarget = { connector: ConnectorView; installation?: InstallationView };

export function ConnectorsPage() {
  const connectors = useConnectors();
  const installations = useInstallations();
  const [form, setForm] = useState<FormTarget | null>(null);
  const byId = new Map((connectors.data ?? []).map((c) => [c.id, c]));
  // Providers create sandboxes rather than feed workflows, so they're listed apart.
  const isProvider = (connectorId: string) =>
    isProviderConnector(byId.get(connectorId) ?? { id: connectorId });
  const installed = installations.data?.filter((i) => !isProvider(i.connectorId));
  const installedProviders = installations.data?.filter((i) => isProvider(i.connectorId)) ?? [];
  const available = connectors.data?.filter((c) => !isProviderConnector(c));
  const providers = connectors.data?.filter(isProviderConnector) ?? [];
  const edit = (i: InstallationView) => {
    const connector = byId.get(i.connectorId);
    if (connector) setForm({ connector, installation: i });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <PageHeader
        title="Connectors"
        description="Accounts Sling's workflows can use. Credentials are stored encrypted and never shown again."
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium tracking-wide text-muted uppercase">Installed</h2>
        {installations.isPending && <Spinner />}
        <ErrorText error={installations.error} />
        {installed?.length === 0 && <Empty title="Nothing installed">Add a connector below.</Empty>}
        <div className="space-y-3">
          {installed?.map((i) => (
            <InstallationCard
              key={i.id}
              installation={i}
              connector={byId.get(i.connectorId)}
              onEdit={() => edit(i)}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium tracking-wide text-muted uppercase">Available</h2>
        {connectors.isPending && <Spinner />}
        <ErrorText error={connectors.error} />
        <div className="grid gap-3 sm:grid-cols-2">
          {available?.map((c) => (
            <ConnectorCard key={c.id} connector={c} onAdd={() => setForm({ connector: c })} />
          ))}
        </div>
      </section>

      {(providers.length > 0 || installedProviders.length > 0) && (
        <section aria-labelledby="sandbox-providers" className="space-y-3">
          <div>
            <h2
              id="sandbox-providers"
              className="text-sm font-medium tracking-wide text-muted uppercase"
            >
              Sandbox providers
            </h2>
            <p className="mt-1 text-sm text-muted">
              Where Sling creates a fresh sandbox for a task no machine can take, after you approve
              it. Each sandbox clones an allowed repo from its remote, runs the coding agent, and is
              destroyed once the task is delivered.
            </p>
          </div>
          <ProviderReadiness />
          {installedProviders.map((i) => (
            <InstallationCard
              key={i.id}
              provider
              installation={i}
              connector={byId.get(i.connectorId)}
              onEdit={() => edit(i)}
            />
          ))}
          <div className="grid gap-3 sm:grid-cols-2">
            {providers.map((c) => (
              <ConnectorCard key={c.id} connector={c} onAdd={() => setForm({ connector: c })} />
            ))}
          </div>
        </section>
      )}

      {form && (
        <InstallationForm
          connector={form.connector}
          installation={form.installation}
          onClose={() => setForm(null)}
        />
      )}
    </div>
  );
}

function ConnectorCard({ connector: c, onAdd }: { connector: ConnectorView; onAdd: () => void }) {
  return (
    <Card className="flex flex-col p-4">
      <h3 className="font-medium">{c.name}</h3>
      <p className="mt-1 flex-1 text-sm text-muted">{c.description}</p>
      <div className="mt-3">
        <Button size="sm" aria-label={`Add ${c.name}`} onClick={onAdd}>
          Add
        </Button>
      </div>
    </Card>
  );
}

/** What a provider needs before a sandbox can do anything, and whether it's in place. */
function ProviderReadiness() {
  const repos = useSandboxRepos();
  const settings = useSandboxSettings();
  const secrets = settings.data?.secrets;
  const allowed = repos.data?.length ?? 0;
  const items: {
    done: boolean | null;
    text: string;
    to: "/machines" | "/settings";
    where: string;
  }[] = [
    {
      done: repos.data ? allowed > 0 : null,
      text:
        allowed > 0
          ? `${plural(allowed, "repo")} allowed in sandboxes`
          : "At least one repo allowed in sandboxes",
      to: "/machines",
      where: "Machines",
    },
    {
      done: secrets ? secrets.openaiApiKey || secrets.anthropicApiKey : null,
      text: "An OpenAI or Anthropic API key for the coding agent",
      to: "/settings",
      where: "Settings",
    },
    {
      done: secrets ? secrets.gitToken : null,
      text: "A GitHub token to clone, push, and open pull requests",
      to: "/settings",
      where: "Settings",
    },
  ];
  return (
    <Card className="p-4">
      <p className="text-sm font-medium">A provider is only useful with these in place</p>
      <ul aria-label="Sandbox setup" className="mt-2 space-y-1.5 text-sm">
        {items.map((item) => (
          <li key={item.text} className="flex items-center gap-2">
            <Dot tone={item.done === null ? "neutral" : item.done ? "ok" : "warn"} />
            <span className="sr-only">
              {item.done === null ? "" : item.done ? "Done: " : "Still needed: "}
            </span>
            <span className="min-w-0 flex-1">{item.text}</span>
            <Link to={item.to} className="text-accent hover:underline">
              {item.where}
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        A provider set to a custom image can bring its own logins instead of the stored keys.
      </p>
    </Card>
  );
}

function InstallationCard({
  installation: i,
  connector,
  onEdit,
  provider,
}: {
  installation: InstallationView;
  connector: ConnectorView | undefined;
  onEdit: () => void;
  /** Providers aren't used by workflows, so "idle" means nothing for them. */
  provider?: boolean;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const update = (next: InstallationView) =>
    qc.setQueryData<InstallationView[]>(qk.installations(), (list) =>
      list?.map((x) => (x.id === next.id ? next : x)),
    );
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<InstallationView>(`/api/installations/${i.id}`, { enabled }),
    onMutate: (enabled) => update({ ...i, enabled }),
    onSuccess: (res) => res && "id" in res && update(res),
    onError: () => void qc.invalidateQueries({ queryKey: qk.installations() }),
  });
  const test = useMutation({
    mutationFn: () => api.post<TestResult>(`/api/installations/${i.id}/test`),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/installations/${i.id}`),
    onSuccess: () => {
      qc.setQueryData<InstallationView[]>(qk.installations(), (list) =>
        list?.filter((x) => x.id !== i.id),
      );
      setConfirm(false);
    },
  });

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{i.name}</p>
          <p className="text-sm text-muted">
            {connector?.name ?? i.connectorId} · added {ago(i.createdAt)}
          </p>
        </div>
        <InstallationStatusLabel status={i.status} />
        <Switch
          checked={i.enabled}
          label={`${i.enabled ? "Disable" : "Enable"} ${i.name}`}
          disabled={toggle.isPending}
          onChange={(enabled) => toggle.mutate(enabled)}
        />
      </div>
      {i.statusDetail && (
        <p className={i.status === "error" ? "text-sm text-danger" : "text-sm text-muted"}>
          {i.statusDetail}
        </p>
      )}
      {i.status === "idle" && !i.statusDetail && !provider && (
        <p className="text-sm text-muted">Not listening: no enabled workflow uses it.</p>
      )}
      {test.data && (
        <p role="status" className={test.data.ok ? "text-sm text-ok" : "text-sm text-danger"}>
          {test.data.ok
            ? `Connection works.${test.data.detail ? ` ${test.data.detail}` : ""}`
            : test.data.error}
        </p>
      )}
      <ErrorText error={toggle.error ?? test.error} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" busy={test.isPending} onClick={() => test.mutate()}>
          Test
        </Button>
        <Button size="sm" onClick={onEdit} disabled={!connector}>
          Edit
        </Button>
        <Button size="sm" variant="danger" onClick={() => setConfirm(true)}>
          Delete
        </Button>
      </div>
      {confirm && (
        <Dialog
          title={`Delete ${i.name}?`}
          onClose={() => setConfirm(false)}
          footer={
            <>
              <ErrorText error={del.error} />
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="danger" busy={del.isPending} onClick={() => del.mutate()}>
                Delete
              </Button>
            </>
          }
        >
          <p className="text-sm">
            Its stored credentials are erased. Workflows that use it fail until you pick another
            installation.
          </p>
        </Dialog>
      )}
    </Card>
  );
}

function InstallationForm({
  connector,
  installation,
  onClose,
}: {
  connector: ConnectorView;
  installation?: InstallationView;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const editing = installation !== undefined;
  const credFields = useMemo(() => formFields(connector.credentialsSchema), [connector]);
  const configFields = useMemo(() => formFields(connector.configSchema), [connector]);
  const [name, setName] = useState(installation?.name ?? connector.name);
  // Credentials are write-only: editing starts blank and sends only what you type.
  const [credentials, setCredentials] = useState<Record<string, unknown>>(() =>
    editing ? {} : defaultsFor(connector.credentialsSchema),
  );
  const initialConfig = useMemo(
    () => ({ ...defaultsFor(connector.configSchema), ...(installation?.config ?? {}) }),
    [connector, installation],
  );
  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig);

  const changedCredentials = Object.fromEntries(
    Object.entries(credentials).filter(([, v]) => v !== "" && v !== undefined && v !== null),
  );
  const credentialsStored = editing && installation.hasCredentials;
  const missing = [
    ...(credentialsStored ? [] : missingRequired(credFields, credentials)),
    ...missingRequired(configFields, config),
  ];

  const save = useMutation({
    mutationFn: () => {
      if (!editing) {
        return api.post<InstallationView>("/api/installations", {
          connectorId: connector.id,
          name: name.trim(),
          credentials,
          config,
        });
      }
      const body: Record<string, unknown> = {};
      if (name.trim() !== installation.name) body.name = name.trim();
      if (JSON.stringify(config) !== JSON.stringify(initialConfig)) body.config = config;
      if (Object.keys(changedCredentials).length > 0) body.credentials = changedCredentials;
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
      }
      void qc.invalidateQueries({ queryKey: qk.installations() });
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing.length === 0 && name.trim()) save.mutate();
  };

  return (
    <Dialog
      wide
      title={editing ? `Edit ${installation.name}` : `Add ${connector.name}`}
      onClose={onClose}
      footer={
        <>
          {missing.length > 0 && (
            <p className="mr-auto text-xs text-muted">Fill in the fields marked *.</p>
          )}
          <ErrorText error={save.error} />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="installation-form"
            busy={save.isPending}
            disabled={missing.length > 0 || !name.trim()}
          >
            {editing ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form
        id="installation-form"
        onSubmit={submit}
        className="grid gap-6 md:grid-cols-[1fr_16rem]"
      >
        <div className="space-y-6">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          {credFields.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-xs font-medium tracking-wide text-muted uppercase">
                Credentials
              </h3>
              {credentialsStored && (
                <p className="text-xs text-muted">
                  Stored. Leave a field blank to keep it; type a new value to replace it.
                </p>
              )}
              <SchemaForm
                fields={credFields}
                value={credentials}
                onChange={setCredentials}
                secretFields={connector.secretFields}
                placeholder={credentialsStored ? "Stored" : undefined}
                secretPlaceholder={credentialsStored ? "Stored (hidden)" : undefined}
              />
            </section>
          )}
          {configFields.length > 0 && (
            <section className="space-y-3">
              <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Settings</h3>
              <SchemaForm fields={configFields} value={config} onChange={setConfig} />
            </section>
          )}
        </div>
        {connector.setupHelp && (
          <aside className="prose-chat rounded-lg bg-surface-2 p-3 text-sm text-muted md:self-start">
            <p className="mb-1 font-medium text-text">Setup</p>
            <Markdown>{connector.setupHelp}</Markdown>
          </aside>
        )}
      </form>
    </Dialog>
  );
}
