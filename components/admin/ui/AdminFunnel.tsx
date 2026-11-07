import { adminChartColor } from "@/lib/adminUiCore";

/**
 * A funnel: one bar per step, scaled to the first step, with the step-to-step
 * rate between bars. A step whose value is zero keeps a hairline so it reads
 * as "measured, nobody", and a rate with a zero before it is omitted rather
 * than shown as a division by zero.
 */
export function AdminFunnel({
  steps,
  rateLabel,
  barHeight = 160,
  className = "",
}: {
  steps: ReadonlyArray<{ key: string; label: string; value: number; valueLabel: string }>;
  /** Formats a rate (a 0..1 fraction) for the arrow between bars. */
  rateLabel: (rate: number) => string;
  barHeight?: number;
  className?: string;
}) {
  const top = Math.max(1, steps[0]?.value ?? 1);
  return (
    <ol className={`flex min-w-0 items-end gap-1 sm:gap-2 ${className}`}>
      {steps.map((step, index) => {
        const before = index > 0 ? steps[index - 1].value : null;
        const rate = before && before > 0 ? step.value / before : null;
        const height = Math.max(6, (step.value / top) * barHeight);
        return (
          <li key={step.key} className="flex min-w-0 flex-1 flex-col items-center gap-2">
            <span className="h-5 text-xs font-bold text-blue-300" aria-hidden={rate === null}>
              {rate === null ? "" : rateLabel(rate)}
            </span>
            <span
              aria-hidden
              className="block w-full rounded-t-xl"
              style={{
                height,
                backgroundColor: adminChartColor("blue"),
                opacity: 1 - index * 0.14,
              }}
            />
            <span className="text-lg font-bold tabular-nums text-white sm:text-2xl">{step.valueLabel}</span>
            <span className="text-center text-xs text-zinc-400">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
