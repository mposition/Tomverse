/**
 * Geometry for the console's two-line trend chart: the current series and,
 * when there is one, the period before it as a dashed line on the same scale.
 *
 * Pure and React-free like `lib/adminUiCore.ts`. Returns `null` for input it
 * cannot draw honestly (nothing to draw, or a value that is not a number), so
 * a chart over an unreadable series renders nothing rather than a flat line.
 */

export type AdminLineChartGeometry = {
  line: string;
  area: string;
  previousLine: string | null;
  /** The marker on the latest value. */
  last: { x: number; y: number };
  /** Every point of the current series, for hover markers. */
  points: Array<{ x: number; y: number; value: number }>;
  /** Y of the horizontal guide lines, top to bottom. */
  guides: number[];
};

const round = (value: number) => Math.round(value * 100) / 100;
const finite = (values: readonly number[]) => values.length > 0 && values.every(Number.isFinite);

const smooth = (points: ReadonlyArray<{ x: number; y: number }>) => {
  let path = `M${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const middle = round((previous.x + point.x) / 2);
    path += ` C${middle},${previous.y} ${middle},${point.y} ${point.x},${point.y}`;
  }
  return path;
};

export function adminLineChartGeometry(
  current: readonly number[],
  previous: readonly number[] | null,
  width: number,
  height: number,
  pad = 8
): AdminLineChartGeometry | null {
  if (!finite(current) || current.length < 2) return null;
  if (previous && (!finite(previous) || previous.length !== current.length)) return null;
  if (width <= pad * 2 || height <= pad * 2) return null;

  // One scale for both lines: a dashed line on its own scale would say the
  // two periods were alike whatever the numbers were.
  const all = previous ? [...current, ...previous] : [...current];
  const max = Math.max(...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const x = (index: number) => round(pad + (index * (width - pad * 2)) / (current.length - 1));
  const y = (value: number) => round(height - pad - ((value - min) / span) * (height - pad * 2));

  const points = current.map((value, index) => ({ x: x(index), y: y(value), value }));
  const line = smooth(points);
  const last = points[points.length - 1];
  return {
    line,
    area: `${line} L${last.x},${height} L${points[0].x},${height} Z`,
    previousLine: previous ? smooth(previous.map((value, index) => ({ x: x(index), y: y(value) }))) : null,
    last: { x: last.x, y: last.y },
    points,
    guides: [0.25, 0.5, 0.75].map((fraction) => round(pad + fraction * (height - pad * 2))),
  };
}

/**
 * The window of a 30-day daily series a period chart shows, and the window
 * before it when the series is long enough to hold both.
 */
export function trendWindows(
  series: readonly number[],
  days: number
): { current: number[]; previous: number[] | null } {
  const count = Math.max(2, Math.min(days, series.length));
  const current = series.slice(series.length - count);
  const before = series.slice(Math.max(0, series.length - count * 2), series.length - count);
  return { current, previous: before.length === count ? before : null };
}
