/** True when Sling runs as the installed app rather than in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || Boolean(window.matchMedia?.("(display-mode: standalone)").matches);
}

/**
 * Names this build: the hashed name of the chunk this module is in. The
 * service worker keeps each build's assets apart, and a new name makes the
 * browser install the worker again, which is when old builds are cleaned up.
 */
function buildId(): string {
  return new URL(import.meta.url).pathname.split("/").pop() ?? "";
}

/**
 * Registers the service worker, in secure contexts only, since browsers
 * allow it nowhere else. Production builds ask it to cache; on the dev server
 * it only handles push, so a change shows on the next reload. A tapped
 * notification asks this page to open a path, which `navigate` does.
 */
export function registerServiceWorker(navigate: (href: string) => void) {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: unknown; url?: unknown } | null;
    if (d?.type !== "sling:navigate" || typeof d.url !== "string") return;
    if (d.url.startsWith("/") && !d.url.startsWith("//")) navigate(d.url);
  });
  const url = import.meta.env.PROD ? `/sw.js?cache=1&v=${encodeURIComponent(buildId())}` : "/sw.js";
  const register = () =>
    navigator.serviceWorker.register(url, { scope: "/", updateViaCache: "none" }).catch(() => {
      // Without a worker the app still works; it just can't be notified.
    });
  // After the first render has the network to itself.
  if (document.readyState === "complete") void register();
  else window.addEventListener("load", () => void register(), { once: true });
}

let newBuild = false;
let checkedAt = 0;

/**
 * Asks the server for the app shell and looks for this build's entry chunk
 * in it. The service worker starts the app from its cached shell, so the
 * first open after an update runs the build before it.
 */
async function checkBuild() {
  checkedAt = Date.now();
  try {
    const res = await fetch("/", { cache: "no-cache", headers: { accept: "text/html" } });
    const html = res.ok ? await res.text() : "";
    if (/\/assets\/[^"']+\.js/.test(html) && !html.includes(`/assets/${buildId()}`)) {
      newBuild = true;
    }
  } catch {
    // Offline: check again next time.
  }
}

/**
 * Production builds check for a newer one when they start and when the tab
 * comes back after a while. Once there is one, the next move to another page
 * loads it in full, so the update arrives without interrupting anything.
 */
export function watchForNewBuild(router: {
  subscribe: (
    event: "onBeforeNavigate",
    fn: (e: { pathChanged: boolean; toLocation: { href: string } }) => void,
  ) => () => void;
}) {
  if (!import.meta.env.PROD) return;
  router.subscribe("onBeforeNavigate", (e) => {
    if (newBuild && e.pathChanged) window.location.assign(e.toLocation.href);
  });
  const check = () => {
    if (!newBuild && Date.now() - checkedAt > 10 * 60_000) void checkBuild();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  if (document.readyState === "complete") check();
  else window.addEventListener("load", check, { once: true });
}
