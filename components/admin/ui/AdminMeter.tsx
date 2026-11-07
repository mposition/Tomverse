/**
 * A thin horizontal bar for "how much of a limit is used". It draws nothing
 * for a fraction it cannot read, so a missing limit is never shown as empty.
 */
export function AdminMeter({
  fraction,
  label,
  className = "",
}: {
  fraction: number | null;
  label: string;
  className?: string;
}) {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  const clamped = Math.min(1, Math.max(0, fraction));
  const percent = Math.round(clamped * 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={`h-1.5 w-full overflow-hidden rounded-full bg-zinc-800 ${className}`}
    >
      <div
        className={`h-full rounded-full ${clamped >= 0.8 ? "bg-amber-500" : "bg-blue-500"}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
