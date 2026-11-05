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

/** Sets `data-theme` on the root element. `index.html` does the same before first paint. */
export function applyTheme(pref: ThemePref) {
  const resolved = pref === "system" ? (prefersLight() ? "light" : "dark") : pref;
  document.documentElement.dataset.theme = resolved;
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
