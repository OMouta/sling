import { useSyncExternalStore } from "react";

export type ThemePref = "dark" | "light" | "system";

const KEY = "sling.theme";
const listeners = new Set<() => void>();

export function storedTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch {
    // Storage can be blocked; dark is the default.
  }
  return "dark";
}

function prefersLight(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
}

/** The page background per theme, which the browser's own bars take on. */
const BAR = { dark: "#161616", light: "#fbfbfb" } as const;

/** The theme a preference shows now: System follows the device. */
export function resolvedTheme(pref: ThemePref): "dark" | "light" {
  return pref === "system" ? (prefersLight() ? "light" : "dark") : pref;
}

/** Sets `data-theme` on the root element. `index.html` does the same before first paint. */
export function applyTheme(pref: ThemePref) {
  const resolved = resolvedTheme(pref);
  document.documentElement.dataset.theme = resolved;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = BAR[resolved];
  }
}

export function setTheme(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Not persisted; still applied for this tab.
  }
  applyTheme(pref);
  for (const l of listeners) l();
}

if (typeof matchMedia === "function") {
  matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if (storedTheme() === "system") applyTheme("system");
  });
}

export function useTheme(): ThemePref {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, storedTheme);
}
