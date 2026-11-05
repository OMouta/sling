import { useSyncExternalStore } from "react";

/** Whether a media query matches, updated as it changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
  );
}

/** Phones get a view-only canvas; Tailwind's `md` breakpoint is the cutoff. */
export function useIsPhone(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
