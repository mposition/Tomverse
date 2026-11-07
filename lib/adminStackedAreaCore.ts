/**
 * Geometry for a stacked area chart, kept free of React so it can be tested
 * directly. Like the other console chart helpers it returns `null` for input it
 * cannot draw honestly (no days, a non-finite or negative value, or nothing but
 * zeros), so an unreadable series renders nothing instead of a flat line.
 */

export type AdminStackedLayerPath = {
  /** The closed outline of this layer, as an SVG path. */
  path: string;
  /** Index into the input series, bottom layer first. */
  index: number;
};

export type AdminStackedArea = {
  layers: AdminStackedLayerPath[];
  /** The largest stacked total, which the top of the box stands for. */
  max: number;
};

const round = (value: number) => Math.round(value * 100) / 100;

type Point = { x: number; y: number };

const curve = (points: readonly Point[]) => {
  let out = "";
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const middle = round((previous.x + point.x) / 2);
    out += ` C${middle},${previous.y} ${middle},${point.y} ${point.x},${point.y}`;
  }
  return out;
};

/**
 * `series[i][d]` is layer i on day d. Every layer must have the same length.
 * Layers stack upward in input order, so the first series sits on the floor.
 */
export function adminStackedAreaPaths(
  series: readonly (readonly number[])[],
  width: number,
  height: number,
  pad = 4
): AdminStackedArea | null {
  if (series.length === 0 || width <= pad * 2 || height <= pad * 2) return null;
  const days = series[0].length;
  if (days === 0) return null;
  for (const layer of series) {
    if (layer.length !== days) return null;
    if (!layer.every((value) => Number.isFinite(value) && value >= 0)) return null;
  }
  // One day is drawn as two equal columns so a single value still has width.
  const columns = days === 1 ? 2 : days;
  const at = (layer: readonly number[], day: number) => layer[days === 1 ? 0 : day];
  const cumulative: number[][] = [];
  const floor = new Array<number>(columns).fill(0);
  let running = floor;
  for (const layer of series) {
    running = running.map((value, day) => value + at(layer, day));
    cumulative.push(running);
  }
  const max = Math.max(...running);
  if (max <= 0) return null;
  const x = (day: number) => round(pad + (day * (width - pad * 2)) / (columns - 1));
  const y = (value: number) => round(height - pad - (value / max) * (height - pad * 2));
  const boundary = (values: readonly number[]) => values.map((value, day) => ({ x: x(day), y: y(value) }));

  const layers = cumulative.map((upperValues, index) => {
    const upper = boundary(upperValues);
    const lower = boundary(index === 0 ? floor : cumulative[index - 1]).reverse();
    const path = `M${upper[0].x},${upper[0].y}${curve(upper)} L${lower[0].x},${lower[0].y}${curve(lower)} Z`;
    return { path, index };
  });
  return { layers, max };
}
