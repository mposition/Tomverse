/** UTC key helper retained for historical analysis receipts. v19 live calls
 * have no ten-minute deadline or daily claim cap. */

export function amuxV4AnalysisUtcDayKey(databaseNow: Date): string | null {
  return databaseNow instanceof Date && Number.isFinite(databaseNow.getTime())
    ? databaseNow.toISOString().slice(0, 10) : null;
}
