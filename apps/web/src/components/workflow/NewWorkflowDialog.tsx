import type { ConnectorView, InstallationView, WorkflowSummaryView } from "@sling/core";
import type { TemplateBinding, TemplateView, WorkflowDetailView } from "@sling/workflow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LayoutTemplate, Plus, Puzzle } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api.ts";
import {
  qk,
  useConnectors,
  useInstallations,
  useTemplates,
  workflowIdOf,
} from "../../lib/workflowApi.ts";
import { ConnectorSetupDialog } from "../ConnectorSetup.tsx";
import { ExtensionIcon } from "../extensions/ExtensionBits.tsx";
import { OptionCards } from "../SchemaForm.tsx";
import { Badge, Button, Input, Skeleton } from "../ui.tsx";
import { Wizard, type WizardStep } from "../Wizard.tsx";
import { StepNote } from "../WizardBits.tsx";

type Created = WorkflowDetailView | WorkflowSummaryView | { workflow: { id: string } };

const BLANK = "blank";

function statusLine(i: InstallationView): string | undefined {
  if (!i.enabled) return "Turned off";
  if (i.status === "error") return i.statusDetail || "Not connected";
  return undefined;
}

/**
 * A new workflow, a step at a time: what it starts from, an account for each
 * thing the template connects to (adding one in place if it's missing), and
 * its name. Creating it opens the editor.
 */
export function NewWorkflowDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const templates = useTemplates();
  const installations = useInstallations();
  const connectors = useConnectors();
  const [start, setStart] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [typedName, setTypedName] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ placeholder: string; connector: ConnectorView } | null>(
    null,
  );

  const template = templates.data?.find((t) => t.key === start) ?? null;
  const name = typedName ?? template?.name ?? "";
  const accounts = (connectorId: string) =>
    (installations.data ?? []).filter((i) => i.connectorId === connectorId);
  // The only account for a binding is picked for you.
  const picked = (b: TemplateBinding) => {
    const set = picks[b.placeholder];
    if (set && accounts(b.connectorId).some((i) => i.id === set)) return set;
    const list = accounts(b.connectorId);
    return list.length === 1 ? (list[0]?.id ?? "") : "";
  };

  const create = useMutation({
    mutationFn: () =>
      api.post<Created>(
        "/api/workflows",
        template
          ? {
              templateKey: template.key,
              bindings: Object.fromEntries(
                template.bindings.map((b) => [b.placeholder, picked(b)]),
              ),
              name: name.trim(),
            }
          : { name: name.trim() },
      ),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.workflows() });
      void navigate({ to: "/workflows/$id", params: { id: workflowIdOf(res) } });
    },
  });

  // ---------------------------------------------------------------- steps
  const startStep: WizardStep = {
    id: "start",
    title: "What should it start from?",
    blocked: !start,
    content: templates.isPending ? (
      <div className="space-y-2">
        <Skeleton className="h-[62px] w-full rounded-xl" />
        <Skeleton className="h-[94px] w-full rounded-xl" />
        <Skeleton className="h-[94px] w-full rounded-xl" />
      </div>
    ) : (
      <>
        {templates.error ? (
          <StepNote tone="error">
            Couldn't load the templates: {(templates.error as Error).message}
          </StepNote>
        ) : null}
        <OptionCards
          label="Start from"
          value={start}
          onChange={(v) => {
            setStart(v);
            setTypedName(null);
          }}
          options={[
            {
              value: BLANK,
              label: "Blank",
              detail: "An empty canvas to add steps to.",
              icon: <Plus aria-hidden="true" size={16} />,
            },
            ...(templates.data ?? []).map((t) => templateOption(t)),
          ]}
        />
      </>
    ),
  };

  const connectorName = (b: TemplateBinding) =>
    connectors.data?.find((c) => c.id === b.connectorId)?.name ?? b.connectorId;
  const bindings = template?.bindings ?? [];
  const bindingSteps: WizardStep[] = bindings.map((b) => {
    const list = accounts(b.connectorId);
    const connector = connectors.data?.find((c) => c.id === b.connectorId);
    const cname = connectorName(b);
    // Two bindings to the same connector need their own labels to tell apart.
    const shared = bindings.filter((x) => x.connectorId === b.connectorId).length > 1;
    const add = () => connector && setAdding({ placeholder: b.placeholder, connector });
    return {
      id: `binding:${b.placeholder}`,
      title: `Which ${cname} account should it use?`,
      hint: shared ? b.label : undefined,
      blocked: !picked(b),
      content: installations.isPending ? (
        <Skeleton className="h-[62px] w-full rounded-xl" />
      ) : !connector ? (
        <StepNote tone="warn">
          This template needs the {b.connectorId} connector, which isn't installed.
        </StepNote>
      ) : list.length === 0 ? (
        <>
          <StepNote>No {cname} account yet.</StepNote>
          <Button variant="primary" icon={Plus} onClick={add}>
            Add {cname}
          </Button>
        </>
      ) : (
        <>
          <OptionCards
            label={b.label}
            value={picked(b)}
            onChange={(id) => setPicks((p) => ({ ...p, [b.placeholder]: id }))}
            options={list.map((i) => ({ value: i.id, label: i.name, detail: statusLine(i) }))}
          />
          <Button size="sm" variant="ghost" icon={Plus} className="-ml-1.5" onClick={add}>
            Add another {cname} account
          </Button>
        </>
      ),
    };
  });

  const nameStep: WizardStep = {
    id: "name",
    title: "What should it be called?",
    blocked: !name.trim(),
    content: (
      <Input
        aria-label="Name"
        value={name}
        maxLength={120}
        placeholder="Website health monitor"
        onChange={(e) => setTypedName(e.target.value)}
      />
    ),
  };

  return (
    <>
      <Wizard
        title="New workflow"
        steps={[startStep, ...bindingSteps, nameStep]}
        finishLabel="Create"
        finishing={create.isPending}
        error={create.error instanceof Error ? create.error.message : null}
        onFinish={async () => {
          try {
            await create.mutateAsync();
            return true;
          } catch {
            return false;
          }
        }}
        // Escape in the account setup on top closes only that.
        onClose={() => {
          if (!adding) onClose();
        }}
      />
      {adding && (
        <ConnectorSetupDialog
          connector={adding.connector}
          // Back to the step as soon as it's saved, with the new account picked.
          onSaved={(inst) => {
            setPicks((p) => ({ ...p, [adding.placeholder]: inst.id }));
            setAdding(null);
          }}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}

function templateOption(t: TemplateView) {
  return {
    value: t.key,
    label: (
      <span className="flex items-center gap-2">
        {t.name}
        {t.builtIn && <Badge>Built in</Badge>}
      </span>
    ),
    icon: t.extension ? (
      <ExtensionIcon ext={t.extension} fallback={LayoutTemplate} size="sm" flat />
    ) : (
      <LayoutTemplate aria-hidden="true" size={16} />
    ),
    detail: (
      <>
        {t.description}
        {t.bindings.length > 0 && (
          <span className="mt-1 block text-subtle">
            Needs {t.bindings.map((b) => b.label).join(", ")}
          </span>
        )}
        {t.extension && (
          <span className="mt-1 flex items-center gap-1.5 text-subtle">
            <Puzzle aria-hidden="true" size={12} className="shrink-0" />
            From {t.extension.name}
          </span>
        )}
      </>
    ),
  };
}
