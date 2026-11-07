import { adminLineChartGeometry } from "@/lib/adminLineChartCore";
import { adminChartColor, type AdminChartColor } from "@/lib/adminUiCore";

/**
 * A line with a soft fill, and the period before it as a dashed line on the
 * same scale. Drawn as plain SVG through `var(--color-*)` like the other
 * console charts; renders nothing when the series cannot be drawn honestly.
 *
 * `labels` are the x-axis captions (first, middle..., last); they sit under
 * the chart as text so they stay crisp at any width.
 */
export function AdminLineChart({
  values,
  previous = null,
  labels = [],
  color = "blue",
  label,
  height = 200,
  className = "",
}: {
  values: readonly number[];
  previous?: readonly number[] | null;
  labels?: readonly string[];
  color?: AdminChartColor;
  /** Accessible name of the chart. */
  label: string;
  height?: number;
  className?: string;
}) {
  const width = 640;
  const geometry = adminLineChartGeometry(values, previous, width, height);
  if (!geometry) return null;
  const stroke = adminChartColor(color);
  const fillId = `admin-line-${color}`;
  return (
    <div className={`min-w-0 ${className}`}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block w-full overflow-visible"
        style={{ height }}
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="1" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {geometry.guides.map((y) => (
          <line key={y} x1="0" x2={width} y1={y} y2={y} stroke="var(--color-zinc-800)" strokeWidth="1" />
        ))}
        <path d={geometry.area} fill={`url(#${fillId})`} />
        {geometry.previousLine ? (
          <path
            d={geometry.previousLine}
            fill="none"
            stroke="var(--color-zinc-500)"
            strokeWidth="2"
            strokeDasharray="5 5"
            strokeLinecap="round"
          />
        ) : null}
        <path d={geometry.line} fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" />
        <circle cx={geometry.last.x} cy={geometry.last.y} r="5" fill={stroke} />
      </svg>
      {labels.length > 0 ? (
        <div className="mt-2 flex justify-between text-xs text-zinc-500" aria-hidden>
          {labels.map((text, index) => (
            <span key={`${text}-${index}`} className={index === labels.length - 1 ? "font-bold text-zinc-200" : ""}>
              {text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
