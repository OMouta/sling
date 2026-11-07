// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";

const signUp = vi.fn(async (_body: unknown) => ({ data: {}, error: null }));

// The auth client keeps the fetch it found at import, before the stub below.
vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signUp: { email: (body: unknown) => signUp(body) },
    signOut: async () => {},
  },
}));

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  send() {}
  close() {}
}

beforeEach(() => {
  signUp.mockClear();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname === "/api/status") {
        return Response.json({
          needsSetup: true,
          signedIn: false,
          email: null,
          version: "0.1.0",
          publicUrl: window.location.origin,
        });
      }
      return Response.json(null);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("first-run setup", () => {
  it("creates the first account once every field is filled in", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter(createMemoryHistory({ initialEntries: ["/setup"] }));
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} context={{ queryClient }} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Set up Sling")).toBeTruthy();
    const create = screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Tiago" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "t@example.com" } });
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "too-short" } });
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "long-enough-1" } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(signUp).toHaveBeenCalledTimes(1));
    expect(signUp.mock.calls[0]?.[0]).toEqual({
      name: "Tiago",
      email: "t@example.com",
      password: "long-enough-1",
    });
  });
});
