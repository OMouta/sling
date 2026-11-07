import type { ConnectorView, InstallationView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarDays,
  Container,
  FlaskConical,
  type LucideIcon,
  Mail,
  MessagesSquare,
  Pencil,
  Plug,
  Plus,
  Send,
  TrainFront,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ConnectorSetupDialog } from "../components/ConnectorSetup.tsx";
import { ExtensionIcon } from "../components/extensions/ExtensionBits.tsx";
import { Content, Page } from "../components/Page.tsx";
import { Button, Card, cx, Dialog, Dot, ErrorText, Skeleton, Switch } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { isProviderConnector } from "../lib/sandbox.ts";
import { useSandboxRepos, useSandboxSettings } from "../lib/sandboxApi.ts";
import { qk, useConnectors, useInstallations } from "../lib/workflowApi.ts";

type TestResult = { ok: true; detail?: string } | { ok: false; error: string };

type FormTarget = { connector: ConnectorView; installation?: InstallationView };

const ICONS: [RegExp, LucideIcon][] = [
  [/calendar/i, CalendarDays],
  [/discord/i, MessagesSquare],
  [/telegram/i, Send],
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
  connector?: Pick<ConnectorView, "id" | "name" | "extension">;
  size?: "md" | "lg";
}) {
  const Icon = connector ? iconFor(connector) : Plug;
  // An extension's connector shows the extension's own icon.
  if (connector?.extension) {
    return <ExtensionIcon ext={connector.extension} fallback={Icon} size={size} />;
  }
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

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="section-label">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** What an installation's status says, when it says something. Idle and off show nothing. */
const STATUS: Partial<
  Record<InstallationView["status"], { label: string; tone: "ok" | "warn" | "danger" }>
> = {
  connected: { label: "Connected", tone: "ok" },
  connecting: { label: "Connecting", tone: "warn" },
  error: { label: "Error", tone: "danger" },
};

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
          <span className="tabular text-xs text-subtle">{installations.data.length} added</span>
        ) : undefined
      }
    >
      <Content className="max-w-5xl space-y-9 pt-2">
        {(installations.isPending || installations.error || (installed?.length ?? 0) > 0) && (
          <Group id="installed" title="Added">
            {installations.isPending && <Skeleton className="h-24 w-full rounded-xl" />}
            <ErrorText error={installations.error} />
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
        )}

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
          <Group id="sandbox-providers" title="Sandbox providers">
            <ProviderReadiness />
            {installedProviders.map((i) => (
              <InstallationCard
                key={i.id}
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
        <ConnectorSetupDialog
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

/** What a sandbox still needs before a provider can run one. Nothing shows once it's all in place. */
function ProviderReadiness() {
  const repos = useSandboxRepos();
  const settings = useSandboxSettings();
  const secrets = settings.data?.secrets;
  if (!repos.data || !secrets) return null;
  const items: { text: string; to: "/machines" | "/settings"; where: string }[] = [
    ...(repos.data.length === 0
      ? [{ text: "Allow a repo in sandboxes", to: "/machines" as const, where: "Machines" }]
      : []),
    ...(!secrets.openaiApiKey && !secrets.anthropicApiKey
      ? [
          {
            text: "Add an OpenAI or Anthropic API key",
            to: "/settings" as const,
            where: "Settings",
          },
        ]
      : []),
    ...(!secrets.gitToken
      ? [{ text: "Add a GitHub token", to: "/settings" as const, where: "Settings" }]
      : []),
  ];
  if (items.length === 0) return null;
  return (
    <Card className="p-4">
      <p className="text-[13px] font-medium">Before a sandbox can run</p>
      <ul aria-label="Sandbox setup" className="mt-3 space-y-2 text-[13px]">
        {items.map((item) => (
          <li key={item.text} className="flex items-center gap-2.5">
            <Dot tone="warn" />
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
    </Card>
  );
}

function InstallationCard({
  installation: i,
  connector,
  onEdit,
}: {
  installation: InstallationView;
  connector: ConnectorView | undefined;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  // A connector that never listens for events, such as the calendar, has no status to show.
  const status = connector?.hasSource !== false && i.enabled ? STATUS[i.status] : undefined;
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
            <p className="truncate text-sm font-medium">{i.name}</p>
            <p className="text-xs text-muted">{connector?.name ?? i.connectorId}</p>
          </div>
          {status && (
            <span className="inline-flex items-center gap-1.5 text-xs text-soft">
              <Dot tone={status.tone} />
              {status.label}
            </span>
          )}
          <Switch
            checked={i.enabled}
            label={`${i.enabled ? "Turn off" : "Turn on"} ${i.name}`}
            disabled={toggle.isPending}
            onChange={(enabled) => toggle.mutate(enabled)}
          />
        </div>
        {((i.status === "error" && i.statusDetail) || test.data || toggle.error || test.error) && (
          <div className="space-y-1.5 px-4 pb-3 pl-16 text-xs">
            {i.status === "error" && i.statusDetail && (
              <p className="text-danger">{i.statusDetail}</p>
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
            variant="ghost-danger"
            icon={Trash2}
            className="ml-auto"
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
              Workflows that use it stop working until you pick another.
            </p>
          </Dialog>
        )}
      </Card>
    </article>
  );
}
