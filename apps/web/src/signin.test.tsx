// @vitest-environment happy-dom
import type { ConnectorView, InstallationView, OAuthConnectionView } from "@sling/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectUrl, signInFor, signInReturn } from "./lib/signIn.ts";
import { createAppRouter } from "./router.tsx";

const CREDS = {
  type: "object",
  properties: {
    password: {
      showWhen: {
        kind: "caldav",
      },
      step: "Sign in",
      title: "Password",
      lookup: true,
      order: 2,
      type: "string",
    },
    feedUrls: {
      showWhen: {
        kind: "ics",
      },
      step: "Your iCal links",
      title: "iCal links",
      placeholder: "Paste a link",
      lookup: true,
      order: 1,
      maxItems: 5,
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
    },
    clientId: {
      showWhen: {
        kind: "google",
      },
      step: "Your Google OAuth client",
      title: "Client ID",
      placeholder: "…apps.googleusercontent.com",
      lookup: true,
      order: 1,
      type: "string",
    },
    clientSecret: {
      showWhen: {
        kind: "google",
      },
      step: "Your Google OAuth client",
      title: "Client secret",
      order: 2,
      type: "string",
    },
    accessToken: {
      hidden: true,
      type: "string",
    },
    signIn: {
      hidden: true,
      type: "object",
      properties: {
        redirectUrl: {
          type: "string",
        },
        problem: {
          type: ["string", "null"],
        },
      },
      required: ["redirectUrl", "problem"],
    },
  },
};

const CONF = {
  type: "object",
  properties: {
    kind: {
      default: "caldav",
      step: "How do you want to connect?",
      title: "Connect with",
      widget: "cards",
      lookup: true,
      order: 0,
      anyOf: [
        {
          type: "string",
          const: "caldav",
          title: "Calendar account",
          description: "Reads and adds events. iCloud, Fastmail, Nextcloud and most others.",
        },
        {
          type: "string",
          const: "google",
          title: "Google Calendar",
          description: "Reads and adds events, through your own Google Cloud OAuth client.",
        },
        {
          type: "string",
          const: "ics",
          title: "iCal link",
          description: "Reads only, from a private link. Outlook and others.",
        },
      ],
    },
    username: {
      default: "",
      showWhen: {
        kind: "caldav",
      },
      step: "Sign in",
      title: "Email",
      placeholder: "you@icloud.com",
      lookup: true,
      order: 1,
      type: "string",
    },
    serverUrl: {
      default: "",
      showWhen: {
        kind: "caldav",
      },
      step: "Sign in",
      title: "Server",
      placeholder: "https://caldav.example.com",
      advanced: true,
      lookup: true,
      order: 3,
      type: "string",
    },
    calendars: {
      default: [],
      showWhen: {
        kind: ["caldav", "google"],
      },
      step: "Your calendars",
      title: "Calendars",
      picker: true,
      emptyMeansAll: true,
      order: 4,
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
    },
    defaultCalendar: {
      default: "",
      showWhen: {
        kind: ["caldav", "google"],
      },
      step: "Your calendars",
      title: "New events go to",
      picker: true,
      order: 5,
      type: "string",
    },
    feedNames: {
      default: [],
      title: "Names, in the same order",
      hidden: true,
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
    },
  },
};

/** The calendar connector as the server describes it, Google kind included. */
const calendar: ConnectorView = {
  id: "calendar",
  name: "Calendar",
  description: "Read and add events in your calendar.",
  setupHelp: null,
  credentialsSchema: CREDS,
  secretFields: ["password", "feedUrls", "clientSecret", "accessToken"],
  configSchema: CONF,
  nodeTypes: ["calendar.list_events", "calendar.create_event"],
  hasSource: false,
  hasSetup: true,
  extension: null,
  signIn: {
    provider: "google",
    providerName: "Google",
    when: { kind: "google" },
    fields: ["clientId", "clientSecret"],
  },
};

const REDIRECT = "http://localhost:5195/api/oauth/google/callback";

function installation(id: string, kind: string, name: string): InstallationView {
  return {
    id,
    connectorId: "calendar",
    name,
    enabled: true,
    status: "idle",
    statusDetail: null,
    config: { kind, calendars: [], defaultCalendar: "" },
    hasCredentials: true,
    createdAt: "2026-11-07T10:00:00.000Z",
    updatedAt: "2026-11-07T10:00:00.000Z",
  };
}

let installed: InstallationView[] = [];
let connections: OAuthConnectionView[] = [];
let calls: { method: string; path: string; body: unknown }[] = [];
let assign: ReturnType<typeof vi.fn>;

function route(method: string, path: string, body: unknown): unknown {
  switch (`${method} ${path}`) {
    case "GET /api/status":
      return { needsSetup: false, signedIn: true, email: "a@b.c", version: "0.1.0" };
    case "GET /api/conversations":
    case "GET /api/approvals":
      return [];
    case "GET /api/connectors":
      return [calendar];
    case "GET /api/installations":
      return installed;
    case "GET /api/oauth/connections":
      return connections;
    case "POST /api/connectors/calendar/setup":
      return {
        name: "Google Calendar",
        notes: [
          {
            field: "clientId",
            tone: "info",
            text: `Make an OAuth client ID for a web application, with ${REDIRECT} as its redirect URI.`,
            link: {
              label: "Google Cloud",
              url: "https://console.cloud.google.com/apis/credentials",
            },
          },
        ],
      };
    case "POST /api/installations": {
      const b = body as { config: Record<string, unknown> };
      const created = { ...installation("ins_new", String(b.config.kind), "Google Calendar") };
      installed.push(created);
      return created;
    }
  }
  if (method === "POST" && /^\/api\/installations\/[^/]+\/test$/.test(path)) {
    return { ok: true, detail: "Found 2 calendars: ana@gmail.com, Work." };
  }
  throw new Error(`unmocked ${method} ${path}`);
}

class FakeSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onmessage = null;
  send() {}
  close() {}
}

beforeEach(() => {
  installed = [];
  connections = [];
  calls = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname.startsWith("/api/auth/")) return new Response("null", { status: 200 });
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, body });
      try {
        return new Response(JSON.stringify(route(method, url.pathname, body)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
      }
    }),
  );
  assign = vi.fn();
  vi.spyOn(window.location, "assign").mockImplementation(assign as never);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
  return router;
}

describe("signing in with Google", () => {
  it("asks only for the client, shows the redirect URI, and ends on Google's consent page", async () => {
    renderAt("/connectors");
    fireEvent.click(await screen.findByRole("button", { name: "Add Calendar" }));
    const d = within(await screen.findByRole("dialog"));
    fireEvent.click(d.getByRole("radio", { name: /Google Calendar/ }));
    const next = d.getByRole("button", { name: "Continue" });
    // Picking a kind looks things up again; Continue waits for that.
    await waitFor(() => expect(next.getAttribute("aria-busy")).toBeNull());
    fireEvent.click(next);
    expect(await d.findByRole("heading", { name: "Your Google OAuth client" })).toBeTruthy();
    expect(await d.findByText(new RegExp(REDIRECT.replace(/[./]/g, "\\$&")))).toBeTruthy();
    // The calendars come after the consent, so there's no step waiting for them.
    expect(
      d.getAllByRole("listitem").filter((li) => li.textContent?.startsWith("Step")),
    ).toHaveLength(2);
    const connect = d.getByRole("button", { name: "Connect" }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    fireEvent.change(d.getByLabelText("Client ID"), {
      target: { value: "123.apps.googleusercontent.com" },
    });
    expect(connect.disabled).toBe(true);
    const secret = d.getByLabelText("Client secret") as HTMLInputElement;
    expect(secret.type).toBe("password");
    fireEvent.change(secret, { target: { value: "GOCSPX-x" } });
    await waitFor(() => expect(connect.disabled).toBe(false));
    fireEvent.click(connect);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/api/oauth/google/start?installationId=ins_new"),
    );
    expect(
      calls.find((c) => c.method === "POST" && c.path === "/api/installations")?.body,
    ).toMatchObject({
      connectorId: "calendar",
      credentials: { clientId: "123.apps.googleusercontent.com", clientSecret: "GOCSPX-x" },
      config: { kind: "google" },
      check: false,
    });
  });

  it("offers Connect on an account that isn't signed in, and says when one is", async () => {
    installed = [
      installation("ins_g", "google", "Google Calendar"),
      installation("ins_h", "google", "Work calendar"),
      installation("ins_c", "caldav", "iCloud"),
    ];
    connections = [
      {
        installationId: "ins_h",
        provider: "google",
        scopes: [],
        connectedAt: "2026-11-07T10:00:00.000Z",
      },
    ];
    renderAt("/connectors");
    const card = (name: string) => screen.findByRole("article", { name });
    const notYet = within(await card("Google Calendar"));
    expect(await notYet.findByText("Not connected")).toBeTruthy();
    fireEvent.click(notYet.getByRole("button", { name: "Connect" }));
    expect(assign).toHaveBeenCalledWith("/api/oauth/google/start?installationId=ins_g");
    const done = within(await card("Work calendar"));
    expect(await done.findByText("Connected")).toBeTruthy();
    expect(done.queryByRole("button", { name: "Connect" })).toBeNull();
    const caldav = within(await card("iCloud"));
    expect(caldav.queryByText(/connected/i)).toBeNull();
  });

  it("checks the account right after coming back from Google", async () => {
    installed = [installation("ins_g", "google", "Google Calendar")];
    connections = [
      {
        installationId: "ins_g",
        provider: "google",
        scopes: [],
        connectedAt: "2026-11-07T10:00:00.000Z",
      },
    ];
    const router = renderAt("/connectors?oauth=connected&installation=ins_g");
    const card = within(await screen.findByRole("article", { name: "Google Calendar" }));
    expect((await card.findByRole("status")).textContent).toBe(
      "Connection works. Found 2 calendars: ana@gmail.com, Work.",
    );
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("says why connecting didn't finish, on the account it was for", async () => {
    installed = [installation("ins_g", "google", "Google Calendar")];
    renderAt(
      "/connectors?oauth=failed&installation=ins_g&error=Google%20sign-in%20was%20canceled.",
    );
    const card = within(await screen.findByRole("article", { name: "Google Calendar" }));
    expect((await card.findByRole("alert")).textContent).toBe("Google sign-in was canceled.");
    expect(card.getByRole("button", { name: "Connect" })).toBeTruthy();
  });
});

describe("signIn helpers", () => {
  it("apply only to the config the connector names, and read the way back", () => {
    expect(signInFor(calendar, { kind: "google" })?.provider).toBe("google");
    expect(signInFor(calendar, { kind: "caldav" })).toBeNull();
    expect(signInFor({ signIn: null }, { kind: "google" })).toBeNull();
    expect(connectUrl(calendar.signIn as NonNullable<ConnectorView["signIn"]>, "ins 1")).toBe(
      "/api/oauth/google/start?installationId=ins+1",
    );
    expect(signInReturn({ oauth: "failed", error: "no" })).toEqual({
      outcome: "failed",
      installationId: null,
      error: "no",
    });
    expect(signInReturn({ tab: "x" })).toBeNull();
  });
});
