import type { DeployTargetView } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, Ellipsis, Pencil, Plus, Rocket, Trash2 } from "lucide-react";
import { useState } from "react";
import { CheckList, MethodLine } from "../components/DeployBits.tsx";
import { DeployTargetDialog } from "../components/DeployTargetDialog.tsx";
import { Page, Toolbar, ToolbarText } from "../components/Page.tsx";
import { ActionStateText } from "../components/TaskCard.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  Dot,
  Empty,
  ErrorText,
  Menu,
  MenuItem,
  MenuSeparator,
  Mono,
  Skeleton,
  Spinner,
  useConfirm,
} from "../components/ui.tsx";
import {
  deployApi,
  forgetTarget,
  slowest,
  upsertTarget,
  useDeployTargets,
} from "../lib/deploys.ts";
import { ago, duration, shortSha } from "../lib/format.ts";
import { useNow } from "../lib/useNow.ts";

type Editing = { target: DeployTargetView | null } | null;

export function DeploysPage() {
  const list = useDeployTargets();
  const targets = list.data ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  // "Checked 3 min ago" moves on by itself.
  const now = useNow(30_000, targets.length > 0);
  const down = targets.filter((t) => t.lastCheck && !t.lastCheck.up).length;
  const allUp = targets.length > 0 && targets.every((t) => t.lastCheck?.up);
  const add = () => setEditing({ target: null });

  return (
    <Page
      title="Deploys"
      badge={
        down > 0 ? (
          <Badge tone="danger" dot>
            {down} down
          </Badge>
        ) : allUp ? (
          <Badge tone="ok" dot>
            All up
          </Badge>
        ) : undefined
      }
      toolbar={
        <Toolbar
          actions={
            <Button variant="primary" icon={Plus} onClick={add}>
              Add target
            </Button>
          }
        >
          <ToolbarText>
            Repos Sling can merge, deploy, and check once you approve a fix. Each one has the checks
            that say its site works.
          </ToolbarText>
        </Toolbar>
      }
    >
      {editing && (
        <DeployTargetDialog
          target={editing.target}
          targets={targets}
          onClose={() => setEditing(null)}
        />
      )}
      {list.data && targets.length === 0 ? (
        <Empty
          fill
          icon={Rocket}
          title="No deploy targets yet"
          action={
            <Button variant="primary" icon={Plus} onClick={add}>
              Add target
            </Button>
          }
        >
          Add a repo's site so Sling can deploy a fix after you approve it, then check that the site
          works.
        </Empty>
      ) : (
        <div className="space-y-4 px-5 pt-1 pb-6">
          {list.isPending && <Skeleton className="h-[188px] w-full rounded-xl" />}
          <ErrorText error={list.error} />
          {targets.map((t) => (
            <TargetCard key={t.id} target={t} now={now} onEdit={() => setEditing({ target: t })} />
          ))}
        </div>
      )}
    </Page>
  );
}

function TargetCard({
  target: t,
  now,
  onEdit,
}: {
  target: DeployTargetView;
  now: number;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const check = useMutation({
    mutationFn: () => deployApi.check(t.id),
    onSuccess: (next) => {
      if (next && typeof next === "object" && "id" in next) upsertTarget(qc, next);
    },
  });
  const remove = useMutation({
    mutationFn: () => deployApi.remove(t.id),
    onSuccess: () => forgetTarget(qc, t.id),
  });
  const last = t.lastCheck;
  const tone = check.isPending ? "neutral" : !last ? "neutral" : last.up ? "ok" : "danger";

  return (
    <article aria-label={t.name}>
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <span className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-icon shadow-raised">
            <Rocket aria-hidden="true" size={16} />
            <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-surface p-[2px]">
              <Dot tone={tone} pulse={check.isPending} />
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
              <span className="truncate font-medium">{t.name}</span>
              <Status target={t} now={now} checking={check.isPending} />
            </p>
            <p className="mt-0.5 truncate text-xs text-subtle">{t.remoteKey}</p>
          </div>
          <Menu
            label={`${t.name} actions`}
            trigger={({ open, toggle }) => (
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={Ellipsis}
                aria-label={`${t.name} actions`}
                aria-expanded={open}
                onClick={toggle}
              />
            )}
          >
            <MenuItem icon={Activity} onSelect={() => check.mutate()}>
              Check now
            </MenuItem>
            <MenuItem icon={Pencil} onSelect={onEdit}>
              Edit
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Trash2}
              danger
              onSelect={async () => {
                const ok = await confirm({
                  title: `Delete ${t.name}?`,
                  body: `Sling stops checking it, and tasks in ${t.remoteKey} can't deploy until you add a target again. Deploys already done stay as they are.`,
                  action: "Delete",
                  danger: true,
                });
                if (ok) remove.mutate();
              }}
            >
              Delete
            </MenuItem>
          </Menu>
        </div>

        <dl className="grid gap-x-6 gap-y-2 border-t border-border px-4 py-2.5 text-xs sm:grid-cols-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <dt className="shrink-0 text-subtle">Deploys</dt>
            <dd className="min-w-0 truncate text-soft">
              <MethodLine target={t} />
            </dd>
          </div>
          <div className="flex min-w-0 items-baseline gap-2">
            <dt className="shrink-0 text-subtle">Last deploy</dt>
            <dd className="flex min-w-0 items-baseline gap-1.5 text-soft">
              {t.lastDeploy ? (
                <>
                  <Link
                    to="/tasks/$id"
                    params={{ id: t.lastDeploy.taskId }}
                    className="min-w-0 truncate decoration-faint underline-offset-2 hover:underline"
                  >
                    {t.lastDeploy.taskTitle}
                  </Link>
                  {t.lastDeploy.commitSha && (
                    <Mono className="shrink-0">{shortSha(t.lastDeploy.commitSha)}</Mono>
                  )}
                  <span className="shrink-0">
                    <ActionStateText state={t.lastDeploy.state} />
                  </span>
                  <span className="shrink-0 text-muted">{ago(t.lastDeploy.at, now)}</span>
                </>
              ) : (
                <span className="text-muted">Never</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="border-t border-border px-4 py-2.5">
          <CheckList checks={t.checks} results={last?.results ?? null} label={`${t.name} checks`} />
        </div>
        {(check.error || remove.error) && (
          <div className="px-4 pb-3">
            <ErrorText error={check.error ?? remove.error} />
          </div>
        )}
        {dialog}
      </Card>
    </article>
  );
}

/** Up or down from the last round of checks, how fast, and when. */
function Status({
  target: t,
  now,
  checking,
}: {
  target: DeployTargetView;
  now: number;
  checking: boolean;
}) {
  const last = t.lastCheck;
  if (checking) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
        <Spinner className="size-3" />
        Checking
      </span>
    );
  }
  if (!last) return <span className="shrink-0 text-xs text-muted">Not checked yet</span>;
  const ms = slowest(last.results);
  return (
    <span className="tabular shrink-0 text-xs text-muted">
      <span className={cx("font-medium", last.up ? "text-ok" : "text-danger")}>
        {last.up ? "Up" : "Down"}
      </span>
      {last.up && ms !== null ? ` · ${duration(ms)}` : ""}
      {!last.up && last.failures > 1 ? ` · ${last.failures} failures in a row` : ""}
      {` · checked ${ago(last.at, now)}`}
    </span>
  );
}
