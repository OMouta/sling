import { type ApprovalView, HARNESS_LABELS } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { fallbackPayload } from "../lib/sandbox.ts";
import { Badge, Button, Card, ErrorText } from "./ui.tsx";

/**
 * Asks to run a task in a sandbox because no machine can take it. Shown on
 * the Approvals page, and in the conversation in place of the task's card.
 */
export function SandboxFallbackCard({ approval }: { approval: ApprovalView }) {
  const qc = useQueryClient();
  const p = fallbackPayload(approval);
  const taskId = p?.taskId ?? approval.taskId;
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.post(`/api/approvals/${approval.id}`, { decision }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      if (taskId) void qc.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });

  return (
    <Card className="overflow-hidden">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-muted uppercase">
            Run in a sandbox?
          </span>
          <Badge tone="warn">waiting for approval</Badge>
        </div>
        {p ? (
          <>
            <Link
              to="/tasks/$id"
              params={{ id: p.taskId }}
              className="block font-medium hover:underline hover:underline-offset-2"
            >
              {p.taskTitle}
            </Link>
            <div className="text-sm">
              <p>No machine can take this right now.</p>
              {p.reasons.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                  {p.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-lg bg-surface-2 p-3 text-sm">
              <p className="text-xs font-medium tracking-wide text-muted uppercase">
                If you approve
              </p>
              <p className="mt-1">
                Clone <code className="font-mono text-xs">{p.remoteKey}</code> into a sandbox on{" "}
                <span className="font-medium">{p.providerName}</span> and run{" "}
                {HARNESS_LABELS[p.harness]}.
              </p>
              <p className="mt-1 text-xs text-muted">
                Only the remote is cloned, so nothing on your machines moves. Rejecting cancels the
                task.
              </p>
            </div>
          </>
        ) : (
          <>
            <p className="font-medium">{approval.title}</p>
            {approval.payload && (
              <pre className="max-h-60 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs whitespace-pre-wrap">
                {JSON.stringify(approval.payload, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-4 py-3">
        <span className="mr-auto text-xs text-muted">Expires {ago(approval.expiresAt)}</span>
        <ErrorText error={decide.error} />
        <Button size="sm" busy={decide.isPending} onClick={() => decide.mutate("reject")}>
          Reject
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={decide.isPending}
          onClick={() => decide.mutate("approve")}
        >
          Approve
        </Button>
      </div>
    </Card>
  );
}
