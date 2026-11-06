import type { PushSubscriptionView } from "@sling/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { isStandalone } from "./pwa.ts";

export const devicesKey = ["push-subscriptions"] as const;

export function usePushDevices() {
  return useQuery({
    queryKey: devicesKey,
    queryFn: () => api.get<PushSubscriptionView[]>("/api/push/subscriptions"),
  });
}

/** A name for this browser, such as "Safari on iPhone", from its user agent. */
export function deviceLabel(ua: string, touchPoints = 0): string {
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua)
      ? "Firefox"
      : /OPR\/|Opera/.test(ua)
        ? "Opera"
        : /SamsungBrowser\//.test(ua)
          ? "Samsung Internet"
          : /Chrome\/|CriOS\/|Chromium\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Browser";
  // iPads ask for desktop sites, so they say Macintosh and have a touch screen.
  const device = /iPhone|iPod/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Macintosh|Mac OS X/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : "this device";
  return `${browser} on ${device}`;
}

/**
 * Whether this page can turn push on:
 * - `insecure`: push needs HTTPS or localhost
 * - `home-screen`: iOS only allows push in an app added to the Home Screen
 * - `unsupported`: the browser has no Web Push
 * - `blocked`: the user said no to notifications for this site
 * - `ready`: it can ask, or already has permission
 */
export type PushSupport = "insecure" | "home-screen" | "unsupported" | "blocked" | "ready";

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return "insecure";
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios && !isStandalone()) return "home-screen";
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return Notification.permission === "denied" ? "blocked" : "ready";
}

const STORE = "sling.push";

/** The subscription this browser made, and the device it is on the server. */
interface Remembered {
  endpoint: string;
  id: string;
}

function remembered(): Remembered | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as Remembered | null;
    return v && typeof v.endpoint === "string" && typeof v.id === "string" ? v : null;
  } catch {
    return null;
  }
}

function remember(v: Remembered | null) {
  try {
    if (v) localStorage.setItem(STORE, JSON.stringify(v));
    else localStorage.removeItem(STORE);
  } catch {
    // Storage can be blocked. The device still gets pushes; this page just
    // can't tell which listed device it is.
  }
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((x, i) => x === b[i]);
}

/**
 * Which listed device is this browser, if any: its push subscription is the
 * one Sling saved from here.
 */
export async function thisDeviceId(): Promise<string | null> {
  const saved = remembered();
  if (!saved || !("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager?.getSubscription();
  return sub?.endpoint === saved.endpoint ? saved.id : null;
}

export class PushDenied extends Error {}

/** Asks for permission, subscribes with Sling's key, and saves the device. */
export async function turnOnPush(): Promise<PushSubscriptionView> {
  const permission =
    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushDenied(
      permission === "denied"
        ? "Notifications are blocked for this site."
        : "Notifications weren't allowed. Turn them on again to be asked once more.",
    );
  }
  const [{ publicKey }, reg] = await Promise.all([
    api.get<{ publicKey: string }>("/api/push/key"),
    navigator.serviceWorker.ready,
  ]);
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with an older key can't be pushed to any more.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  const device = await api.post<PushSubscriptionView>("/api/push/subscriptions", {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints),
  });
  remember({ endpoint: sub.endpoint, id: device.id });
  return device;
}

/** Removes a device. For this browser, also drops its subscription. */
export async function removeDevice(id: string, isThisDevice: boolean) {
  await api.del(`/api/push/subscriptions/${id}`);
  if (!isThisDevice) return;
  remember(null);
  const reg = await navigator.serviceWorker?.getRegistration("/");
  await (await reg?.pushManager?.getSubscription())?.unsubscribe();
}
