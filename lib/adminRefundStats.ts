import { formatAestDate } from "@/lib/adminUiCore";

/**
 * Figures the refund screen derives from the requests it has read.
 *
 * Everything here is a count over those rows only (the page reads the newest
 * few), so callers label the result as "requests read" and never as a total.
 * Each helper returns null when it cannot say honestly -- an unreadable clock,
 * a missing credit summary -- so the screen shows "Unavailable" rather than a
 * zero.
 */

export type RefundStatsRow = {
  status: string;
  requestedAt: string;
  reviewedAt: string | null;
  refundAmountCents: number | null;
  refundCurrency: string | null;
};

export type RefundCreditSummary = {
  purchaseCount: number;
  purchasedCredits: number;
  remainingCredits: number;
  estimatedUsedCredits: number;
};

const DAY_MS = 86_400_000;

/** "2026-11" for an instant, read on the Brisbane calendar; null if unreadable. */
export const aestMonthKey = (value: string | Date | null | undefined): string | null =>
  formatAestDate(value)?.slice(0, 7) ?? null;

/** The `count` month keys ending at `currentKey`, oldest first. */
export function monthKeysEndingAt(currentKey: string, count: number): string[] | null {
  const match = /^(\d{4})-(\d{2})$/.exec(currentKey);
  if (!match || count < 1) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const keys: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const index = year * 12 + (month - 1) - back;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return keys;
}

/** Whole days between the request and `nowIso`, never negative; null if unreadable. */
export function waitingDays(requestedAt: string, nowIso: string | null | undefined): number | null {
  if (!nowIso) return null;
  const requested = new Date(requestedAt).getTime();
  const now = new Date(nowIso).getTime();
  if (!Number.isFinite(requested) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - requested) / DAY_MS));
}

export type ApprovedRefundMonths = {
  keys: string[];
  counts: number[];
  thisMonth: {
    count: number;
    /** Minor units per currency, only for approved requests that recorded an amount. */
    amounts: Array<{ currency: string; minor: number }>;
    /** Approved this month, but no amount was recorded (Stripe was not involved). */
    withoutAmount: number;
  };
  /** True when at least one approved request falls inside the window. */
  hasData: boolean;
};

/**
 * Approved requests per month for the last `months` months, by the day each
 * was reviewed (its request day when no review time is stored).
 */
export function approvedRefundMonths(
  rows: readonly RefundStatsRow[],
  nowIso: string | null | undefined,
  months = 6
): ApprovedRefundMonths | null {
  const currentKey = nowIso ? aestMonthKey(nowIso) : null;
  const keys = currentKey ? monthKeysEndingAt(currentKey, months) : null;
  if (!currentKey || !keys) return null;
  const counts = keys.map(() => 0);
  const amounts = new Map<string, number>();
  let thisMonthCount = 0;
  let withoutAmount = 0;
  let hasData = false;
  for (const row of rows) {
    if (row.status !== "approved") continue;
    const key = aestMonthKey(row.reviewedAt ?? row.requestedAt);
    const slot = key ? keys.indexOf(key) : -1;
    if (slot < 0) continue;
    hasData = true;
    counts[slot] += 1;
    if (key !== currentKey) continue;
    thisMonthCount += 1;
    if (typeof row.refundAmountCents === "number") {
      const currency = row.refundCurrency || "USD";
      amounts.set(currency, (amounts.get(currency) ?? 0) + row.refundAmountCents);
    } else {
      withoutAmount += 1;
    }
  }
  return {
    keys,
    counts,
    thisMonth: {
      count: thisMonthCount,
      amounts: [...amounts].map(([currency, minor]) => ({ currency, minor })),
      withoutAmount,
    },
    hasData,
  };
}

export type CreditUseShare =
  | { kind: "share"; percent: number; used: number; purchased: number }
  | { kind: "none" };

/**
 * How much of the credit-pack credits the customer bought has been used.
 * `none` means they bought no pack; null means the summary was not read.
 */
export function creditUseShare(summary: RefundCreditSummary | undefined | null): CreditUseShare | null {
  if (!summary) return null;
  if (summary.purchaseCount === 0 && summary.purchasedCredits === 0) return { kind: "none" };
  if (!(summary.purchasedCredits > 0)) return null;
  const used = Math.max(0, summary.estimatedUsedCredits);
  const percent = Math.min(100, Math.round((used / summary.purchasedCredits) * 100));
  return { kind: "share", percent, used, purchased: summary.purchasedCredits };
}
