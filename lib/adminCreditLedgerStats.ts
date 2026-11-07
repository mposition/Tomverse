import { formatAestDate, type AdminTone } from "@/lib/adminUiCore";

/**
 * What the credit ledger screen works out from the entries it has read.
 *
 * The page reads only the newest entries, so every figure here is a sum over
 * those rows and the screen says so; none of it is a period total. Entry types
 * are the strings the credit code writes (`lib/creditLedger.ts`,
 * `lib/creditPurchase.ts`); an unknown type is kept as it is, never dropped.
 */

export type AdminCreditLedgerRow = {
  id: string;
  userId: string;
  userEmail: string | null;
  type: string;
  creditsDelta: number;
  balanceAfterCredits: number;
  fundedCostMicroUsdDelta: number;
  reservationId: string | null;
  createdAt: string;
};

type DeltaRow = Pick<AdminCreditLedgerRow, "type" | "creditsDelta">;

/** The order filter chips take; types not listed follow alphabetically. */
export const LEDGER_TYPE_ORDER = [
  "settle",
  "reserve",
  "refund",
  "purchase",
  "payment_refund",
  "chargeback",
  "admin_adjustment",
  "expire",
  "debt_offset",
  "dispute_reinstatement",
] as const;

const TYPE_TONE: Record<string, AdminTone> = {
  settle: "info",
  reserve: "idle",
  refund: "idle",
  purchase: "ok",
  payment_refund: "bad",
  chargeback: "bad",
  admin_adjustment: "info",
  expire: "warn",
  debt_offset: "warn",
  dispute_reinstatement: "ok",
};

export const ledgerTypeTone = (type: string): AdminTone => TYPE_TONE[type] ?? "idle";

/** Credits handed back from a reservation: they offset use, they are not new grants. */
const RETURN_TYPES = new Set(["refund"]);
/** Credits taken away because money was refunded or disputed, or to offset a debt. */
const CLAWBACK_TYPES = new Set(["payment_refund", "chargeback", "debt_offset"]);

type Bucket = "granted" | "used" | "returned" | "expired" | "other";

/** Which card a movement belongs to. A zero movement belongs to none. */
export function ledgerBucket(row: DeltaRow): Bucket {
  const { type, creditsDelta } = row;
  if (creditsDelta === 0) return "other";
  if (RETURN_TYPES.has(type)) return creditsDelta > 0 ? "returned" : "other";
  if (type === "expire") return creditsDelta < 0 ? "expired" : "other";
  if (CLAWBACK_TYPES.has(type)) return "other";
  if (type === "admin_adjustment") return creditsDelta > 0 ? "granted" : "other";
  return creditsDelta > 0 ? "granted" : "used";
}

export type LedgerTotals = {
  granted: number;
  /** Net of credits handed back from reservations. Never negative. */
  used: number;
  expired: number;
  /** Largest grant sources first. */
  grantedByType: Array<{ type: string; credits: number }>;
};

export function ledgerTotals(rows: readonly DeltaRow[]): LedgerTotals {
  let granted = 0;
  let usedGross = 0;
  let returned = 0;
  let expired = 0;
  const byType = new Map<string, number>();
  for (const row of rows) {
    const bucket = ledgerBucket(row);
    if (bucket === "granted") {
      granted += row.creditsDelta;
      byType.set(row.type, (byType.get(row.type) ?? 0) + row.creditsDelta);
    } else if (bucket === "used") usedGross += -row.creditsDelta;
    else if (bucket === "returned") returned += row.creditsDelta;
    else if (bucket === "expired") expired += -row.creditsDelta;
  }
  return {
    granted,
    used: Math.max(0, usedGross - returned),
    expired,
    grantedByType: [...byType]
      .map(([type, credits]) => ({ type, credits }))
      .sort((a, b) => b.credits - a.credits),
  };
}

/** The types present in `rows`, each with its entry count, in chip order. */
export function ledgerTypesPresent(rows: readonly { type: string }[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  const rank = (type: string) => {
    const index = (LEDGER_TYPE_ORDER as readonly string[]).indexOf(type);
    return index === -1 ? LEDGER_TYPE_ORDER.length : index;
  };
  return [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type));
}

export type LedgerDailyFlow = {
  /** "2026-11-07", oldest first, on the Brisbane calendar. */
  days: string[];
  granted: number[];
  used: number[];
};

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Credits granted and used for each day the rows span, empty days included
 * (inside the span the rows are the newest ones in time order, so a day with
 * no row really had no entry). At most the latest `maxDays` days; null when
 * the rows cover fewer than two days, where there is no flow to draw.
 */
export function ledgerDailyFlow(
  rows: readonly Pick<AdminCreditLedgerRow, "type" | "creditsDelta" | "createdAt">[],
  maxDays = 30
): LedgerDailyFlow | null {
  const perDay = new Map<string, { granted: number; usedGross: number; returned: number }>();
  for (const row of rows) {
    const day = formatAestDate(row.createdAt);
    if (!day) return null;
    const entry = perDay.get(day) ?? { granted: 0, usedGross: 0, returned: 0 };
    const bucket = ledgerBucket(row);
    if (bucket === "granted") entry.granted += row.creditsDelta;
    else if (bucket === "used") entry.usedGross += -row.creditsDelta;
    else if (bucket === "returned") entry.returned += row.creditsDelta;
    perDay.set(day, entry);
  }
  const keys = [...perDay.keys()].sort();
  if (keys.length < 2) return null;
  const [fy, fm, fd] = keys[0].split("-").map(Number);
  const [ly, lm, ld] = keys[keys.length - 1].split("-").map(Number);
  const spanDays = Math.round((new Date(ly, lm - 1, ld).getTime() - new Date(fy, fm - 1, fd).getTime()) / 86_400_000) + 1;
  const count = Math.min(spanDays, maxDays);
  const days: string[] = [];
  for (let offset = spanDays - count; offset < spanDays; offset += 1) {
    const date = new Date(fy, fm - 1, fd + offset);
    days.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
  }
  return {
    days,
    granted: days.map((day) => perDay.get(day)?.granted ?? 0),
    used: days.map((day) => {
      const entry = perDay.get(day);
      return entry ? Math.max(0, entry.usedGross - entry.returned) : 0;
    }),
  };
}
