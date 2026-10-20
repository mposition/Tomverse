/** A read-only display. This component never changes quotas or balances. */
export function usagePercent(used: number, limit: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(used / limit * 100)));
}

export function UsagePercentGauge({ used, limit, label, compact = false }: {
  used: number; limit: number; label: string; compact?: boolean;
}) {
  const value = usagePercent(used, limit);
  return <span className={`block min-w-0 ${compact ? "mt-1" : "space-y-2"}`} data-testid="usage-percent-gauge">
    <span className="flex items-center justify-between gap-2 text-xs text-zinc-600 dark:text-zinc-300"><span>{label}</span><strong className="tabular-nums">{value === null ? "—" : `${value}%`}</strong></span>
    {value !== null && <progress aria-label={label} max={100} value={value} className="block h-1.5 w-full overflow-hidden rounded-full accent-blue-600 [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-zinc-200 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-blue-600 dark:[&::-webkit-progress-bar]:bg-zinc-800" />}
  </span>;
}
