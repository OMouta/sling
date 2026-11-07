import type { NotificationAnswerInput } from "@sling/core";
import { z } from "zod";

/** POST /api/approvals/:id/notification-answer, from the service worker, with no session. */
export const NotificationAnswerSchema = z.object({
  token: z.string().min(1).max(2000),
  answer: z.enum(["allow", "deny"]),
}) satisfies z.ZodType<NotificationAnswerInput>;
