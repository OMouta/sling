/*
 * Sling's service worker. It shows push notifications, opens the right page
 * when one is tapped, and, when registered with ?cache=1 as production builds
 * do, starts the app from cache: built assets cache first, the app shell
 * stale while it revalidates. The API, the socket, and Vite's dev server are
 * never cached.
 */

const params = new URL(self.location.href).searchParams;
const CACHING = params.get("cache") === "1";
/** The build that registered this worker. Its assets go in their own cache. */
const BUILD = params.get("v") || "dev";
const SHELL = "sling-shell";
const ASSETS = "sling-assets-";
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
  event.waitUntil(
    self.registration.showNotification(text(p.title) || "Sling", {
      body: text(p.body),
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url },
      // A newer push about the same approval, task, or chat replaces the
      // older one, and still alerts, since it says something new.
      ...(tag ? { tag, renotify: true } : {}),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
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
