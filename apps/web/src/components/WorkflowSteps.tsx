import type { WorkflowStepView } from "@sling/core";
import { Link } from "@tanstack/react-router";
import { Send } from "lucide-react";

/** A workflow's steps on its card, in the order they run, with the ones that send marked. */
export function WorkflowSteps({ steps }: { steps: WorkflowStepView[] }) {
  if (steps.length === 0) return null;
  return (
    <ol
      aria-label="Workflow steps"
      className="max-h-72 space-y-1 overflow-auto border-t border-border px-2.5 py-2 text-xs leading-[18px]"
    >
      {steps.map((s, i) => (
        <li key={s.nodeId} className="flex gap-2.5">
          <span className="tabular w-3.5 shrink-0 text-right text-subtle">{i + 1}</span>
          <span className="min-w-0 flex-1 break-words text-soft">{s.text}</span>
          {s.sends && (
            <span className="inline-flex h-[18px] shrink-0 items-center gap-1 text-[11px] font-medium text-warn">
              <Send aria-hidden="true" size={11} />
              Sends
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** The link from a workflow's card to the workflow, once it exists. */
export function OpenInEditor({ workflowId }: { workflowId: string }) {
  return (
    <Link
      to="/workflows/$id"
      params={{ id: workflowId }}
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-accent-text transition-colors duration-150 hover:bg-hover"
    >
      Open in editor
    </Link>
  );
}
