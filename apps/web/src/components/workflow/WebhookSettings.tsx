import type { NodeSpecView, WebhookSecretView } from "@sling/workflow";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ago } from "../../lib/format.ts";
import type { FormField } from "../../lib/schemaForm.ts";
import { qk, workflowApi } from "../../lib/workflowApi.ts";
import { CopyButton } from "../JsonView.tsx";
import type { FieldOverride } from "../SchemaForm.tsx";
import { Button, ErrorText, Input, Select, Spinner, useConfirm } from "../ui.tsx";

/** Headers that well-known senders put their delivery or event ID in. */
const EVENT_HEADERS = [
  { value: "x-sling-event-id", label: "X-Sling-Event-Id" },
  { value: "idempotency-key", label: "Idempotency-Key" },
  { value: "webhook-id", label: "webhook-id · Standard Webhooks" },
  { value: "x-github-delivery", label: "X-GitHub-Delivery · GitHub" },
  { value: "x-gitlab-event-uuid", label: "X-Gitlab-Event-UUID · GitLab" },
  { value: "x-shopify-webhook-id", label: "X-Shopify-Webhook-Id · Shopify" },
  { value: "linear-delivery", label: "Linear-Delivery · Linear" },
];
const OTHER = "\u0000other";

/**
 * Controls for a webhook trigger's settings that the generic form can't
 * draw: the event ID header as a picker, and the signing secret under the
 * choice of signed requests.
 */
export function webhookField(workflowId: string) {
  return (
    nodeId: string,
    spec: NodeSpecView | undefined,
    field: FormField,
    value: unknown,
    set: (v: unknown) => void,
    editable: boolean,
  ): FieldOverride | null => {
    if (spec?.type !== "core.webhook") return null;
    if (field.key === "eventIdHeader") {
      return {
        control: (
          <HeaderSelect
            label={field.label}
            value={typeof value === "string" ? value : String(field.default ?? "")}
            disabled={!editable}
            onChange={set}
          />
        ),
      };
    }
    if (field.key === "auth" && value === "signed") {
      return { after: <SigningSecret workflowId={workflowId} nodeId={nodeId} /> };
    }
    return null;
  };
}

function HeaderSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const known = value === "" || EVENT_HEADERS.some((h) => h.value === value.toLowerCase());
  const [typing, setTyping] = useState(!known);
  const other = typing || !known;
  return (
    <div className="space-y-2">
      <Select
        aria-label={label}
        value={other ? OTHER : value.toLowerCase()}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (next === OTHER) {
            setTyping(true);
            onChange("");
            return;
          }
          setTyping(false);
          onChange(next);
        }}
      >
        {EVENT_HEADERS.map((h) => (
          <option key={h.value} value={h.value}>
            {h.label}
          </option>
        ))}
        <option value="">None</option>
        <option value={OTHER}>Other header…</option>
      </Select>
      {other && (
        <Input
          aria-label="Header name"
          value={value}
          placeholder="X-Event-Id"
          maxLength={100}
          spellCheck={false}
          disabled={disabled}
          // It appears because "Other header" was just picked, so typing goes there.
          autoFocus={typing && value === ""}
          className="font-mono text-xs"
          onChange={(e) => onChange(e.target.value.trim())}
        />
      )}
    </div>
  );
}

/** A clock time today, or a date and time before or after that. */
function clock(iso: string): string {
  const at = new Date(iso);
  return new Date().toDateString() === at.toDateString()
    ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The trigger's signing secret: made here, shown once, and rotated without
 * changing the URL. The old one keeps working for a while after a rotation.
 */
function SigningSecret({ workflowId, nodeId }: { workflowId: string; nodeId: string }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const status = useQuery({
    queryKey: qk.webhookSecret(workflowId, nodeId),
    queryFn: () => workflowApi.signingSecret(workflowId, nodeId),
  });
  // The secret as just made. It isn't sent again, so it's only here until the panel closes.
  const [fresh, setFresh] = useState<WebhookSecretView | null>(null);
  const rotate = useMutation({
    mutationFn: () => workflowApi.rotateSecret(workflowId, nodeId),
    onSuccess: (made) => {
      setFresh(made);
      const { secret: _secret, ...signing } = made;
      qc.setQueryData(qk.webhookSecret(workflowId, nodeId), { signing });
    },
  });
  const signing = status.data?.signing ?? null;

  return (
    <div className="space-y-1.5 pt-1">
      <p className="text-xs font-medium text-soft">Signing secret</p>
      {status.isPending ? (
        <div className="flex h-[26px] items-center">
          <Spinner className="size-3" />
        </div>
      ) : fresh ? (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-field px-2 py-1.5 font-mono text-xs shadow-field">
            {fresh.secret}
          </code>
          <CopyButton text={fresh.secret} />
        </div>
      ) : null}
      {!status.isPending && (
        <div className="flex min-h-[26px] items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-muted">
            {fresh
              ? "Shown once"
              : signing
                ? signing.rotatedAt
                  ? `Rotated ${ago(signing.rotatedAt)}`
                  : `Created ${ago(signing.createdAt)}`
                : "None yet"}
            {signing?.previousValidUntil &&
              `, old one works until ${clock(signing.previousValidUntil)}`}
          </p>
          <Button
            size="sm"
            busy={rotate.isPending}
            onClick={async () => {
              if (
                signing &&
                !(await confirm({
                  title: "Rotate the signing secret?",
                  body: "The current secret keeps working for an hour.",
                  action: "Rotate",
                }))
              ) {
                return;
              }
              rotate.mutate();
            }}
          >
            {signing ? "Rotate" : "Create secret"}
          </Button>
        </div>
      )}
      <ErrorText error={status.error ?? rotate.error} />
      {dialog}
    </div>
  );
}
