import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "./api.ts";
import type { Settings } from "./types.ts";

export const settingsKey = ["settings"] as const;

export interface TimeZoneOption {
  /** The IANA name, such as America/New_York. */
  id: string;
  /** The name as people read it: America/New York. */
  label: string;
  /** Its offset now, such as GMT-5. */
  offset: string;
  /** Lowercase words to search. */
  search: string;
}

let options: TimeZoneOption[] | null = null;

/** Every time zone this browser knows, with its offset today. Built once, on first use. */
export function timeZoneOptions(): TimeZoneOption[] {
  if (options) return options;
  const ids =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const all = ids.includes("UTC") ? ids : ["UTC", ...ids];
  const now = new Date();
  options = all.map((id) => {
    const label = id.replace(/_/g, " ");
    const offset = offsetOf(id, now);
    return { id, label, offset, search: `${label.replace(/\//g, " ")} ${offset}`.toLowerCase() };
  });
  return options;
}

export function offsetOf(id: string, at = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: id,
      timeZoneName: "shortOffset",
    }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** Options matching every word of the query, in any order. */
export function searchTimeZones(list: TimeZoneOption[], query: string): TimeZoneOption[] {
  const words = query.toLowerCase().replace(/[/_]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return list;
  return list.filter((o) => words.every((w) => o.search.includes(w)));
}

/** The browser's own time zone, or null when it doesn't say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export async function saveTimeZone(qc: QueryClient, timeZone: string) {
  await api.put("/api/settings/time-zone", { timeZone });
  qc.setQueryData<Settings>(settingsKey, (s) => (s ? { ...s, timeZone } : s));
}

let offered = false;

/**
 * A workspace starts without a time zone. The first page load that finds it
 * unset sets it from this browser, quietly; Settings can change it after.
 */
export function useDefaultTimeZone() {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => api.get<Settings>("/api/settings", { signal }),
  });
  const unset = settings.data ? settings.data.timeZone === null : false;
  useEffect(() => {
    if (!unset || offered) return;
    offered = true;
    const tz = browserTimeZone();
    if (tz) saveTimeZone(qc, tz).catch(() => {});
  }, [unset, qc]);
}
