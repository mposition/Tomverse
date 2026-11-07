/**
 * Pure helpers behind the Admin console's shared UI primitives
 * (`components/admin/ui/*`): status tones, the Brisbane clock and the geometry
 * of the small inline charts.
 *
 * Kept free of React so the arithmetic can be tested directly. Every chart
 * helper returns `null` for input it cannot draw honestly (no values, a
 * non-finite value): an unreadable series renders nothing, never a flat line
 * that reads as zero.
 */

/** The five meanings a colour may carry in the console, plus "unknown". */
export type AdminTone = "ok" | "warn" | "bad" | "info" | "idle" | "unknown";

/**
 * A palette family for each tone. Panels are written in dark classes only and
 * Light is a remap of the palette (docs/ui-contracts/admin-console-ia.md, "The
 * console theme"), so a tone names a family, never a literal colour.
 */
export const ADMIN_TONE_FAMILY: Record<AdminTone, "emerald" | "amber" | "red" | "blue" | "zinc"> = {
  ok: "emerald",
  warn: "amber",
  bad: "red",
  info: "blue",
  idle: "zinc",
  unknown: "zinc",
};

/** A chart colour: a palette family, drawn through `var(--color-*)` so Light can remap it. */
export type AdminChartColor = "blue" | "emerald" | "amber" | "red" | "violet" | "cyan" | "pink" | "zinc";

export const adminChartColor = (color: AdminChartColor, step: 400 | 500 | 600 = 500) =>
  `var(--color-${color}-${step})`;

const BRISBANE = "Australia/Brisbane";

/**
 * "14:05" in Brisbane time. The operator reads times as AEST (UTC+10, no
 * daylight saving), so the console never shows a bare UTC clock.
 */
export function formatAestClock(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: BRISBANE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

const AEST_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: BRISBANE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function aestParts(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(AEST_PARTS.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    timeWithSeconds: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

/**
 * "2026-11-07 13:42 AEST" for any instant the console shows. Returns null for a
 * value that cannot be read, so the caller keeps its own placeholder text.
 * `{ seconds: true }` gives "2026-11-07 13:42:05 AEST" where the seconds matter.
 */
export function formatAestDateTime(
  value: Date | string | number | null | undefined,
  options: { seconds?: boolean } = {}
): string | null {
  const parts = aestParts(value);
  if (!parts) return null;
  return `${parts.date} ${options.seconds ? parts.timeWithSeconds : parts.time} AEST`;
}

/** "2026-11-07" in Brisbane time, or null for a value that cannot be read. */
export function formatAestDate(value: Date | string | number | null | undefined): string | null {
  return aestParts(value)?.date ?? null;
}

const finite = (values: readonly number[]) =>
  values.length > 0 && values.every((value) => Number.isFinite(value));

const round = (value: number) => Math.round(value * 100) / 100;

export type AdminSparkGeometry = {
  /** The line, as an SVG path. */
  line: string;
  /** The same line closed down to the baseline, for the soft fill under it. */
  area: string;
  /** Where the latest value sits, for its marker. */
  last: { x: number; y: number };
};

/**
 * A smooth line through `values`, scaled into a `width` x `height` box with
 * `pad` pixels of air. A single value draws a flat line across the box.
 */
export function adminSparkGeometry(
  values: readonly number[],
  width: number,
  height: number,
  pad = 4
): AdminSparkGeometry | null {
  if (!finite(values) || width <= pad * 2 || height <= pad * 2) return null;
  const series = values.length === 1 ? [values[0], values[0]] : [...values];
  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min || 1;
  const points = series.map((value, index) => ({
    x: round(pad + (index * (width - pad * 2)) / (series.length - 1)),
    // A flat series sits in the middle rather than on the floor.
    y: round(max === min ? height / 2 : height - pad - ((value - min) / span) * (height - pad * 2)),
  }));
  let line = `M${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const middle = round((previous.x + point.x) / 2);
    line += ` C${middle},${previous.y} ${middle},${point.y} ${point.x},${point.y}`;
  }
  const last = points[points.length - 1];
  const area = `${line} L${last.x},${height} L${points[0].x},${height} Z`;
  return { line, area, last };
}

export type AdminBarRect = { x: number; y: number; width: number; height: number; value: number };

/**
 * Vertical bars for `values` in a `width` x `height` box. A zero is drawn as a
 * hairline so the day still reads as "measured, nothing happened".
 */
export function adminBarRects(
  values: readonly number[],
  width: number,
  height: number,
  gap = 4
): AdminBarRect[] | null {
  if (!finite(values) || values.some((value) => value < 0)) return null;
  const count = values.length;
  const barWidth = (width - gap * (count - 1)) / count;
  if (barWidth <= 0) return null;
  const max = Math.max(...values) || 1;
  return values.map((value, index) => {
    const barHeight = value === 0 ? 2 : Math.max(2, (value / max) * height);
    return {
      x: round(index * (barWidth + gap)),
      y: round(height - barHeight),
      width: round(barWidth),
      height: round(barHeight),
      value,
    };
  });
}

/** A point on a circle; 0 degrees is three o'clock, angles grow clockwise. */
const onCircle = (cx: number, cy: number, r: number, degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  return { x: round(cx + r * Math.cos(radians)), y: round(cy + r * Math.sin(radians)) };
};

/** An SVG arc from `from` to `to` degrees (clockwise) on a circle. */
export function adminArcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const start = onCircle(cx, cy, r, from);
  const end = onCircle(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${start.x},${start.y} A${r},${r} 0 ${large} 1 ${end.x},${end.y}`;
}

export type AdminDonutSegment = { value: number; color: AdminChartColor; label: string };
export type AdminDonutArc = AdminDonutSegment & { path: string; share: number };

/**
 * Arcs for a donut of `size` with a `stroke`-wide ring, starting at twelve
 * o'clock, with a small gap between segments. Zero-valued segments draw no arc
 * but keep their share (0) so a legend can still list them.
 */
export function adminDonutArcs(
  segments: readonly AdminDonutSegment[],
  size: number,
  stroke: number,
  gapDegrees = 3
): AdminDonutArc[] | null {
  if (segments.length === 0 || !finite(segments.map((segment) => segment.value))) return null;
  if (segments.some((segment) => segment.value < 0)) return null;
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;
  const r = (size - stroke) / 2;
  const centre = size / 2;
  const drawn = segments.filter((segment) => segment.value > 0).length;
  const gap = drawn > 1 ? gapDegrees : 0;
  let angle = -90;
  return segments.map((segment) => {
    const sweep = (segment.value / total) * 360;
    const from = angle + gap / 2;
    // A lone full circle cannot be one arc (start equals end); stop just short.
    const to = Math.min(angle + sweep - gap / 2, angle + 359.99);
    angle += sweep;
    return {
      ...segment,
      share: segment.value / total,
      path: segment.value > 0 ? adminArcPath(centre, centre, r, from, to) : "",
    };
  });
}

/**
 * The filled part of a progress ring, `fraction` of a full turn from twelve
 * o'clock. Values outside 0..1 are clamped; a non-finite one draws nothing.
 */
export function adminRingArc(fraction: number, size: number, stroke: number): string | null {
  if (!Number.isFinite(fraction)) return null;
  const clamped = Math.min(1, Math.max(0, fraction));
  if (clamped === 0) return "";
  const r = (size - stroke) / 2;
  const centre = size / 2;
  return adminArcPath(centre, centre, r, -90, -90 + Math.min(clamped * 360, 359.99));
}

/** A half-circle gauge for a 0..100 score: the track and the filled arc. */
export function adminGaugeArcs(score: number, size: number, stroke: number) {
  if (!Number.isFinite(score)) return null;
  const clamped = Math.min(100, Math.max(0, score));
  const r = (size - stroke) / 2;
  const centre = size / 2;
  const end = 180 + (clamped / 100) * 180;
  return {
    track: adminArcPath(centre, centre, r, 180, 360),
    fill: clamped === 0 ? "" : adminArcPath(centre, centre, r, 180, end),
    marker: onCircle(centre, centre, r, end),
  };
}
