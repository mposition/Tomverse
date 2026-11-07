"use client";

import { useId } from "react";
import {
  adminBarRects,
  adminChartColor,
  adminDonutArcs,
  adminGaugeArcs,
  adminRingArc,
  adminSparkGeometry,
  type AdminChartColor,
  type AdminDonutSegment,
} from "@/lib/adminUiCore";

/**
 * Small inline charts for the console, drawn as plain SVG.
 *
 * No chart library: these are a handful of shapes, and every colour goes
 * through `var(--color-*)` so the Light theme's palette remap reaches them.
 * Each chart renders nothing when its data cannot be drawn honestly; the
 * caller shows the value as unavailable instead.
 */

type Base = { label: string; className?: string };


/** A smoothed line with a soft fill and a marker on the latest value. */
export function AdminSparkline({
  values,
  width = 120,
  height = 36,
  color = "blue",
  label,
  className = "",
}: Base & { values: readonly number[]; width?: number; height?: number; color?: AdminChartColor }) {
  // useId, not a counter: the id must be the same in the server and client render.
  const id = `admin-spark-${useId().replace(/:/g, "")}`;
  const geometry = adminSparkGeometry(values, width, height);
  if (!geometry) return null;
  const stroke = adminChartColor(color);
  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`block shrink-0 overflow-visible ${className}`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.25" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={geometry.area} fill={`url(#${id})`} />
      <path d={geometry.line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx={geometry.last.x} cy={geometry.last.y} r="4" fill={stroke} />
    </svg>
  );
}

/** Vertical bars; `highlight` (an index) is full strength, the rest are soft. */
export function AdminBars({
  values,
  width = 300,
  height = 80,
  gap = 4,
  color = "blue",
  highlight,
  label,
  className = "",
}: Base & {
  values: readonly number[];
  width?: number;
  height?: number;
  gap?: number;
  color?: AdminChartColor;
  highlight?: number;
}) {
  const rects = adminBarRects(values, width, height, gap);
  if (!rects) return null;
  const fill = adminChartColor(color);
  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`block max-w-full ${className}`}
      preserveAspectRatio="none"
    >
      {rects.map((rect, index) => (
        <rect
          key={index}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={Math.min(4, rect.width / 2)}
          fill={fill}
          opacity={highlight === undefined || highlight === index ? 1 : 0.35}
        />
      ))}
    </svg>
  );
}

/** A donut with a gap between segments; the centre is the caller's (`children`). */
export function AdminDonut({
  segments,
  size = 128,
  stroke = 16,
  label,
  children,
  className = "",
}: Base & {
  segments: readonly AdminDonutSegment[];
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const arcs = adminDonutArcs(segments, size, stroke);
  if (!arcs) return null;
  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {arcs.map((arc) =>
          arc.path ? (
            <path
              key={arc.label}
              d={arc.path}
              fill="none"
              stroke={adminChartColor(arc.color)}
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          ) : null
        )}
      </svg>
      {children ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
      ) : null}
    </div>
  );
}

/** A progress ring for a 0..1 fraction; the centre is the caller's (`children`). */
export function AdminRing({
  fraction,
  size = 64,
  stroke = 8,
  color = "emerald",
  label,
  children,
  className = "",
}: Base & {
  fraction: number;
  size?: number;
  stroke?: number;
  color?: AdminChartColor;
  children?: React.ReactNode;
}) {
  const arc = adminRingArc(fraction, size, stroke);
  if (arc === null) return null;
  const r = (size - stroke) / 2;
  return (
    <div className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
      <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-zinc-800)" strokeWidth={stroke} />
        {arc ? (
          <path d={arc} fill="none" stroke={adminChartColor(color)} strokeWidth={stroke} strokeLinecap="round" />
        ) : null}
      </svg>
      {children ? (
        <div className="absolute inset-0 flex items-center justify-center text-center">{children}</div>
      ) : null}
    </div>
  );
}

/** A half-circle gauge for a 0..100 score, amber to green. */
export function AdminGauge({
  score,
  size = 240,
  stroke = 20,
  label,
  children,
  className = "",
}: Base & { score: number; size?: number; stroke?: number; children?: React.ReactNode }) {
  const id = `admin-gauge-${useId().replace(/:/g, "")}`;
  const arcs = adminGaugeArcs(score, size, stroke);
  if (!arcs) return null;
  const height = size / 2 + stroke;
  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height }}>
      <svg role="img" aria-label={label} width={size} height={height} viewBox={`0 0 ${size} ${height}`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={adminChartColor("amber")} />
            <stop offset="1" stopColor={adminChartColor("emerald")} />
          </linearGradient>
        </defs>
        <path d={arcs.track} fill="none" stroke="var(--color-zinc-800)" strokeWidth={stroke} strokeLinecap="round" />
        {arcs.fill ? (
          <path d={arcs.fill} fill="none" stroke={`url(#${id})`} strokeWidth={stroke} strokeLinecap="round" />
        ) : null}
      </svg>
      {children ? (
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center text-center">{children}</div>
      ) : null}
    </div>
  );
}

