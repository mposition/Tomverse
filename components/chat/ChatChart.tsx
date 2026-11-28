"use client";

import { useContext, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { AnswerRenderContext } from "@/components/chat/MermaidDiagram";
import { formatChartNumber, niceScale, type CategoryChartSpec, type ChartSpec, type ScatterChartSpec } from "@/lib/chatChart";
import { chatAnswerSurfaceCopy, type ChatAnswerSurfaceCopy } from "@/locales/chatAnswerSurface";

/*
 * Drawn by hand as SVG rather than with a chart library: five chart kinds with
 * no interaction beyond native tooltips come to a few hundred lines, and a
 * library would add a lazy-loaded bundle of its own on every Chat page. The
 * same data is always available as a table below the figure.
 */

const WIDTH = 600;
const HEIGHT = 320;
const MAX_X_LABELS = 8;

/** Series colours. Neutral data hues, not the product's role accents (UI-012). */
const PALETTE = [
  { fill: "fill-blue-600 dark:fill-blue-400", stroke: "stroke-blue-600 dark:stroke-blue-400", swatch: "bg-blue-600 dark:bg-blue-400" },
  { fill: "fill-orange-500 dark:fill-orange-400", stroke: "stroke-orange-500 dark:stroke-orange-400", swatch: "bg-orange-500 dark:bg-orange-400" },
  { fill: "fill-rose-600 dark:fill-rose-400", stroke: "stroke-rose-600 dark:stroke-rose-400", swatch: "bg-rose-600 dark:bg-rose-400" },
  { fill: "fill-lime-600 dark:fill-lime-400", stroke: "stroke-lime-600 dark:stroke-lime-400", swatch: "bg-lime-600 dark:bg-lime-400" },
  { fill: "fill-yellow-500 dark:fill-yellow-400", stroke: "stroke-yellow-500 dark:stroke-yellow-400", swatch: "bg-yellow-500 dark:bg-yellow-400" },
  { fill: "fill-indigo-500 dark:fill-indigo-300", stroke: "stroke-indigo-500 dark:stroke-indigo-300", swatch: "bg-indigo-500 dark:bg-indigo-300" },
] as const;
/** Lines also differ by dash pattern, so colour is never the only cue. */
const DASHES = [undefined, "7 4", "2 4", "10 4 2 4", "1 3", "14 5"] as const;

const AXIS_TEXT = "fill-zinc-500 dark:fill-zinc-400";
const GRID = "stroke-zinc-200 dark:stroke-zinc-700";
const AXIS = "stroke-zinc-400 dark:stroke-zinc-500";

const r2 = (value: number) => Number(value.toFixed(2));
const shorten = (label: string, max = 10) => (label.length > max ? `${label.slice(0, max - 1)}…` : label);

type Scale = ReturnType<typeof niceScale>;
const seriesName = (copy: ChatAnswerSurfaceCopy, name: string, index: number) => name || `${copy.chartSeries} ${index + 1}`;

function Legend({ items }: { items: { label: string; swatch: string; note?: string }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${item.swatch}`} />
          <span>{item.label}</span>
          {item.note ? <span className="text-zinc-400 dark:text-zinc-500">{item.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function CartesianFrame({
  spec,
  xScale,
  yScale,
  children,
}: {
  spec: ChartSpec;
  xScale?: Scale;
  yScale: Scale;
  children: (plot: { x: number; y: number; w: number; h: number }, yPos: (value: number) => number, xPos: (value: number) => number) => ReactNode;
}) {
  const left = spec.yLabel ? 64 : 48;
  const bottom = 30 + (spec.xLabel ? 18 : 0);
  const plot = { x: left, y: 10, w: WIDTH - left - 12, h: HEIGHT - 10 - bottom };
  const yPos = (value: number) => r2(plot.y + plot.h - ((value - yScale.min) / (yScale.max - yScale.min)) * plot.h);
  const xPos = (value: number) => (xScale ? r2(plot.x + ((value - xScale.min) / (xScale.max - xScale.min)) * plot.w) : 0);
  return (
    <>
      {yScale.ticks.map((tick) => (
        <g key={`y${tick}`}>
          <line x1={plot.x} x2={plot.x + plot.w} y1={yPos(tick)} y2={yPos(tick)} className={GRID} strokeWidth={1} />
          <text x={plot.x - 6} y={yPos(tick) + 4} textAnchor="end" fontSize={13} className={AXIS_TEXT}>
            {formatChartNumber(tick)}
          </text>
        </g>
      ))}
      <line x1={plot.x} x2={plot.x + plot.w} y1={plot.y + plot.h} y2={plot.y + plot.h} className={AXIS} strokeWidth={1} />
      {xScale
        ? xScale.ticks.map((tick) => (
            <text key={`x${tick}`} x={xPos(tick)} y={plot.y + plot.h + 18} textAnchor="middle" fontSize={13} className={AXIS_TEXT}>
              {formatChartNumber(tick)}
            </text>
          ))
        : null}
      {spec.xLabel ? (
        <text x={plot.x + plot.w / 2} y={HEIGHT - 4} textAnchor="middle" fontSize={13} className={AXIS_TEXT}>
          {spec.xLabel}
        </text>
      ) : null}
      {spec.yLabel ? (
        <text transform={`translate(14 ${plot.y + plot.h / 2}) rotate(-90)`} textAnchor="middle" fontSize={13} className={AXIS_TEXT}>
          {spec.yLabel}
        </text>
      ) : null}
      {children(plot, yPos, xPos)}
    </>
  );
}

function CategoryChart({ spec, copy }: { spec: CategoryChartSpec; copy: ChatAnswerSurfaceCopy }) {
  const all = spec.series.flatMap((entry) => entry.values);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const yScale = spec.type === "line" ? niceScale(min, max) : niceScale(Math.min(0, min), Math.max(0, max));
  const count = spec.labels.length;
  const labelStep = Math.ceil(count / MAX_X_LABELS);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full min-w-[440px]" aria-hidden="true">
      <CartesianFrame spec={spec} yScale={yScale}>
        {(plot, yPos) => {
          const band = plot.w / count;
          const center = (index: number) => r2(plot.x + band * index + band / 2);
          const baseline = yPos(Math.min(Math.max(0, yScale.min), yScale.max));
          return (
            <>
              {spec.labels.map((label, index) =>
                index % labelStep === 0 ? (
                  <text key={`l${index}`} x={center(index)} y={plot.y + plot.h + 18} textAnchor="middle" fontSize={13} className={AXIS_TEXT}>
                    {shorten(label)}
                  </text>
                ) : null
              )}
              {spec.type === "bar"
                ? spec.series.map((entry, s) => {
                    const group = band * 0.8;
                    const barWidth = group / spec.series.length;
                    return entry.values.map((value, index) => {
                      const top = yPos(value);
                      return (
                        <rect
                          key={`${s}-${index}`}
                          x={r2(plot.x + band * index + band * 0.1 + barWidth * s)}
                          y={Math.min(top, baseline)}
                          width={r2(Math.max(1, barWidth - 2))}
                          height={r2(Math.max(0.5, Math.abs(baseline - top)))}
                          rx={2}
                          className={PALETTE[s].fill}
                        >
                          <title>{`${spec.labels[index]} · ${seriesName(copy, entry.name, s)}: ${value}`}</title>
                        </rect>
                      );
                    });
                  })
                : spec.series.map((entry, s) => {
                    const line = entry.values.map((value, index) => `${index === 0 ? "M" : "L"}${center(index)} ${yPos(value)}`).join(" ");
                    return (
                      <g key={s}>
                        {spec.type === "area" ? (
                          <path d={`${line} L${center(count - 1)} ${baseline} L${center(0)} ${baseline} Z`} className={PALETTE[s].fill} fillOpacity={0.2} stroke="none" />
                        ) : null}
                        <path d={line} fill="none" strokeWidth={2} strokeDasharray={DASHES[s]} strokeLinejoin="round" className={PALETTE[s].stroke} />
                        {count <= 30
                          ? entry.values.map((value, index) => (
                              <circle key={index} cx={center(index)} cy={yPos(value)} r={3} className={PALETTE[s].fill}>
                                <title>{`${spec.labels[index]} · ${seriesName(copy, entry.name, s)}: ${value}`}</title>
                              </circle>
                            ))
                          : null}
                      </g>
                    );
                  })}
            </>
          );
        }}
      </CartesianFrame>
    </svg>
  );
}

function ScatterChart({ spec, copy }: { spec: ScatterChartSpec; copy: ChatAnswerSurfaceCopy }) {
  const points = spec.series.flatMap((entry) => entry.points);
  const xScale = niceScale(Math.min(...points.map((p) => p[0])), Math.max(...points.map((p) => p[0])));
  const yScale = niceScale(Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[1])));
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full min-w-[440px]" aria-hidden="true">
      <CartesianFrame spec={spec} xScale={xScale} yScale={yScale}>
        {(_plot, yPos, xPos) =>
          spec.series.map((entry, s) =>
            entry.points.map(([x, y], index) => (
              <circle key={`${s}-${index}`} cx={xPos(x)} cy={yPos(y)} r={4} fillOpacity={0.75} className={PALETTE[s].fill}>
                <title>{`${seriesName(copy, entry.name, s)}: ${x}, ${y}`}</title>
              </circle>
            ))
          )
        }
      </CartesianFrame>
    </svg>
  );
}

function PieChart({ spec }: { spec: CategoryChartSpec }) {
  const values = spec.series[0].values;
  const total = values.reduce((sum, value) => sum + value, 0);
  const size = 240;
  const radius = size / 2 - 4;
  const point = (angle: number) => `${r2(size / 2 + radius * Math.sin(angle))} ${r2(size / 2 - radius * Math.cos(angle))}`;
  const nonZero = values.filter((value) => value > 0).length;
  const slices = values.map((value, index) => {
    const before = values.slice(0, index).reduce((sum, entry) => sum + entry, 0);
    const start = (before / total) * Math.PI * 2;
    const sweep = (value / total) * Math.PI * 2;
    return { value, index, start, end: start + sweep, sweep };
  });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-auto w-full max-w-[240px] shrink-0" aria-hidden="true">
      {slices
        .filter((slice) => slice.value > 0)
        .map((slice) => {
          const color = `${PALETTE[slice.index % PALETTE.length].fill} stroke-white dark:stroke-zinc-900`;
          const title = <title>{`${spec.labels[slice.index]}: ${slice.value} (${Math.round((slice.value / total) * 100)}%)`}</title>;
          return nonZero === 1 ? (
            <circle key={slice.index} cx={size / 2} cy={size / 2} r={radius} className={color}>
              {title}
            </circle>
          ) : (
            <path
              key={slice.index}
              d={`M${size / 2} ${size / 2} L${point(slice.start)} A${radius} ${radius} 0 ${slice.sweep > Math.PI ? 1 : 0} 1 ${point(slice.end)} Z`}
              strokeWidth={2}
              className={color}
            >
              {title}
            </path>
          );
        })}
    </svg>
  );
}

function DataTable({ spec, copy }: { spec: ChartSpec; copy: ChatAnswerSurfaceCopy }) {
  const cell = "border border-zinc-300 px-2 py-1 text-left align-top dark:border-zinc-600";
  let head: string[];
  let rows: (string | number)[][];
  if (spec.type === "scatter") {
    head = [copy.chartSeries, spec.xLabel || "X", spec.yLabel || "Y"];
    rows = spec.series.flatMap((entry, s) => entry.points.map(([x, y]) => [seriesName(copy, entry.name, s), x, y]));
  } else if (spec.type === "pie") {
    const total = spec.series[0].values.reduce((sum, value) => sum + value, 0);
    head = [spec.xLabel || copy.chartCategory, spec.yLabel || copy.chartValue, copy.chartShare];
    rows = spec.labels.map((label, index) => [label, spec.series[0].values[index], `${Math.round((spec.series[0].values[index] / total) * 1000) / 10}%`]);
  } else {
    head = [spec.xLabel || copy.chartCategory, ...spec.series.map((entry, s) => seriesName(copy, entry.name, s))];
    rows = spec.labels.map((label, index) => [label, ...spec.series.map((entry) => entry.values[index])]);
  }
  return (
    <details className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">
      <summary className="cursor-pointer select-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
        {copy.chartShowData}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="min-w-full border-collapse" data-testid="chat-chart-data">
          <thead>
            <tr>
              {head.map((title, index) => (
                <th key={index} scope="col" className={`${cell} font-semibold`}>
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((value, column) => (
                  <td key={column} className={cell}>
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** A validated chart spec drawn as a figure with its data table. */
export function ChartFigure({ spec, copy }: { spec: ChartSpec; copy: ChatAnswerSurfaceCopy }) {
  const typeName = { bar: copy.chartBar, line: copy.chartLine, area: copy.chartArea, pie: copy.chartPie, scatter: copy.chartScatter }[spec.type];
  const legend =
    spec.type === "pie"
      ? spec.labels.map((label, index) => ({
          label,
          swatch: PALETTE[index % PALETTE.length].swatch,
          note: `${Math.round((spec.series[0].values[index] / spec.series[0].values.reduce((a, b) => a + b, 0)) * 1000) / 10}%`,
        }))
      : spec.series.length > 1 || spec.series[0].name
        ? spec.series.map((entry, s) => ({ label: seriesName(copy, entry.name, s), swatch: PALETTE[s].swatch }))
        : [];
  return (
    <figure
      data-testid="chat-chart"
      data-chart-type={spec.type}
      className="mb-3 rounded-lg border border-zinc-200 bg-white p-3 last:mb-0 dark:border-zinc-700 dark:bg-zinc-900"
    >
      <figcaption className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
        {spec.title || typeName}
      </figcaption>
      <div className={spec.type === "pie" ? "flex flex-wrap items-center gap-4" : ""}>
        {/* The drawing is one image to a screen reader; the data table below is the readable form. */}
        <div role="img" aria-label={spec.title ? `${typeName}: ${spec.title}` : typeName} className={spec.type === "pie" ? "" : "overflow-x-auto"}>
          {spec.type === "scatter" ? (
            <ScatterChart spec={spec} copy={copy} />
          ) : spec.type === "pie" ? (
            <PieChart spec={spec} />
          ) : (
            <CategoryChart spec={spec} copy={copy} />
          )}
        </div>
        {spec.type === "pie" ? <Legend items={legend} /> : null}
      </div>
      {spec.type !== "pie" && legend.length > 0 ? <Legend items={legend} /> : null}
      <DataTable spec={spec} copy={copy} />
    </figure>
  );
}

/**
 * A ```chart block drawn as a chart once the answer is final. While the answer
 * streams, and for any spec that did not validate, `fallback` (the ordinary
 * code block) is what the reader sees.
 */
export function ChatChart({ spec, fallback }: { spec: ChartSpec; fallback: ReactNode }) {
  const streaming = useContext(AnswerRenderContext)?.streaming ?? false;
  const { lang } = useLanguage();
  if (streaming) return <>{fallback}</>;
  return <ChartFigure spec={spec} copy={chatAnswerSurfaceCopy[lang]} />;
}
