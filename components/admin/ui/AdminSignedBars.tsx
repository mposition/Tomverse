import { adminChartColor, type AdminChartColor } from "@/lib/adminUiCore";

/**
 * Two bar series on one baseline: `up` rises above it, `down` hangs below it.
 *
 * Both share a single scale, so a tall bar above and a short bar below really
 * are in that proportion. Values are magnitudes (never negative). A zero is a
 * hairline, so a day with nothing still reads as "measured, empty". Draws
 * nothing for input it cannot show honestly; the caller then leaves the chart
 * out rather than showing a flat line.
 */
export function AdminSignedBars({
  up,
  down,
  upColor = "emerald",
  downColor = "violet",
  height = 180,
  gap = 3,
  label,
  className = "",
}: {
  up: readonly number[];
  down: readonly number[];
  upColor?: AdminChartColor;
  downColor?: AdminChartColor;
  height?: number;
  gap?: number;
  label: string;
  className?: string;
}) {
  const count = up.length;
  const values = [...up, ...down];
  if (
    count === 0 ||
    down.length !== count ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    return null;
  }
  const barWidth = 10;
  const width = count * barWidth + (count - 1) * gap;
  const half = height / 2;
  const max = Math.max(...values) || 1;
  const barHeight = (value: number) => (value === 0 ? 1 : Math.max(1, (value / max) * (half - 2)));
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`block max-w-full ${className}`}
      style={{ height, width: "100%" }}
    >
      <line x1="0" x2={width} y1={half} y2={half} stroke="var(--color-zinc-700)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {up.map((value, index) => {
        const h = barHeight(value);
        return (
          <rect
            key={`up-${index}`}
            x={index * (barWidth + gap)}
            y={half - h}
            width={barWidth}
            height={h}
            rx={2}
            fill={adminChartColor(upColor)}
          />
        );
      })}
      {down.map((value, index) => (
        <rect
          key={`down-${index}`}
          x={index * (barWidth + gap)}
          y={half}
          width={barWidth}
          height={barHeight(value)}
          rx={2}
          fill={adminChartColor(downColor)}
        />
      ))}
    </svg>
  );
}
