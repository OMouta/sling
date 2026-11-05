import type { ApprovalInput } from "./schemas.ts";

/**
 * Message components as Discord's API takes them. Only what approval
 * messages use.
 */
export interface ButtonComponent {
  type: 2;
  /** 3 is success (green), 4 is danger (red). */
  style: 3 | 4;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

export interface ActionRow {
  type: 1;
  components: ButtonComponent[];
}

export const MESSAGE_LIMIT = 2000;

const CUSTOM_ID = /^sling:approval:([A-Za-z0-9_-]{1,80}):(approve|reject)$/;

export function approvalCustomId(approvalId: string, action: "approve" | "reject"): string {
  return `sling:approval:${approvalId}:${action}`;
}

/** Null for buttons that aren't Sling approval buttons. */
export function parseApprovalCustomId(
  customId: string,
): { approvalId: string; approve: boolean } | null {
  const m = CUSTOM_ID.exec(customId);
  if (!m?.[1]) return null;
  return { approvalId: m[1], approve: m[2] === "approve" };
}

export function isValidApprovalId(id: string): boolean {
  return CUSTOM_ID.test(approvalCustomId(id, "approve"));
}

export function approvalButtons(
  approvalId: string,
  options: { disabled?: boolean } = {},
): ActionRow[] {
  const disabled = options.disabled ? { disabled: true } : {};
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Approve",
          custom_id: approvalCustomId(approvalId, "approve"),
          ...disabled,
        },
        {
          type: 2,
          style: 4,
          label: "Reject",
          custom_id: approvalCustomId(approvalId, "reject"),
          ...disabled,
        },
      ],
    },
  ];
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** The text of an approval message: an optional lead-in, then title, summary, and link. */
export function approvalText(approval: ApprovalInput, lead = ""): string {
  const head = [lead.trim(), `**${approval.title.trim() || "Approval needed"}**`]
    .filter(Boolean)
    .join("\n\n");
  const tail = [`Review it in Sling: ${approval.url}`];
  const expires = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
  if (Number.isFinite(expires)) tail.push(`Expires <t:${Math.floor(expires / 1000)}:R>`);
  const tailText = tail.join("\n");
  const summary = approval.summary?.trim() ?? "";
  // Give the summary whatever room the title and link leave, so the link always survives.
  const room = MESSAGE_LIMIT - head.length - tailText.length - 4;
  const parts = [head];
  if (summary && room > 20) parts.push(truncate(summary, room));
  parts.push(tailText);
  return truncate(parts.join("\n\n"), MESSAGE_LIMIT);
}

/** The approval message after someone decided it from Discord. */
export function decidedText(original: string, approve: boolean, userId: string): string {
  const outcome = approve ? `✅ Approved by <@${userId}>` : `❌ Rejected by <@${userId}>`;
  return `${truncate(original, MESSAGE_LIMIT - outcome.length - 2)}\n\n${outcome}`;
}
