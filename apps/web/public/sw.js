/*
 * Sling's service worker. It shows push notifications, opens the right page
 * when one is tapped, and answers Allow and Deny on the ones that have them.
 * When registered with ?cache=1, as production builds do, it starts the app
 * from cache: built assets cache first, the app shell stale while it
 * revalidates. The API, the socket, and Vite's dev server are never cached.
 */

const params = new URL(self.location.href).searchParams;
const CACHING = params.get("cache") === "1";
/** The build that registered this worker. Its assets go in their own cache. */
const BUILD = params.get("v") || "dev";
const SHELL = "sling-shell";
const ASSETS = "sling-assets-";
const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-96.png";
/** Paths that always go to the network: the API, the Runner, hooks, installers, and Vite's dev paths. */
const NEVER = /^\/(api|runner|hooks|healthz|install\.(sh|ps1)|@|src\/|node_modules\/|__)/;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const ours = names.filter((n) => n === SHELL || n.startsWith(ASSETS));
      if (!CACHING) {
        await Promise.all(ours.map((n) => caches.delete(n)));
      } else {
        await caches.open(ASSETS + BUILD);
        // Cache names list in the order they were made. A page of the build
        // before may still be open and load a chunk, so two builds stay.
        const builds = (await caches.keys()).filter((n) => n.startsWith(ASSETS));
        const keep = new Set([...builds.slice(-2), ASSETS + BUILD]);
        await Promise.all(builds.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (!CACHING) return;
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(asset(event));
  } else if (request.mode === "navigate" && !/\.[a-z0-9]+$/i.test(url.pathname)) {
    event.respondWith(shell(event));
  }
});

/** Built assets have hashed names, so a cached one is always right. */
async function asset(event) {
  const hit = await caches.match(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (res.status === 200 && res.type === "basic") {
    const copy = res.clone();
    event.waitUntil(caches.open(ASSETS + BUILD).then((c) => c.put(event.request, copy)));
  }
  return res;
}

/** Every page is the same index.html. Serve the cached one, and refresh it for next time. */
async function shell(event) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match("/");
  const fresh = fetch(event.request).then((res) => {
    if (res.status === 200 && (res.headers.get("content-type") || "").includes("text/html")) {
      event.waitUntil(cache.put("/", res.clone()));
    }
    return res;
  });
  if (!cached) return fresh;
  event.waitUntil(fresh.catch(() => {}));
  return cached;
}

self.addEventListener("push", (event) => {
  let p = {};
  try {
    p = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: show the plain notification below.
  }
  const text = (v) => (typeof v === "string" ? v : "");
  const tag = text(p.tag);
  const url = text(p.url).startsWith("/") ? p.url : "/";
  const a = p.answer;
  const answer =
    a && text(a.approvalId) && text(a.token) ? { id: a.approvalId, token: a.token } : null;
  event.waitUntil(
    self.registration.showNotification(text(p.title) || "Sling", {
      body: text(p.body),
      icon: ICON,
      badge: BADGE,
      data: { url, answer },
      // Only a send, or a task's push and PR, comes with a token to answer it.
      ...(answer
        ? {
            actions: [
              { action: "allow", title: "Allow" },
              { action: "deny", title: "Deny" },
            ],
          }
        : {}),
      // A newer push about the same approval, task, or chat replaces the
      // older one, and still alerts, since it says something new.
      ...(tag ? { tag, renotify: true } : {}),
    }),
  );
});

const OUTCOMES = {
  allowed: "Allowed",
  denied: "Denied",
  already_answered: "Already answered",
  expired: "Expired",
};

/** Posts the answer, then shows how it went in the question's place. A tap on that opens the page. */
async function sendAnswer(n, choice) {
  const { url, answer: a } = n.data;
  let title = "Couldn't answer";
  try {
    const res = await fetch(`/api/approvals/${encodeURIComponent(a.id)}/notification-answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: a.token, answer: choice }),
      // The token is the only credential it needs.
      credentials: "omit",
    });
    if (res.ok) title = OUTCOMES[(await res.json()).outcome] || title;
  } catch {
    // Offline, or the server is down. The tap still opens Sling.
  }
  if (!n.tag) n.close();
  await self.registration.showNotification(title, {
    body: n.body,
    icon: ICON,
    badge: BADGE,
    data: { url },
    silent: true,
    ...(n.tag ? { tag: n.tag } : {}),
  });
}

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  if ((event.action === "allow" || event.action === "deny") && n.data?.answer) {
    event.waitUntil(sendAnswer(n, event.action));
    return;
  }
  n.close();
  const url = n.data?.url || "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = windows.find((w) => w.focused) || windows[0];
      if (!win) {
        await self.clients.openWindow(url);
        return;
      }
      await win.focus();
      // The page moves there itself, without reloading what it has open.
      win.postMessage({ type: "sling:navigate", url });
    })(),
  );
});

/*
 * The browser can renew or drop this device's push subscription on its own.
 * Subscribe again with the same key and save it, so pushes keep arriving.
 * The old one is removed on the server the first time a push to it fails.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options?.applicationServerKey;
      const sub =
        event.newSubscription ||
        (key
          ? await self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: key,
            })
          : null);
      if (!sub) return;
      const { keys = {} } = sub.toJSON();
      await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: { p256dh: keys.p256dh || "", auth: keys.auth || "" },
          label: deviceLabel(self.navigator.userAgent),
        }),
      }).catch(() => {});
    })(),
  );
});

/** "Chrome on Mac" and the like, as the page names a device. */
function deviceLabel(ua) {
  const find = (pairs, fallback) => pairs.find(([re]) => re.test(ua))?.[1] || fallback;
  const browser = find(
    [
      [/Edg(e|A|iOS)?\//, "Edge"],
      [/Firefox\/|FxiOS\//, "Firefox"],
      [/OPR\/|Opera/, "Opera"],
      [/SamsungBrowser\//, "Samsung Internet"],
      [/Chrome\/|CriOS\/|Chromium\//, "Chrome"],
      [/Safari\//, "Safari"],
    ],
    "Browser",
  );
  const device = find(
    [
      [/iPhone|iPod/, "iPhone"],
      [/iPad/, "iPad"],
      [/Android/, "Android"],
      [/CrOS/, "ChromeOS"],
      [/Macintosh|Mac OS X/, "Mac"],
      [/Windows/, "Windows"],
      [/Linux/, "Linux"],
    ],
    "this device",
  );
  return `${browser} on ${device}`;
}
