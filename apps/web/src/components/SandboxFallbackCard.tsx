import { type ApprovalView, HARNESS_LABELS } from "@sling/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Box } from "lucide-react";
import { api } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { fallbackPayload } from "../lib/sandbox.ts";
import { Badge, Button, Card, CardFooter, ErrorText, Kicker, Mono } from "./ui.tsx";

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
          <Kicker icon={Box}>Run in a sandbox?</Kicker>
          <span className="ml-auto">
            <Badge tone="warn" dot>
              waiting for approval
            </Badge>
          </span>
        </div>
        {p ? (
          <>
            <Link
              to="/tasks/$id"
              params={{ id: p.taskId }}
              className="block text-sm font-medium decoration-faint underline-offset-2 hover:underline"
            >
              {p.taskTitle}
            </Link>
            <div className="text-[13px]">
              <p>No machine can take this right now.</p>
              {p.reasons.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted marker:text-faint">
                  {p.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-lg bg-surface-2 p-3 text-[13px] shadow-raised">
              <p className="section-label">If you approve</p>
              <p className="mt-1.5">
                Clone <Mono>{p.remoteKey}</Mono> into a sandbox on{" "}
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
            <p className="text-sm font-medium">{approval.title}</p>
            {approval.payload && (
              <pre className="max-h-60 overflow-auto rounded-lg bg-field p-3 font-mono text-xs whitespace-pre-wrap shadow-field">
                {JSON.stringify(approval.payload, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
      <CardFooter>
        <span className="mr-auto text-xs text-subtle">Expires {ago(approval.expiresAt)}</span>
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
      </CardFooter>
    </Card>
  );
}
