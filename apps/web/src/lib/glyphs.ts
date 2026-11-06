import type { GlyphShape } from "@sling/core";

/**
 * Glyph shapes, drawn in a 100×100 box around (50, 50). Each shape is a
 * function of time, so it moves on its own. `e` is how lively it is: 0 at
 * rest, 1 while the assistant is working. Filled parts and stroked parts are
 * separate paths.
 */
export interface GlyphFrame {
  fill?: string;
  stroke?: string;
}

const C = 50;
const TAU = Math.PI * 2;

type Pt = [number, number];

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** A smooth closed curve through the points (Catmull-Rom as cubic Béziers). */
function closed(pts: Pt[]): string {
  const n = pts.length;
  const at = (i: number) => pts[((i % n) + n) % n] as Pt;
  const first = at(0);
  let d = `M${f(first[0])} ${f(first[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** A closed shape from a radius at each angle. */
function polar(n: number, r: (theta: number) => number, turn = 0): string {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const rr = r(a);
    pts.push([C + rr * Math.cos(a + turn), C + rr * Math.sin(a + turn)]);
  }
  return closed(pts);
}

/** A closed curve from a parameter in [0, 2π). */
function curve(n: number, p: (s: number) => Pt): string {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push(p((i / n) * TAU));
  return closed(pts);
}

const dot = (x: number, y: number, r: number) =>
  `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;

/** Superformula radius, for rounded polygons. */
function superR(a: number, m: number, n1: number, n2: number, n3: number): number {
  const t = (m * a) / 4;
  const v = Math.abs(Math.cos(t)) ** n2 + Math.abs(Math.sin(t)) ** n3;
  return v === 0 ? 0 : v ** (-1 / n1);
}

const SHAPES: Record<GlyphShape, (t: number, e: number) => GlyphFrame> = {
  // Five soft petals that breathe and turn.
  bloom: (t, e) => {
    const depth = 0.15 + 0.04 * Math.sin(t * 1.1) + 0.06 * e;
    return {
      fill: polar(60, (a) => 40 * (0.76 + depth * Math.cos(5 * a)), t * 0.35),
    };
  },
  // A drop of ink that never settles.
  drift: (t, e) => {
    const k = 1 + 0.7 * e;
    return {
      fill: polar(
        48,
        (a) =>
          37 *
          (1 +
            k * 0.08 * Math.sin(2 * a + t * 0.9) +
            k * 0.06 * Math.sin(3 * a - t * 1.3 + 1) +
            k * 0.04 * Math.sin(5 * a + t * 1.7 + 2)),
      ),
    };
  },
  // Six rounded points, pulsing in and out.
  star: (t, e) => {
    const inner = 0.58 + 0.06 * Math.sin(t * 1.4) - 0.05 * e;
    return {
      fill: polar(
        96,
        (a) => 42 * (inner + (1 - inner) * (0.5 + 0.5 * Math.cos(6 * a)) ** 1.8),
        t * 0.22,
      ),
    };
  },
  // A rounded triangle that sharpens and softens as it turns.
  facet: (t, e) => {
    const n = 5 + 3 * (0.5 + 0.5 * Math.sin(t * 0.8)) + 2 * e;
    let max = 0;
    for (let i = 0; i < 72; i++) max = Math.max(max, superR((i / 72) * TAU, 3, n, n, n));
    return {
      fill: polar(72, (a) => (40 * superR(a, 3, n, n, n)) / max, t * 0.3 - Math.PI / 2),
    };
  },
  // A disc with waves running round its edge.
  ripple: (t, e) => ({
    fill: polar(
      72,
      (a) =>
        39 *
        (0.88 + (0.05 + 0.04 * e) * Math.sin(7 * a - t * 2.2) + 0.03 * Math.sin(3 * a + t * 1.1)),
    ),
  }),
  // A Lissajous loop, like a scribble that keeps redrawing itself.
  loop: (t, e) => {
    const phase = t * 0.55;
    const s = 37 + 2 * e;
    return {
      stroke: curve(140, (u) => [C + s * Math.sin(3 * u + phase), C + s * Math.sin(2 * u)]),
    };
  },
  // A tilted ring with a moon going round it.
  orbit: (t, e) => {
    const tilt = t * 0.35;
    const rx = 41;
    const ry = 15 + 3 * Math.sin(t * 0.7);
    const at = (u: number): Pt => {
      const x = rx * Math.cos(u);
      const y = ry * Math.sin(u);
      return [
        C + x * Math.cos(tilt) - y * Math.sin(tilt),
        C + x * Math.sin(tilt) + y * Math.cos(tilt),
      ];
    };
    const [mx, my] = at(t * (1.3 + 0.8 * e));
    return { stroke: curve(64, at), fill: `${dot(C, C, 9 + e)}${dot(mx, my, 7)}` };
  },
  // Three loops wound round the middle, slowly turning.
  twist: (t, e) => {
    // Past 1 the curve's three cusps open into loops.
    const d = 1.45 + 0.3 * Math.sin(t * 0.9) + 0.15 * e;
    const turn = t * 0.25;
    const scale = 40 / (2 + d);
    return {
      stroke: curve(150, (u) => {
        const x = 2 * Math.cos(u) + d * Math.cos(2 * u);
        const y = 2 * Math.sin(u) - d * Math.sin(2 * u);
        return [
          C + scale * (x * Math.cos(turn) - y * Math.sin(turn)),
          C + scale * (x * Math.sin(turn) + y * Math.cos(turn)),
        ];
      }),
    };
  },
};

export const GLYPH_LABELS: Record<GlyphShape, string> = {
  bloom: "Bloom",
  drift: "Drift",
  star: "Star",
  facet: "Facet",
  ripple: "Ripple",
  loop: "Loop",
  orbit: "Orbit",
  twist: "Twist",
};

export function glyphFrame(shape: GlyphShape, t: number, e = 0): GlyphFrame {
  return (SHAPES[shape] ?? SHAPES.bloom)(t, e);
}

/** A starting time from a string, so glyphs side by side don't move in step. */
export function glyphSeed(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 37;
}
