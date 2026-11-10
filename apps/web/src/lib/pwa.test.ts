// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Navigate = (e: { pathChanged: boolean; toLocation: { href: string } }) => void;

/** Starts the watch on a fresh copy of the module, with the server's shell naming `entry`. */
async function watch(entry: string) {
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(`<script type="module" src="/assets/${entry}"></script>`)),
  );
  let onNavigate: Navigate = () => {};
  const { watchForNewBuild } = await import("./pwa.ts");
  watchForNewBuild({
    subscribe: (_event, fn) => {
      onNavigate = fn;
      return () => {};
    },
  });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  return (e: Parameters<Navigate>[0]) => onNavigate(e);
}

let assign: ReturnType<typeof vi.fn<(url: string | URL) => void>>;

beforeEach(() => {
  vi.stubEnv("PROD", true);
  assign = vi.fn<(url: string | URL) => void>();
  vi.spyOn(window.location, "assign").mockImplementation(assign);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a newer build on the server", () => {
  it("loads in full on the next move to another page", async () => {
    // In tests this module's own file stands in for the build's entry chunk.
    const navigate = await watch("index-newer.js");
    navigate({ pathChanged: false, toLocation: { href: "/chats?q=a" } });
    expect(assign).not.toHaveBeenCalled();
    navigate({ pathChanged: true, toLocation: { href: "/tasks" } });
    expect(assign).toHaveBeenCalledWith("/tasks");
  });

  it("isn't there when the shell names this build", async () => {
    const navigate = await watch("pwa.ts");
    navigate({ pathChanged: true, toLocation: { href: "/tasks" } });
    expect(assign).not.toHaveBeenCalled();
  });
});
