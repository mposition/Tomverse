/** Approved by mposition on 2026-10-04 (AMUX intake policy v13). These are
 * admission values, not proof that a live CLI runner can enforce a deadline. */
export const AMUX_V4_ANALYSIS_CLI_HARD_DEADLINE_MS = 600_000;
export const AMUX_V4_ANALYSIS_DAILY_CLAIM_LIMIT = 12;

export function amuxV4AnalysisUtcDayKey(databaseNow: Date): string | null {
  return databaseNow instanceof Date && Number.isFinite(databaseNow.getTime())
    ? databaseNow.toISOString().slice(0, 10) : null;
}
