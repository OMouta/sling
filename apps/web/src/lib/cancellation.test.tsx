// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useConversationList } from "./conversations.ts";
import { useTaskDetail } from "./tasks.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A server that never answers, so every request stays open until it's aborted. */
function hanging() {
  const seen: { url: string; signal: AbortSignal }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), signal: init?.signal as AbortSignal });
      return new Promise<Response>(() => {});
    }),
  );
  return seen;
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

it("aborts a search that a newer one replaced", async () => {
  const seen = hanging();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { rerender } = renderHook(({ q }) => useConversationList(q, "all"), {
    wrapper: wrapper(qc),
    initialProps: { q: "lis" },
  });
  await waitFor(() => expect(seen).toHaveLength(1));
  rerender({ q: "lisbon" });
  await waitFor(() => expect(seen).toHaveLength(2));
  expect(seen[0]?.url).toMatch(/q=lis$/);
  await waitFor(() => expect(seen[0]?.signal.aborted).toBe(true));
  expect(seen[1]?.signal.aborted).toBe(false);
});

it("aborts a slow page's read when the page goes away", async () => {
  const seen = hanging();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { unmount } = renderHook(() => useTaskDetail("tsk_1"), { wrapper: wrapper(qc) });
  await waitFor(() => expect(seen).toHaveLength(1));
  unmount();
  await waitFor(() => expect(seen[0]?.signal.aborted).toBe(true));
  // Nothing about a cancelled read shows up as an error.
  expect(qc.getQueryState(["task", "tsk_1"])?.error ?? null).toBeNull();
});
