import type { ConnectorView, InstallationView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Container,
  FlaskConical,
  type LucideIcon,
  Mail,
  MessagesSquare,
  Pencil,
  Plug,
  Plus,
  TrainFront,
  Trash2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import Markdown from "react-markdown";
import { Content, Page, Toolbar, ToolbarText } from "../components/Page.tsx";
import { SchemaForm } from "../components/SchemaForm.tsx";
import { InstallationStatusLabel } from "../components/StatusBadge.tsx";
import {
  Button,
  Card,
  cx,
  Dialog,
  Dot,
  Empty,
  ErrorText,
  Field,
  Input,
  Skeleton,
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

const ICONS: [RegExp, LucideIcon][] = [
  [/discord/i, MessagesSquare],
  [/mail/i, Mail],
  [/docker/i, Container],
  [/railway/i, TrainFront],
];

function iconFor(c: { id: string; name: string }): LucideIcon {
  return ICONS.find(([re]) => re.test(c.id) || re.test(c.name))?.[1] ?? Plug;
}

function ConnectorIcon({
  connector,
  size = "md",
}: {
  connector?: { id: string; name: string };
  size?: "md" | "lg";
}) {
  const Icon = connector ? iconFor(connector) : Plug;
  return (
    <span
      className={cx(
        "grid shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised",
        size === "lg" ? "size-10" : "size-9",
      )}
    >
      <Icon aria-hidden="true" size={16} />
    </span>
  );
}

function Group({
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
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="section-label">
          {title}
        </h2>
        {description && (
          <p className="mt-1.5 max-w-2xl text-xs leading-4 text-muted">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

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
    <Page
      title="Connectors"
      badge={
        installations.data && installations.data.length > 0 ? (
          <span className="tabular text-xs text-subtle">{installations.data.length} installed</span>
        ) : undefined
      }
      toolbar={
        <Toolbar>
          <ToolbarText>
            Accounts Sling's workflows can use. Credentials are stored encrypted and never shown
            again.
          </ToolbarText>
        </Toolbar>
      }
    >
      <Content className="max-w-5xl space-y-9 pt-2">
        <Group id="installed" title="Installed">
          {installations.isPending && <Skeleton className="h-24 w-full rounded-xl" />}
          <ErrorText error={installations.error} />
          {installed?.length === 0 && (
            <Card>
              <Empty icon={Plug} title="Nothing installed" className="py-10">
                Add a connector below.
              </Empty>
            </Card>
          )}
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
        </Group>

        <Group id="available" title="Available">
          {connectors.isPending && <Skeleton className="h-28 w-full rounded-xl" />}
          <ErrorText error={connectors.error} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {available?.map((c) => (
              <ConnectorCard key={c.id} connector={c} onAdd={() => setForm({ connector: c })} />
            ))}
          </div>
        </Group>

        {(providers.length > 0 || installedProviders.length > 0) && (
          <Group
            id="sandbox-providers"
            title="Sandbox providers"
            description="Where Sling creates a fresh sandbox for a task no machine can take, after you approve it. Each sandbox clones an allowed repo from its remote, runs the coding agent, and is destroyed once the task is delivered."
          >
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {providers.map((c) => (
                <ConnectorCard key={c.id} connector={c} onAdd={() => setForm({ connector: c })} />
              ))}
            </div>
          </Group>
        )}
      </Content>

      {form && (
        <InstallationForm
          connector={form.connector}
          installation={form.installation}
          onClose={() => setForm(null)}
        />
      )}
    </Page>
  );
}

function ConnectorCard({ connector: c, onAdd }: { connector: ConnectorView; onAdd: () => void }) {
  return (
    <Card className="flex flex-col p-4 transition-shadow duration-150 hover:shadow-card-hover">
      <div className="flex items-start justify-between gap-3">
        <ConnectorIcon connector={c} />
        <Button size="sm" icon={Plus} aria-label={`Add ${c.name}`} onClick={onAdd}>
          Add
        </Button>
      </div>
      <h3 className="mt-3 text-sm font-medium">{c.name}</h3>
      <p className="mt-1 flex-1 text-xs leading-4 text-muted">{c.description}</p>
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
      <p className="text-[13px] font-medium">A provider is only useful with these in place</p>
      <ul aria-label="Sandbox setup" className="mt-3 space-y-2 text-[13px]">
        {items.map((item) => (
          <li key={item.text} className="flex items-center gap-2.5">
            <Dot tone={item.done === null ? "neutral" : item.done ? "ok" : "warn"} />
            <span className="sr-only">
              {item.done === null ? "" : item.done ? "Done: " : "Still needed: "}
            </span>
            <span className="min-w-0 flex-1">{item.text}</span>
            <Link
              to={item.to}
              className="inline-flex items-center gap-1 text-xs text-subtle transition-colors duration-150 hover:text-text"
            >
              {item.where}
              <ArrowRight aria-hidden="true" size={12} />
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-subtle">
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
    <article aria-label={i.name}>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-4">
          <ConnectorIcon connector={connector ?? { id: i.connectorId, name: "" }} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{i.name}</p>
            <p className="text-xs text-muted">
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
        {(i.statusDetail ||
          (i.status === "idle" && !provider) ||
          test.data ||
          toggle.error ||
          test.error) && (
          <div className="space-y-1.5 px-4 pb-3 pl-16 text-xs">
            {i.statusDetail && (
              <p className={i.status === "error" ? "text-danger" : "text-muted"}>
                {i.statusDetail}
              </p>
            )}
            {i.status === "idle" && !i.statusDetail && !provider && (
              <p className="text-muted">Not listening: no enabled workflow uses it.</p>
            )}
            {test.data && (
              <p role="status" className={test.data.ok ? "text-ok" : "text-danger"}>
                {test.data.ok
                  ? `Connection works.${test.data.detail ? ` ${test.data.detail}` : ""}`
                  : test.data.error}
              </p>
            )}
            <ErrorText error={toggle.error ?? test.error} />
          </div>
        )}
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
          <Button size="sm" icon={FlaskConical} busy={test.isPending} onClick={() => test.mutate()}>
            Test
          </Button>
          <Button size="sm" icon={Pencil} onClick={onEdit} disabled={!connector}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            className="ml-auto text-danger enabled:hover:text-danger"
            onClick={() => setConfirm(true)}
          >
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
            <p className="text-[13px] leading-5 text-soft">
              Its stored credentials are erased. Workflows that use it fail until you pick another
              installation.
            </p>
          </Dialog>
        )}
      </Card>
    </article>
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
      description={connector.description}
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
              <h3 className="section-label">Credentials</h3>
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
              <h3 className="section-label">Settings</h3>
              <SchemaForm fields={configFields} value={config} onChange={setConfig} />
            </section>
          )}
        </div>
        {connector.setupHelp && (
          <aside className="prose-chat rounded-xl bg-surface-2 p-3.5 text-xs leading-5 text-muted shadow-raised md:self-start">
            <p className="mb-1.5 text-[13px] font-medium text-text">Setup</p>
            <Markdown>{connector.setupHelp}</Markdown>
          </aside>
        )}
      </form>
    </Dialog>
  );
}
