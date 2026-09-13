export interface Point {
  x: number;
  y: number;
}

/** Linear scale: maps a domain value to a range value. */
export function linearScale(
  domain: [number, number],
  range: [number, number]
) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

/**
 * Signed-log transform: compresses values far from zero while keeping the
 * region near zero close to linear. Used for the balance axis so the
 * waterline crossing (the dramatic part) gets real visual space even when
 * the timeline also contains a much larger paycheck peak.
 */
export function signedLog(value: number, softness = 60): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.log1p(Math.abs(value) / softness);
}

/**
 * Smooths a polyline into an SVG path using the "midpoint quadratic" trick:
 * each original point becomes a control point, and the curve passes through
 * the midpoints between consecutive points. Cheap, stable, no overshoot.
 */
export function smoothPath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let d = `M ${points[0].x} ${points[0].y}`;
  d += ` L ${(points[0].x + points[1].x) / 2} ${(points[0].y + points[1].y) / 2}`;
  for (let i = 1; i < points.length - 1; i++) {
    const cur = points[i];
    const next = points[i + 1];
    const midX = (cur.x + next.x) / 2;
    const midY = (cur.y + next.y) / 2;
    d += ` Q ${cur.x} ${cur.y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** Closed area path between the smoothed curve and a horizontal baseline y. */
export function areaToBaseline(points: Point[], baselineY: number): string {
  if (points.length === 0) return "";
  const curve = smoothPath(points);
  const first = points[0];
  const last = points[points.length - 1];
  return `${curve} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}

const PATH_TOKEN = /[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g;

/**
 * Point-wise interpolation between two SVG path strings that share the same
 * command structure (same commands in the same order: guaranteed here since
 * both are built by smoothPath/areaToBaseline from equal-length point
 * arrays). Framer Motion doesn't reliably morph arbitrary `d` keyframes, so
 * this drives the cascade's "sinking" animation by hand, frame by frame.
 */
export function lerpPath(a: string, b: string, t: number): string {
  const ta = a.match(PATH_TOKEN) ?? [];
  const tb = b.match(PATH_TOKEN) ?? [];
  const len = Math.min(ta.length, tb.length);
  const out: string[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const token = ta[i];
    if (/[A-Za-z]/.test(token)) {
      out[i] = token;
    } else {
      const na = parseFloat(token);
      const nb = parseFloat(tb[i]);
      out[i] = (na + (nb - na) * t).toFixed(2);
    }
  }
  return out.join(" ");
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
