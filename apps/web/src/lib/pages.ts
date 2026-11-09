import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/** A page of a list the server pages: the items and where the next page starts. */
export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

type Cached<T> = Paged<T> | InfiniteData<Paged<T>, string>;

function pagesOf<T>(data: Cached<T>): Paged<T>[] {
  const pages = "pages" in data ? data.pages : [data];
  return pages.every((p) => Array.isArray(p?.items)) ? pages : [];
}

/**
 * Changes an item in every cached page of the lists under `queryKey`, or
 * takes it out when `fn` returns null. Returns whether any list had it.
 */
export function patchPaged<T extends { id: string }>(
  qc: QueryClient,
  queryKey: QueryKey,
  id: string,
  fn: (item: T) => T | null,
): boolean {
  let found = false;
  for (const [key, data] of qc.getQueriesData<Cached<T>>({ queryKey })) {
    if (!data) continue;
    let changed = false;
    const pages = pagesOf(data).map((page) => {
      const i = page.items.findIndex((x) => x.id === id);
      const current = page.items[i];
      if (!current) return page;
      changed = true;
      const next = fn(current);
      const items = page.items.slice();
      if (next) items[i] = next;
      else items.splice(i, 1);
      return { ...page, items };
    });
    if (!changed) continue;
    found = true;
    qc.setQueryData<Cached<T>>(key, "pages" in data ? { ...data, pages } : pages[0]);
  }
  return found;
}

/** Changes every item in every cached page of the lists under `queryKey`. */
export function mapPaged<T>(qc: QueryClient, queryKey: QueryKey, fn: (item: T) => T) {
  for (const [key, data] of qc.getQueriesData<Cached<T>>({ queryKey })) {
    if (!data) continue;
    const pages = pagesOf(data).map((page) => ({ ...page, items: page.items.map(fn) }));
    if (pages.length === 0) continue;
    qc.setQueryData<Cached<T>>(key, "pages" in data ? { ...data, pages } : pages[0]);
  }
}

/**
 * The last counts a list's first page gave. Every filter counts the same
 * things, so tab counts stay put while another tab's page loads.
 */
export function useStickyCounts<C>(counts: C | null | undefined): C | null {
  const last = useRef<C | null>(null);
  if (counts) last.current = counts;
  return last.current;
}

/**
 * Loads a list's next page as the end of it scrolls into view. Put the ref
 * on an empty element after the last row.
 */
export function useLoadMore(list: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
}) {
  const end = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const el = end.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "400px 0px" },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return end;
}
