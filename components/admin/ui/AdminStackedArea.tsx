import { adminStackedAreaPaths } from "@/lib/adminStackedAreaCore";
import { adminChartColor, type AdminChartColor } from "@/lib/adminUiCore";

export type AdminStackedLayer = {
  key: string;
  label: string;
  color: AdminChartColor;
  /** One value per day, the same length for every layer. */
  values: readonly number[];
};

/**
 * A stacked area for a series per day, with its legend above it. Plain SVG
 * through `var(--color-*)`, like the other console charts; it draws nothing
 * when the data cannot be drawn honestly, and the caller says so in words.
 *
 * `edgeLabels` are the first, middle and last day, written under the chart.
 */
export function AdminStackedArea({
  layers,
  edgeLabels,
  label,
  height = 180,
  className = "",
}: {
  layers: readonly AdminStackedLayer[];
  edgeLabels?: readonly [string, string, string];
  label: string;
  height?: number;
  className?: string;
}) {
  const width = 640;
  const geometry = adminStackedAreaPaths(
    layers.map((layer) => layer.values),
    width,
    height
  );
  if (!geometry) return null;
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400" aria-hidden>
        {layers.map((layer) => (
          <li key={layer.key} className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: adminChartColor(layer.color) }}
            />
            {layer.label}
          </li>
        ))}
      </ul>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
      >
        {geometry.layers.map((layer) => (
          <path
            key={layers[layer.index].key}
            d={layer.path}
            fill={adminChartColor(layers[layer.index].color)}
            fillOpacity="0.85"
          />
        ))}
      </svg>
      {edgeLabels ? (
        <div className="flex justify-between text-xs text-zinc-500" aria-hidden>
          <span>{edgeLabels[0]}</span>
          <span>{edgeLabels[1]}</span>
          <span className="font-bold text-zinc-300">{edgeLabels[2]}</span>
        </div>
      ) : null}
    </div>
  );
}
