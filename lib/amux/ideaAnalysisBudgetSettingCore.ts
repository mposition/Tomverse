import { AMUX_V4_ANALYSIS_INITIAL_MONTHLY_CAP_MICROUSD } from "./ideaAnalysisBudgetCore.ts";

export const AMUX_ANALYSIS_BUDGET_SETTING_ACTION = "amux.idea.analysis_budget.updated";
export const AMUX_ANALYSIS_BUDGET_SETTING_TARGET = "AmuxIdeaAnalysisBudgetSetting";
export const AMUX_ANALYSIS_BUDGET_READ_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ";
export const AMUX_ANALYSIS_BUDGET_WRITE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE";
export const AMUX_ANALYSIS_BUDGET_BOOTSTRAP = {
  version: 0, limitMicroUsd: AMUX_V4_ANALYSIS_INITIAL_MONTHLY_CAP_MICROUSD,
} as const;
const MAX_BIGINT = BigInt("9223372036854775807");

/** Currency input never passes through floating-point rounding or exponent parsing. */
export function analysisBudgetUsdToMicroUsd(value: unknown): string | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(2, "0")) * BigInt(10_000);
  return amount > BigInt(0) && amount <= MAX_BIGINT ? amount.toString() : null;
}

export function analysisBudgetMicroUsdToUsd(value: string): string {
  const amount = BigInt(value);
  const fraction = (amount % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "");
  return `${amount / BigInt(1_000_000)}.${fraction.padEnd(2, "0")}`;
}

export type AnalysisBudgetSnapshot = {
  version: number; limitMicroUsd: string; monthStart: string;
  spentMicroUsd: string; reservedMicroUsd: string; remainingMicroUsd: string;
};

export type PendingAnalysisBudgetSetting = {
  id: string; expectedPreviousVersion: number; monthlyUsd: string;
};

export function readPendingAnalysisBudgetSetting(value: unknown): PendingAnalysisBudgetSetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3 && typeof row.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.id) &&
    Number.isSafeInteger(row.expectedPreviousVersion) &&
    (row.expectedPreviousVersion as number) >= 0 && (row.expectedPreviousVersion as number) < 2_147_483_647 &&
    analysisBudgetUsdToMicroUsd(row.monthlyUsd) !== null
    ? row as PendingAnalysisBudgetSetting : null;
}

export function analysisBudgetSavedMatches(value: unknown, pending: PendingAnalysisBudgetSetting): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.state === "saved" && row.id === pending.id &&
    row.version === pending.expectedPreviousVersion + 1 &&
    row.limitMicroUsd === analysisBudgetUsdToMicroUsd(pending.monthlyUsd) &&
    typeof row.auditId === "string" && row.auditId.length > 0;
}

export function readAnalysisBudgetSnapshotReply(value: unknown): (AnalysisBudgetSnapshot & { writeEnabled: boolean }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.state !== "snapshot" || !Number.isSafeInteger(row.version) || (row.version as number) < 0 ||
    typeof row.monthStart !== "string" || !/^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(row.monthStart) ||
    !Number.isFinite(Date.parse(row.monthStart)) || typeof row.writeEnabled !== "boolean") return null;
  for (const key of ["limitMicroUsd", "spentMicroUsd", "reservedMicroUsd", "remainingMicroUsd"]) {
    if (typeof row[key] !== "string" || !/^(0|[1-9]\d{0,18})$/.test(row[key] as string) ||
      BigInt(row[key] as string) > MAX_BIGINT) return null;
  }
  const limit = BigInt(row.limitMicroUsd as string);
  if (limit <= BigInt(0) || limit !== BigInt(row.spentMicroUsd as string) +
    BigInt(row.reservedMicroUsd as string) + BigInt(row.remainingMicroUsd as string)) return null;
  return { version: row.version as number, monthStart: row.monthStart,
    limitMicroUsd: row.limitMicroUsd as string, spentMicroUsd: row.spentMicroUsd as string,
    reservedMicroUsd: row.reservedMicroUsd as string, remainingMicroUsd: row.remainingMicroUsd as string,
    writeEnabled: row.writeEnabled };
}
