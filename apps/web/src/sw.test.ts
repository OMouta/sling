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

/** A browser's push subscription, as the worker sees one. */
const renewed = (options: object) => ({
  endpoint: "https://fcm.googleapis.com/fcm/send/new",
  options,
  toJSON: () => ({ keys: { p256dh: "BNew", auth: "aNew" } }),
});

/** The Cache Storage API, in memory, keyed by URL. */
function memoryCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const key = (req: Request | string) => (typeof req === "string" ? req : req.url);
  const store = (name: string) => {
    let s = stores.get(name);
    if (!s) {
      s = new Map();
      stores.set(name, s);
    }
    return s;
  };
  return {
    stores,
    open: async (name: string) => {
      const s = store(name);
      return {
        match: async (req: Request | string) => s.get(key(req))?.clone(),
        put: async (req: Request | string, res: Response) => {
          s.set(key(req), res);
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (req: Request | string) => {
      for (const s of stores.values()) {
        const hit = s.get(key(req));
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };
}

function worker(
  respond: (url: string, init: RequestInit) => Promise<Response>,
  opts: { href?: string; caches?: ReturnType<typeof memoryCaches> } = {},
) {
  const href = opts.href ?? "https://sling.test/sw.js";
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const fetches: { url: string; init: RequestInit }[] = [];
  const opened: string[] = [];
  const self = {
    location: { href, origin: "https://sling.test" },
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    skipWaiting: () => {},
    navigator: {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    },
    registration: {
      pushManager: { subscribe: async (options: object) => renewed(options) },
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
  const fetch = (input: string | { url: string }, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.url;
    fetches.push({ url, init });
    return respond(url, init);
  };
  new Function("self", "caches", "fetch", source)(self, opts.caches ?? {}, fetch);

  async function dispatch(type: string, event: object) {
    const work: Promise<unknown>[] = [];
    handlers.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => work.push(p) });
    await Promise.all(work);
  }

  return {
    shown,
    fetches,
    opened,
    dispatch,
    /** A page's request, and what the worker answers it with, if it answers. */
    request: async (url: string, mode: RequestMode = "cors") => {
      let answer: Promise<Response> | undefined;
      await dispatch("fetch", {
        request: { url, method: "GET", mode },
        respondWith: (p: Promise<Response>) => {
          answer = p;
        },
      });
      return answer ? await answer : undefined;
    },
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

  it("saves a subscription the browser renews, made with the same key", async () => {
    const sw = worker(() => json({ id: "psh_2" }));
    const key = new Uint8Array([4, 1, 2]).buffer;
    await sw.dispatch("pushsubscriptionchange", {
      oldSubscription: { options: { applicationServerKey: key } },
      newSubscription: null,
    });
    expect(sw.fetches).toEqual([
      {
        url: "/api/push/subscriptions",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            endpoint: "https://fcm.googleapis.com/fcm/send/new",
            keys: { p256dh: "BNew", auth: "aNew" },
            label: "Chrome on Mac",
          }),
        },
      },
    ]);
  });
});

describe("the worker's cache", () => {
  /** A same-origin response, as the browser gives the worker. */
  const basic = (body: string, type: string) => {
    const res = new Response(body, { headers: { "content-type": type } });
    Object.defineProperty(res, "type", { value: "basic" });
    return Promise.resolve(res);
  };

  it("keeps built files, but never a page sent in place of one", async () => {
    const caches = memoryCaches();
    const sw = worker(
      (url) =>
        url.endsWith("/Settings-old.js")
          ? basic("<!doctype html>", "text/html; charset=utf-8")
          : basic("export {};", "text/javascript"),
      { href: "https://sling.test/sw.js?cache=1&v=b2", caches },
    );
    await sw.request("https://sling.test/assets/index-b2.js");
    await sw.request("https://sling.test/assets/Settings-old.js");
    const kept = [...caches.stores.values()].flatMap((s) => [...s.keys()]);
    expect(kept).toEqual(["https://sling.test/assets/index-b2.js"]);
  });
});
