/** Approved by mposition on 2026-10-04 (AMUX intake policy v13). This is an
 * admission value, not proof that a live CLI runner can enforce a deadline.
 * AMUX intake policy v19 (2026-10-16) removes it together with the Admin stop
 * button; until that lands the deadline stays. v19 also removed v13's daily
 * claim limit of 12: internal improvement requests carry no such cap. */
export const AMUX_V4_ANALYSIS_CLI_HARD_DEADLINE_MS = 600_000;

export function amuxV4AnalysisUtcDayKey(databaseNow: Date): string | null {
  return databaseNow instanceof Date && Number.isFinite(databaseNow.getTime())
    ? databaseNow.toISOString().slice(0, 10) : null;
}
