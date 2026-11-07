"use client";

import { AlertTriangle } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminSparkline } from "@/components/admin/ui/AdminCharts";
import { adminUiMessages } from "@/lib/adminMessages/ui";
import type { AdminChartColor } from "@/lib/adminUiCore";

/**
 * One number with its label, a one-line detail and, when there is a series,
 * a small line beside it.
 *
 * `value: null` means the number could not be read. It renders "Unavailable"
 * in a dashed card with the retry the caller passes -- never a zero, which
 * would tell the operator that nothing happened.
 *
 * At most four of these on a page.
 */
export function AdminKpiCard({
  label,
  value,
  detail,
  tone = "neutral",
  trend,
  trendColor = "blue",
  onRetry,
  className = "",
}: {
  label: React.ReactNode;
  value: React.ReactNode | null;
  detail?: React.ReactNode;
  tone?: "neutral" | "warn" | "bad";
  trend?: readonly number[];
  trendColor?: AdminChartColor;
  onRetry?: () => void;
  className?: string;
}) {
  const m = useAdminMessages(adminUiMessages);
  const unread = value === null || value === undefined;
  const frame = unread
    ? "border-dashed border-zinc-700 bg-transparent"
    : tone === "warn"
      ? "border-amber-500/40 bg-zinc-900"
      : tone === "bad"
        ? "border-red-500/40 bg-zinc-900"
        : "border-zinc-800 bg-zinc-900";
  return (
    <div
      data-unread={unread ? "true" : undefined}
      className={`flex min-w-0 flex-col gap-1 rounded-2xl border p-5 ${frame} ${className}`}
    >
      <p className="text-sm font-medium text-zinc-400">{label}</p>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p
            className={`truncate font-bold tabular-nums tracking-tight ${
              unread ? "text-xl text-zinc-400" : "text-3xl text-white"
            }`}
          >
            {unread ? m.unavailable : value}
          </p>
          {unread ? (
            <p className="mt-1 flex items-center gap-1 text-xs text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              {m.unreadDetail}
              {onRetry ? (
                <button type="button" onClick={onRetry} className="font-bold underline underline-offset-2">
                  {m.retry}
                </button>
              ) : null}
            </p>
          ) : detail ? (
            <p
              className={`mt-1 text-xs ${
                tone === "warn" ? "text-amber-300" : tone === "bad" ? "text-red-300" : "text-zinc-500"
              }`}
            >
              {detail}
            </p>
          ) : null}
        </div>
        {!unread && trend ? (
          <AdminSparkline values={trend} color={trendColor} label={typeof label === "string" ? label : ""} />
        ) : null}
      </div>
    </div>
  );
}
