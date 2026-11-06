import type { GlyphShape, PersonalityColor } from "@sling/core";
import { useEffect, useMemo, useRef } from "react";
import { glyphFrame, glyphSeed } from "../lib/glyphs.ts";
import { cx } from "./ui.tsx";

/* One animation loop for every glyph on screen. */
type Tick = (dt: number) => void;
const ticks = new Set<Tick>();
let frame = 0;
let last = 0;
function loop(now: number) {
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  for (const t of ticks) t(dt);
  frame = ticks.size ? requestAnimationFrame(loop) : 0;
  if (!frame) last = 0;
}
function subscribe(t: Tick): () => void {
  ticks.add(t);
  if (!frame) frame = requestAnimationFrame(loop);
  return () => {
    ticks.delete(t);
  };
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How fast time runs for a glyph: at rest, when hovered or picked, and while working. */
const SPEED = { rest: 1, lively: 2, active: 3.2 } as const;

/**
 * A personality's moving mark. `lively` is a little faster, for a hovered or
 * picked button; `active` is for while the assistant is working. Speed
 * changes ease in, so the shape never jumps.
 */
export function Glyph({
  shape,
  color,
  size = 24,
  lively = false,
  active = false,
  still = false,
  seed = "",
  className,
  label,
}: {
  shape: GlyphShape;
  color: PersonalityColor;
  size?: number;
  lively?: boolean;
  active?: boolean;
  /** Draw one frame and don't move, for long lists. */
  still?: boolean;
  /** Glyphs side by side start at different points. */
  seed?: string;
  className?: string;
  /** Accessible name. Without it the glyph is decoration. */
  label?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const fillEl = useRef<SVGPathElement>(null);
  const strokeEl = useRef<SVGPathElement>(null);
  const start = useMemo(() => glyphSeed(seed || shape), [seed, shape]);
  const first = useMemo(() => glyphFrame(shape, start), [shape, start]);
  const target = useRef<number>(SPEED.rest);
  target.current = active ? SPEED.active : lively ? SPEED.lively : SPEED.rest;

  useEffect(() => {
    const el = svg.current;
    if (still || !el || reducedMotion()) return;
    let t = start;
    let speed = target.current;
    let energy = target.current === SPEED.active ? 1 : 0;
    const tick: Tick = (dt) => {
      const goal = target.current;
      speed += (goal - speed) * Math.min(1, dt * 2.5);
      energy += ((goal === SPEED.active ? 1 : 0) - energy) * Math.min(1, dt * 2);
      t += dt * speed;
      const fr = glyphFrame(shape, t, energy);
      if (fr.fill !== undefined) fillEl.current?.setAttribute("d", fr.fill);
      if (fr.stroke !== undefined) strokeEl.current?.setAttribute("d", fr.stroke);
    };
    let off: (() => void) | null = null;
    // Only glyphs on screen take part in the loop.
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) off ??= subscribe(tick);
      else {
        off?.();
        off = null;
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      off?.();
    };
  }, [shape, start, still]);

  return (
    <svg
      ref={svg}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx("shrink-0 overflow-visible", className)}
      style={{ color: `var(--p-${color})` }}
    >
      {first.stroke !== undefined && (
        <path
          ref={strokeEl}
          d={first.stroke}
          fill="none"
          stroke="currentColor"
          strokeWidth={9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {first.fill !== undefined && <path ref={fillEl} d={first.fill} fill="currentColor" />}
    </svg>
  );
}
