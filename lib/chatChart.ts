/**
 * Inline charts in a Chat answer: a ```chart fenced block holding a small JSON
 * spec, drawn as SVG once the answer has finished
 * (components/chat/ChatChart.tsx).
 *
 * Pure and free of React so the parsing, the limits and the axis arithmetic
 * are testable without a renderer. A spec that does not validate is `null`,
 * and the caller then shows the ordinary code block.
 *
 * Spec, deliberately small:
 *
 *   { "type": "bar" | "line" | "area" | "pie" | "scatter",
 *     "title": "...", "xLabel": "...", "yLabel": "...",
 *     "labels": ["Q1", "Q2"],                              // not scatter
 *     "series": [{ "name": "Revenue", "values": [10, 12] }] // not scatter
 *     "series": [{ "name": "Group A", "points": [[1, 2]] }] // scatter
 *   }
 */

import { fencedBlockSourceFromPre } from "@/lib/chatMermaidBlock";

export const CHART_TYPES = ["bar", "line", "area", "pie", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const CHART_LIMITS = {
  sourceCharacters: 10_000,
  labels: 40,
  series: 6,
  pointsPerSeries: 200,
  pieSlices: 12,
  titleCharacters: 120,
  labelCharacters: 40,
} as const;

type ChartCommon = { title: string; xLabel: string; yLabel: string };

export type CategoryChartSpec = ChartCommon & {
  type: "bar" | "line" | "area" | "pie";
  labels: string[];
  series: { name: string; values: number[] }[];
};

export type ScatterChartSpec = ChartCommon & {
  type: "scatter";
  series: { name: string; points: [number, number][] }[];
};

export type ChartSpec = CategoryChartSpec | ScatterChartSpec;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const numberList = (value: unknown, max: number): number[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
  const numbers: number[] = [];
  for (const entry of value) {
    const n = finiteNumber(entry);
    if (n === null) return null;
    numbers.push(n);
  }
  return numbers;
};

const pointList = (value: unknown, max: number): [number, number][] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
  const points: [number, number][] = [];
  for (const entry of value) {
    const x = Array.isArray(entry) ? finiteNumber(entry[0]) : isRecord(entry) ? finiteNumber(entry.x) : null;
    const y = Array.isArray(entry) ? finiteNumber(entry[1]) : isRecord(entry) ? finiteNumber(entry.y) : null;
    if (x === null || y === null) return null;
    points.push([x, y]);
  }
  return points;
};

/** The validated spec of a chart block's JSON text, or null when anything is off. */
export function parseChartSpec(source: string): ChartSpec | null {
  if (source.length > CHART_LIMITS.sourceCharacters) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const type = CHART_TYPES.find((candidate) => candidate === raw.type);
  if (!type || !Array.isArray(raw.series) || raw.series.length === 0 || raw.series.length > CHART_LIMITS.series) {
    return null;
  }
  const common: ChartCommon = {
    title: text(raw.title, CHART_LIMITS.titleCharacters),
    xLabel: text(raw.xLabel, CHART_LIMITS.labelCharacters),
    yLabel: text(raw.yLabel, CHART_LIMITS.labelCharacters),
  };
  const entries = raw.series.filter(isRecord);
  if (entries.length !== raw.series.length) return null;

  if (type === "scatter") {
    const series: ScatterChartSpec["series"] = [];
    for (const entry of entries) {
      const points = pointList(entry.points, CHART_LIMITS.pointsPerSeries);
      if (!points) return null;
      series.push({ name: text(entry.name, CHART_LIMITS.labelCharacters), points });
    }
    return { type, ...common, series };
  }

  if (!Array.isArray(raw.labels) || raw.labels.length === 0 || raw.labels.length > CHART_LIMITS.labels) return null;
  const labels = raw.labels.map((label) => (typeof label === "string" || typeof label === "number" ? text(String(label), CHART_LIMITS.labelCharacters) : ""));
  const series: CategoryChartSpec["series"] = [];
  for (const entry of type === "pie" ? entries.slice(0, 1) : entries) {
    const values = numberList(entry.values, CHART_LIMITS.labels);
    if (!values || values.length !== labels.length) return null;
    series.push({ name: text(entry.name, CHART_LIMITS.labelCharacters), values });
  }
  if (type === "pie") {
    const values = series[0].values;
    if (labels.length > CHART_LIMITS.pieSlices || values.some((value) => value < 0) || !(values.reduce((a, b) => a + b, 0) > 0)) {
      return null;
    }
  }
  return { type, ...common, labels, series };
}

/** The spec of a `<pre><code class="language-chart">` block, else null. */
export function chartSpecFromPre(node: Parameters<typeof fencedBlockSourceFromPre>[0]): ChartSpec | null {
  const source = fencedBlockSourceFromPre(node, "chart", CHART_LIMITS.sourceCharacters);
  return source ? parseChartSpec(source) : null;
}

/** A 1/2/5 x 10^n step, so the axis ends on round numbers. */
export function niceScale(min: number, max: number, targetTicks = 5): { min: number; max: number; ticks: number[] } {
  let low = min;
  let high = max;
  if (low === high) {
    const pad = low === 0 ? 1 : Math.abs(low) * 0.1;
    low -= pad;
    high += pad;
  }
  const rough = (high - low) / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  for (let value = start, guard = 0; value <= end + step / 2 && guard < 100; value += step, guard += 1) {
    // Rounds away floating point residue such as 0.30000000000000004.
    ticks.push(Number(value.toPrecision(12)));
  }
  return { min: start, max: end, ticks };
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });
/** An axis label: 12400 -> 12.4K. Locale-free so the server and client agree. */
export const formatChartNumber = (value: number): string => compact.format(value);
