import { describe, expect, it, vi } from "vitest";
import source from "../public/sw.js?raw";

/**
 * The service worker's push and click handlers, run against stand-ins for
 * the worker's globals: its registration, its windows, and fetch. Headless
 * browsers deny notifications, so this is where what they show is checked.
 */

interface Shown {
  title: string;
  options: NotificationOptions & {
    actions?: { action: string; title: string }[];
    renotify?: boolean;
  };
}

interface FakeNotification {
  title: string;
  body: string;
  tag: string;
  data: { url: string; answer?: { id: string; token: string } | null };
  close: ReturnType<typeof vi.fn>;
}

function worker(respond: (url: string, init: RequestInit) => Promise<Response>) {
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const fetches: { url: string; init: RequestInit }[] = [];
  const opened: string[] = [];
  const self = {
    location: { href: "https://sling.test/sw.js", origin: "https://sling.test" },
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    skipWaiting: () => {},
    registration: {
      showNotification: async (title: string, options: Shown["options"]) => {
        shown.push({ title, options });
      },
    },
    clients: {
      matchAll: async () => [],
      openWindow: async (url: string) => {
        opened.push(url);
      },
      claim: async () => {},
    },
  };
  const fetch = (url: string, init: RequestInit) => {
    fetches.push({ url, init });
    return respond(url, init);
  };
  new Function("self", "caches", "fetch", source)(self, {}, fetch);

  async function dispatch(type: string, event: object) {
    const work: Promise<unknown>[] = [];
    handlers.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => work.push(p) });
    await Promise.all(work);
  }

  return {
    shown,
    fetches,
    opened,
    push: (payload: unknown) =>
      dispatch("push", { data: { json: () => payload } }).then(() => shown.at(-1)),
    /** Taps a shown notification, or one of its buttons. */
    click: (n: Shown, action = "") => {
      const notification: FakeNotification = {
        title: n.title,
        body: n.options.body ?? "",
        tag: n.options.tag ?? "",
        data: n.options.data as FakeNotification["data"],
        close: vi.fn(),
      };
      return dispatch("notificationclick", { action, notification }).then(() => notification);
    },
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

const SEND = {
  title: "Approve: Email jo@silva.pt: Invoice?",
  body: "Invoice for October",
  url: "/c/cnv_1",
  tag: "conv:cnv_1",
  answer: { approvalId: "cap_1", token: "claims.signature" },
};

describe("the service worker", () => {
  it("shows Allow and Deny on a push that can be answered", async () => {
    const sw = worker(() => json({ outcome: "allowed" }));
    const n = await sw.push(SEND);
    expect(n?.title).toBe(SEND.title);
    expect(n?.options).toMatchObject({
      body: SEND.body,
      tag: SEND.tag,
      renotify: true,
      actions: [
        { action: "allow", title: "Allow" },
        { action: "deny", title: "Deny" },
      ],
      data: { url: "/c/cnv_1", answer: { id: "cap_1", token: "claims.signature" } },
    });
  });

  it("shows no buttons on any other push, or on an answer it can't use", async () => {
    const sw = worker(() => json({}));
    for (const payload of [
      { title: "Approve deployment of Website?", body: "Fix", url: "/approvals", tag: "task:t" },
      { ...SEND, answer: { approvalId: "cap_1" } },
      { ...SEND, answer: { approvalId: 7, token: "x" } },
      { ...SEND, answer: "cap_1" },
    ]) {
      const n = await sw.push(payload);
      expect(n?.options.actions, JSON.stringify(payload)).toBeUndefined();
      expect(n?.options.data).toMatchObject({ answer: null });
    }
  });

  it("posts Allow with the token and no cookies, and replaces the notification with the outcome", async () => {
    const sw = worker(() => json({ outcome: "allowed" }));
    const n = await sw.push(SEND);
    if (!n) throw new Error("nothing shown");
    const tapped = await sw.click(n, "allow");
    expect(sw.fetches).toEqual([
      {
        url: "/api/approvals/cap_1/notification-answer",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "claims.signature", answer: "allow" }),
          credentials: "omit",
        },
      },
    ]);
    const after = sw.shown.at(-1);
    expect(after?.title).toBe("Allowed");
    // Same tag, so it takes the question's place, quietly and with no buttons.
    expect(after?.options).toMatchObject({ body: SEND.body, tag: SEND.tag, silent: true });
    expect(after?.options.actions).toBeUndefined();
    expect(after?.options.renotify).toBeUndefined();
    expect(tapped.close).not.toHaveBeenCalled();
    expect(sw.opened).toEqual([]);

    // Tapping the outcome opens the chat.
    if (!after) throw new Error("no outcome");
    await sw.click(after);
    expect(sw.opened).toEqual(["/c/cnv_1"]);
    expect(sw.fetches).toHaveLength(1);
  });

  it("says how each answer went", async () => {
    const cases = [
      ["deny", { outcome: "denied" }, 200, "Denied"],
      ["allow", { outcome: "already_answered" }, 200, "Already answered"],
      ["deny", { outcome: "expired" }, 200, "Expired"],
      ["allow", { error: "That answer isn't valid." }, 403, "Couldn't answer"],
      ["allow", { error: "This one can only be answered in Sling." }, 409, "Couldn't answer"],
      ["allow", { outcome: "something new" }, 200, "Couldn't answer"],
    ] as const;
    for (const [action, body, status, title] of cases) {
      const sw = worker(() => json(body, status));
      const n = await sw.push(SEND);
      if (!n) throw new Error("nothing shown");
      await sw.click(n, action);
      expect(JSON.parse(String(sw.fetches[0]?.init.body)).answer).toBe(action);
      expect(sw.shown.at(-1)?.title, JSON.stringify(body)).toBe(title);
    }
  });

  it("says it couldn't answer when the server can't be reached, and a tap still opens Sling", async () => {
    const sw = worker(() => Promise.reject(new TypeError("Failed to fetch")));
    const n = await sw.push(SEND);
    if (!n) throw new Error("nothing shown");
    await sw.click(n, "allow");
    const after = sw.shown.at(-1);
    expect(after?.title).toBe("Couldn't answer");
    if (!after) throw new Error("no outcome");
    await sw.click(after);
    expect(sw.opened).toEqual(["/c/cnv_1"]);
  });

  it("escapes the approval's ID in the path", async () => {
    const sw = worker(() => json({ outcome: "allowed" }));
    const n = await sw.push({ ...SEND, answer: { approvalId: "../tasks/x?y", token: "t" } });
    if (!n) throw new Error("nothing shown");
    await sw.click(n, "allow");
    expect(sw.fetches[0]?.url).toBe("/api/approvals/..%2Ftasks%2Fx%3Fy/notification-answer");
  });

  it("opens the page on a tap of the notification itself, without answering", async () => {
    const sw = worker(() => json({ outcome: "allowed" }));
    const n = await sw.push(SEND);
    if (!n) throw new Error("nothing shown");
    const tapped = await sw.click(n);
    expect(tapped.close).toHaveBeenCalled();
    expect(sw.opened).toEqual(["/c/cnv_1"]);
    expect(sw.fetches).toEqual([]);
  });

  it("ignores an action on a notification that has no answer", async () => {
    const sw = worker(() => json({ outcome: "allowed" }));
    const n = await sw.push({ ...SEND, answer: undefined });
    if (!n) throw new Error("nothing shown");
    await sw.click(n, "allow");
    expect(sw.fetches).toEqual([]);
    expect(sw.opened).toEqual(["/c/cnv_1"]);
  });
});
