import type { RuleOfferView, RuleView, ServerEvent } from "@sling/core";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";

export const rulesKey = ["rules"] as const;

export function useRules(enabled = true) {
  return useQuery({
    queryKey: rulesKey,
    queryFn: () => api.get<RuleView[]>("/api/rules"),
    enabled,
    staleTime: 30_000,
  });
}

/** A rule made, used, or revoked anywhere updates the list in place. */
export function applyRuleEvent(
  qc: QueryClient,
  ev: Extract<ServerEvent, { type: "rule.updated" }>,
) {
  qc.setQueryData<RuleView[]>(rulesKey, (list) => {
    if (!list) return list;
    const i = list.findIndex((r) => r.id === ev.rule.id);
    if (i === -1) return [ev.rule, ...list];
    const next = list.slice();
    next[i] = ev.rule;
    return next;
  });
}

/**
 * Always allow: saves the rule each offer would make, then answers the
 * question the way Allow does.
 */
export function useAlwaysAllow(
  offers: RuleOfferView[],
  approvalId: string | null,
  allow: () => Promise<unknown>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      for (const o of offers) {
        await api.post<RuleView>("/api/rules", {
          ...o.rule,
          ...(approvalId && !o.rule.approvalId ? { approvalId } : {}),
        });
      }
      return allow();
    },
    onSettled: () => qc.invalidateQueries({ queryKey: rulesKey }),
  });
}

/** Approvals in a row the card mentions: the fewest among its offers. */
export function streakOf(offers: RuleOfferView[]): number {
  return offers.length ? Math.min(...offers.map((o) => o.streak)) : 0;
}
