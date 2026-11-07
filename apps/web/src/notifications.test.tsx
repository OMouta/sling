// @vitest-environment happy-dom
import type { NotificationSettings, PersonalityView, PushSubscriptionView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";

vi.mock("./lib/auth.ts", () => ({
  authClient: {
    useSession: () => ({ data: null, refetch: () => {} }),
    useListPasskeys: () => ({ data: [], refetch: () => {} }),
    signOut: async () => {},
  },
}));

const PIXEL =
  "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";

/** Sling's VAPID key as /api/push/key serves it: 65 bytes, base64url. */
const KEY_BYTES = new Uint8Array(65).map((_, i) => (i === 0 ? 4 : i));
const KEY = btoa(String.fromCharCode(...KEY_BYTES))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

function personality(p: Partial<PersonalityView> & Pick<PersonalityView, "id" | "name">) {
  return {
    description: `${p.name} answers here.`,
    instructions: "",
    tools: ["commands", "coding"],
    color: "violet",
    shape: "bloom",
    isDefault: false,
    position: 0,
    revision: 1,
    templateKey: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...p,
  } as PersonalityView;
}

const PERSONALITIES = [
  personality({ id: "per_sling", name: "Sling", isDefault: true, templateKey: "sling" }),
  personality({ id: "per_inc", name: "Incident", position: 1, templateKey: "incident" }),
  personality({ id: "per_plan", name: "Planner", position: 2, templateKey: "planner" }),
];

interface State {
  timeZone: string | null;
  notifications: NotificationSettings;
  devices: PushSubscriptionView[];
}
let state: State;
const calls: { method: string; path: string; body: unknown }[] = [];

function device(id: string, label: string, extra: Partial<PushSubscriptionView> = {}) {
  return {
    id,
    label,
    service: "fcm.googleapis.com",
    createdAt: "2026-11-05T10:00:00.000Z",
    lastDeliveredAt: null,
    lastError: null,
    ...extra,
  };
}

function route(method: string, path: string, body: unknown): unknown {
  if (method !== "GET") calls.push({ method, path, body });
  switch (`${method} ${path}`) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/settings":
      return {
        defaultMode: "auto",
        modes: ["read-only", "supervised", "auto", "full-access"],
        providers: [],
        model: { provider: "openai", model: "gpt", baseUrl: null, hasKey: true },
        timeZone: state.timeZone,
        notifications: state.notifications,
      };
    case "PUT /api/settings/time-zone":
      state.timeZone = (body as { timeZone: string }).timeZone;
      return { ok: true };
    case "PUT /api/settings/notifications":
      state.notifications = { ...state.notifications, ...(body as object) };
      return state.notifications;
    case "GET /api/push/key":
      return { publicKey: KEY };
    case "GET /api/push/subscriptions":
      return state.devices;
    case "POST /api/push/subscriptions": {
      const d = device("psh_new", (body as { label: string }).label);
      state.devices = [...state.devices, d];
      return d;
    }
    case "POST /api/push/test":
      return { ok: true, error: null };
    case "GET /api/personalities":
      return PERSONALITIES;
    case "GET /api/runners":
      return [
        {
          id: "rnr_1",
          name: "laptop",
          online: true,
          ephemeral: false,
          revokedAt: null,
        },
      ];
    case "GET /api/conversations":
    case "GET /api/approvals":
    case "GET /api/tasks":
    case "GET /api/connectors":
    case "GET /api/installations":
      return [];
    default:
      if (method === "DELETE" && path.startsWith("/api/push/subscriptions/")) {
        const id = path.split("/").pop();
        state.devices = state.devices.filter((d) => d.id !== id);
        return { ok: true };
      }
      return null;
  }
}

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  send() {}
  close() {}
}

/** The browser's push machinery: a service worker registration and its push manager. */
function fakePush() {
  let current: {
    endpoint: string;
    options: { applicationServerKey: ArrayBuffer };
    toJSON: () => unknown;
    unsubscribe: () => Promise<boolean>;
  } | null = null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (opts: { applicationServerKey: Uint8Array }) => {
      const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
      current = {
        endpoint,
        options: { applicationServerKey: opts.applicationServerKey.slice().buffer },
        toJSON: () => ({ endpoint, keys: { p256dh: "BPk-browser-key", auth: "c2VjcmV0" } }),
        unsubscribe: vi.fn(async () => {
          current = null;
          return true;
        }),
      };
      return current;
    }),
  };
  const registration = { pushManager };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
      register: async () => registration,
      addEventListener: () => {},
    },
  });
  vi.stubGlobal("PushManager", class {});
  const requestPermission = vi.fn(async () => "granted");
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  return { pushManager, requestPermission };
}

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
}

function setSecure(secure: boolean) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: secure });
}

beforeEach(() => {
  state = {
    timeZone: "Europe/Lisbon",
    notifications: { approvals: true, tasks: true, replies: true },
    devices: [],
  };
  calls.length = 0;
  localStorage.clear();
  setSecure(true);
  setUserAgent(PIXEL);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return Response.json(route(init?.method ?? "GET", url.pathname, body));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function open(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
  return router;
}

async function notificationsSection() {
  const heading = await screen.findByRole("heading", { name: "Notifications" });
  return within(heading.closest("section") as HTMLElement);
}

describe("Settings → Notifications", () => {
  it("turns notifications on for this device with Sling's key and a label for it", async () => {
    const { pushManager, requestPermission } = fakePush();
    open("/settings");
    const section = await notificationsSection();
    const toggle = await section.findByRole("switch", { name: "Notifications on this device" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(section.getByText("Chrome on Android")).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(requestPermission).toHaveBeenCalledOnce();
    const opts = pushManager.subscribe.mock.calls[0]?.[0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(opts.userVisibleOnly).toBe(true);
    expect([...opts.applicationServerKey]).toEqual([...KEY_BYTES]);
    expect(calls.find((c) => c.path === "/api/push/subscriptions")?.body).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/device-1",
      keys: { p256dh: "BPk-browser-key", auth: "c2VjcmV0" },
      label: "Chrome on Android",
    });
    const list = within(section.getByRole("list", { name: "Devices" }));
    expect(list.getByText("Chrome on Android")).toBeTruthy();
    expect(list.getByText("This device")).toBeTruthy();

    // Turning it off removes the device and the browser's subscription.
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/api/push/subscriptions/psh_new",
    });
    expect(await pushManager.getSubscription()).toBeNull();
  });

  it("lists the devices, sends a test notification, and removes one", async () => {
    fakePush();
    state.devices = [
      device("psh_1", "Safari on iPhone", {
        service: "web.push.apple.com",
        lastDeliveredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
      device("psh_2", "Firefox on Windows", { lastError: "The push service answered 500." }),
    ];
    open("/settings");
    const section = await notificationsSection();
    const list = within(await section.findByRole("list", { name: "Devices" }));
    expect(list.getAllByRole("listitem")).toHaveLength(2);
    expect(list.getByText("The last notification failed.")).toBeTruthy();

    fireEvent.click(
      list.getByRole("button", { name: "Send a test notification to Safari on iPhone" }),
    );
    expect(await list.findByText("Sent. Check the device.")).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/push/test")?.body).toEqual({ id: "psh_1" });

    fireEvent.click(list.getByRole("button", { name: "Remove Firefox on Windows" }));
    await waitFor(() => expect(list.queryByText("Firefox on Windows")).toBeNull());
    expect(
      calls.some((c) => c.method === "DELETE" && c.path === "/api/push/subscriptions/psh_2"),
    ).toBe(true);
  });

  it("switches each category on its own", async () => {
    fakePush();
    open("/settings");
    const section = await notificationsSection();
    const replies = await section.findByRole("switch", { name: "Replies" });
    expect(replies.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(replies);
    await waitFor(() => expect(replies.getAttribute("aria-checked")).toBe("false"));
    expect(calls.find((c) => c.path === "/api/settings/notifications")?.body).toEqual({
      replies: false,
    });
    expect(section.getByRole("switch", { name: "Approvals" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      section.getByRole("switch", { name: "Finished tasks" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("on iOS Safari, explains adding Sling to the Home Screen first", async () => {
    setUserAgent(IPHONE);
    open("/settings");
    const section = await notificationsSection();
    expect(await section.findByText("Add Sling to your Home Screen first.")).toBeTruthy();
    expect(section.getByText("Choose Add to Home Screen.")).toBeTruthy();
    expect(section.queryByRole("switch", { name: "Notifications on this device" })).toBeNull();
  });

  it("says plainly that push needs HTTPS when the page isn't secure", async () => {
    setSecure(false);
    open("/settings");
    const section = await notificationsSection();
    expect(await section.findByText(/Push needs HTTPS\./)).toBeTruthy();
    expect(section.queryByRole("switch", { name: "Notifications on this device" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the time zone", () => {
  it("is set from the browser, once, while the workspace has none", async () => {
    state.timeZone = null;
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    open("/settings");
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/settings/time-zone")).toEqual([
        { method: "PUT", path: "/api/settings/time-zone", body: { timeZone: browser } },
      ]),
    );
  });

  it("is picked in Settings → General by searching", async () => {
    open("/settings");
    const button = await screen.findByRole("button", { name: "Time zone" });
    expect(button.textContent).toContain("Europe/Lisbon");
    fireEvent.click(button);
    const search = screen.getByRole("textbox", { name: "Search time zones" });
    fireEvent.change(search, { target: { value: "new york" } });
    const options = within(screen.getByRole("listbox", { name: "Time zones" })).getAllByRole(
      "option",
    );
    expect(options.map((o) => o.textContent?.split("GMT")[0])).toEqual(["America/New York"]);
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(button.textContent).toContain("America/New York"));
    expect(calls).toContainEqual({
      method: "PUT",
      path: "/api/settings/time-zone",
      body: { timeZone: "America/New_York" },
    });
    expect(screen.queryByRole("listbox", { name: "Time zones" })).toBeNull();
    // Nothing was set behind the person's back: the zone was already there.
    expect(calls.filter((c) => c.path === "/api/settings/time-zone")).toHaveLength(1);
  });
});

describe("new chat links", () => {
  async function composer() {
    return (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
  }

  it("open the new chat screen with the draft and the personality from a template key", async () => {
    const router = open(
      "/?draft=Website%20is%20down%20(502%20since%2014%3A02).%20Find%20out%20why%20and%20fix%20it.&personality=incident",
    );
    const box = await composer();
    await waitFor(() =>
      expect(box.value).toBe("Website is down (502 since 14:02). Find out why and fix it."),
    );
    expect(await screen.findByRole("heading", { name: "Incident", level: 2 })).toBeTruthy();
    await waitFor(() => expect(router.state.location.href).toBe("/"));
    // Nothing is sent until the person sends it.
    expect(calls.some((c) => c.path === "/api/conversations")).toBe(false);
  });

  it("find a personality by name or ID, and fall back to the default", async () => {
    open("/?personality=Planner");
    expect(await screen.findByRole("heading", { name: "Planner", level: 2 })).toBeTruthy();
    cleanup();
    open("/?personality=per_inc&draft=42");
    expect(await screen.findByRole("heading", { name: "Incident", level: 2 })).toBeTruthy();
    await waitFor(async () => expect((await composer()).value).toBe("42"));
    cleanup();
    open("/?personality=nobody");
    expect(await screen.findByRole("heading", { name: "Sling", level: 2 })).toBeTruthy();
  });
});
