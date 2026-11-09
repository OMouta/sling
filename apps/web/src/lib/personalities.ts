import type { PersonalityColor, PersonalityTemplateView, PersonalityView } from "@sling/core";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";

export const personalitiesKey = ["personalities"] as const;

export function usePersonalities() {
  return useQuery({
    queryKey: personalitiesKey,
    queryFn: ({ signal }) => api.get<PersonalityView[]>("/api/personalities", { signal }),
    staleTime: 60_000,
  });
}

/** Ready-made personalities to add. They only change with the server. */
export function usePersonalityTemplates() {
  return useQuery({
    queryKey: ["personality-templates"],
    queryFn: ({ signal }) =>
      api.get<PersonalityTemplateView[]>("/api/personalities/templates", { signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** A personality by ID, from the list. Archived ones aren't in it. */
export function usePersonality(id: string | null | undefined): PersonalityView | undefined {
  const list = usePersonalities();
  return id ? list.data?.find((p) => p.id === id) : undefined;
}

export const COLOR_LABELS: Record<PersonalityColor, string> = {
  violet: "Violet",
  blue: "Blue",
  cyan: "Cyan",
  teal: "Teal",
  green: "Green",
  amber: "Amber",
  orange: "Orange",
  rose: "Rose",
  pink: "Pink",
  silver: "Silver",
};

/** CSS color for a personality, following the theme. */
export const colorVar = (c: PersonalityColor) => `var(--p-${c})`;

const PICK_KEY = "sling.personality";

/** The personality the new chat screen showed last. */
export function rememberedPersonality(): string | null {
  try {
    return localStorage.getItem(PICK_KEY);
  } catch {
    return null;
  }
}

export function rememberPersonality(id: string) {
  try {
    localStorage.setItem(PICK_KEY, id);
  } catch {
    // Private windows can refuse storage; the pick just isn't remembered.
  }
}

/** Live updates from the server. */
export function applyPersonalityEvent(
  qc: QueryClient,
  ev:
    | { type: "personality.updated"; personality: PersonalityView }
    | { type: "personality.removed"; id: string },
) {
  qc.setQueryData<PersonalityView[]>(personalitiesKey, (list) => {
    if (!list) return list;
    if (ev.type === "personality.removed") return list.filter((p) => p.id !== ev.id);
    const p = ev.personality;
    const next = list.some((x) => x.id === p.id)
      ? list.map((x) => (x.id === p.id ? p : x))
      : [...list, p];
    return next.sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  });
}
