import type { PersonalityView } from "@sling/core";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Glyph } from "./Glyph.tsx";
import { cx } from "./ui.tsx";

interface SwitchProps {
  list: PersonalityView[];
  value: PersonalityView;
  onChange: (p: PersonalityView) => void;
}

/** The personality before or after the picked one, or null at either end. */
export function neighbor(list: PersonalityView[], value: PersonalityView, by: -1 | 1) {
  const i = list.findIndex((p) => p.id === value.id);
  return list[i + by] ?? null;
}

/**
 * The row of personalities above the new chat's hero. A highlight slides to
 * the picked one. When there are more than fit, the row scrolls sideways and
 * fades at the edge that has more.
 */
export function PersonalityBar({
  list,
  value,
  onChange,
  className,
}: SwitchProps & { className?: string }) {
  const row = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<{ left: number; width: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the buttons change.
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const b = el.querySelector<HTMLElement>(`[data-id="${value.id}"]`);
      if (b && b.offsetWidth > 0) {
        setMark((m) =>
          m && m.left === b.offsetLeft && m.width === b.offsetWidth
            ? m
            : { left: b.offsetLeft, width: b.offsetWidth },
        );
      }
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
    };
    measure();
    const b = el.querySelector<HTMLElement>(`[data-id="${value.id}"]`);
    if (b && el.scrollWidth > el.clientWidth) {
      el.scrollTo({
        left: b.offsetLeft - (el.clientWidth - b.offsetWidth) / 2,
        behavior: "smooth",
      });
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [value.id, list.length]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = neighbor(list, value, e.key === "ArrowRight" ? 1 : -1);
    if (next) {
      onChange(next);
      row.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
    }
  };

  const mask =
    fade.start || fade.end
      ? `linear-gradient(to right, ${fade.start ? "transparent, #000 2.5rem" : "#000"}, ${fade.end ? "#000 calc(100% - 2.5rem), transparent" : "#000"})`
      : undefined;

  return (
    <div
      ref={row}
      role="radiogroup"
      aria-label="Personality"
      onKeyDown={onKeyDown}
      className={cx("no-scrollbar relative flex max-w-full gap-1 overflow-x-auto p-1", className)}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {mark && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1 left-0 rounded-full bg-surface shadow-card transition-[transform,width] duration-200 ease-[var(--ease-out)]"
          style={{ transform: `translateX(${mark.left}px)`, width: mark.width }}
        />
      )}
      {list.map((p) => {
        const on = p.id === value.id;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled radios inside a radiogroup.
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-id={p.id}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(p)}
            onPointerEnter={() => setHover(p.id)}
            onPointerLeave={() => setHover((h) => (h === p.id ? null : h))}
            className={cx(
              "pressable relative flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full pr-3.5 pl-2.5 text-[13px] transition-colors duration-150",
              on ? "font-medium text-text" : "text-muted hover:text-text",
            )}
          >
            <Glyph
              shape={p.shape}
              color={p.color}
              size={18}
              seed={p.id}
              lively={on || hover === p.id}
            />
            <span className="max-w-40 truncate">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The left and right arrow keys move between personalities while nothing
 * else wants them: the composer is empty, or the focus isn't in a field.
 */
export function useArrowKeys(onPrev: () => void, onNext: () => void) {
  const handlers = useRef({ onPrev, onNext });
  handlers.current = { onPrev, onNext };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest("[role=menu], [role=dialog], [role=radiogroup]")) return;
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return;
      if (el instanceof HTMLTextAreaElement && el.value !== "") return;
      if (el?.isContentEditable) return;
      e.preventDefault();
      if (e.key === "ArrowLeft") handlers.current.onPrev();
      else handlers.current.onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Horizontal swipes on touch screens: the content follows the finger, and a
 * swipe past the threshold moves to the previous or next personality.
 * Vertical scrolling is left to the browser.
 */
export function useSwipe(
  onPrev: () => void,
  onNext: () => void,
  canPrev: boolean,
  canNext: boolean,
) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const horizontal = useRef(false);

  const end = (e: PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    const moved = e.clientX - s.x;
    setDragging(false);
    setDx(0);
    if (!horizontal.current) return;
    if (moved < -56 && canNext) onNext();
    else if (moved > 56 && canPrev) onPrev();
  };

  return {
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if (e.pointerType !== "touch") return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        horizontal.current = false;
      },
      onPointerMove: (e: PointerEvent) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const x = e.clientX - s.x;
        const y = e.clientY - s.y;
        if (!horizontal.current) {
          if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) {
            start.current = null;
            return;
          }
          if (Math.abs(x) < 8) return;
          horizontal.current = true;
          setDragging(true);
        }
        // Past the first or last personality it gives, but only a little.
        const blocked = (x > 0 && !canPrev) || (x < 0 && !canNext);
        setDx(blocked ? x * 0.2 : x * 0.6);
      },
      onPointerUp: end,
      onPointerCancel: end,
    },
    style: {
      transform: dx ? `translateX(${dx}px)` : undefined,
      transition: dragging ? "none" : "transform 220ms var(--ease-out)",
      touchAction: "pan-y",
    } satisfies CSSProperties,
  };
}
