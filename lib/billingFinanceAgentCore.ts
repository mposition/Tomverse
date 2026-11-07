/**
 * Pure derivations for the billing and finance agent's page: its figures from
 * the kept digests, the report calendar, and how its own switch reads in the
 * page head. The agent works out pending-price deadlines
 * (docs/policy/billing-finance-ops.md §1.1); every figure here is read from a
 * digest's own closed payload, so a digest whose body is gone gives no figure
 * rather than a zero.
 */

import type { AdminTone } from "@/lib/adminUiCore";
import { formatAestDate } from "@/lib/adminUiCore";
import type { BillingFinanceOpsConsole, BillingFinanceOpsConsoleRow } from "@/lib/billingFinanceOpsConsoleRead";

export type FinanceCalendarDay = {
  id: string;
  /** "MM-DD" of the digest's own date. */
  label: string;
  tone: AdminTone;
  verdict: "quiet" | "notice" | "register_invalid" | null;
};

export type FinanceFigures = {
  /** The newest digest whose body is readable; null when there is none. */
  latest: BillingFinanceOpsConsoleRow | null;
  waiting: number | null;
  /** Days to the nearest deadline (negative once past), and the model it belongs to. */
  nearest: { days: number; modelId: string } | null;
  /** Items due within 7 days or already past. */
  soon: number | null;
  /** Oldest first. */
  calendar: FinanceCalendarDay[];
};

const SOON_MARKS = new Set(["7", "1", "expired"]);

export function financeFigures(rows: readonly BillingFinanceOpsConsoleRow[]): FinanceFigures {
  const latest = rows.find((row) => row.digest !== null) ?? null;
  const items = latest?.digest?.items ?? null;
  const dated = (items ?? []).filter((item) => item.remainingDays !== null) as Array<{
    modelId: string;
    remainingDays: number;
  }>;
  const nearest = dated.length
    ? dated.reduce((best, item) => (item.remainingDays < best.remainingDays ? item : best))
    : null;
  const calendar = [...rows].reverse().map<FinanceCalendarDay>((row) => {
    const verdict = row.digest?.verdict ?? null;
    return {
      id: row.id,
      label: (row.digest?.computedAtDate ?? formatAestDate(row.createdAt) ?? "").slice(5) || "--",
      tone: verdict === "quiet" ? "ok" : verdict === "notice" ? "warn" : verdict === "register_invalid" ? "bad" : "unknown",
      verdict,
    };
  });
  return {
    latest,
    waiting: items ? items.length : null,
    nearest: nearest ? { days: nearest.remainingDays, modelId: nearest.modelId } : null,
    soon: items
      ? items.filter((item) => (item.remainingDays !== null && item.remainingDays <= 7) || SOON_MARKS.has(item.mark)).length
      : null,
    calendar,
  };
}

export type FinanceHeadStatus = "watching" | "off" | "unknown";

/** How the head names the agent: only a switch that read as on is "watching"; unreadable is never off. */
export function financeHeadStatus(control: BillingFinanceOpsConsole["control"] | null): {
  status: FinanceHeadStatus;
  tone: AdminTone;
  autoRun: "on" | "off" | "unknown";
} {
  if (!control || control.state === "unreadable") return { status: "unknown", tone: "unknown", autoRun: "unknown" };
  return control.state === "enabled"
    ? { status: "watching", tone: "ok", autoRun: "on" }
    : { status: "off", tone: "idle", autoRun: "off" };
}
