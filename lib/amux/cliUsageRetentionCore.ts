/** Pure, dark calculation for the owner-approved 13-month per-invocation
 * retention. It does not aggregate, delete, schedule work, or read a DB. */

export const AMUX_CLI_USAGE_EVENT_RETENTION_MONTHS = 13;

const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function canonicalUtcInstant(value: string): Date {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    throw new Error("AMUX CLI usage timestamp must be canonical UTC ISO");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("AMUX CLI usage timestamp is invalid");
  }
  return parsed;
}

/** Adds 13 calendar months in UTC, clamping the day to the target month's last
 * day. A future writer must materialize this from its server-recorded time and
 * aggregate before deletion; this calculation alone authorizes no cleanup. */
export function amuxCliUsageRetentionDeadline(recordedAt: string): string {
  const recorded = canonicalUtcInstant(recordedAt);
  const totalMonths = recorded.getUTCFullYear() * 12 + recorded.getUTCMonth() +
    AMUX_CLI_USAGE_EVENT_RETENTION_MONTHS;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths % 12;
  if (year > 9999) throw new Error("AMUX CLI usage retention deadline is out of range");

  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month + 1, 0);
  const deadline = new Date(0);
  deadline.setUTCFullYear(year, month, Math.min(recorded.getUTCDate(), lastDay.getUTCDate()));
  deadline.setUTCHours(
    recorded.getUTCHours(), recorded.getUTCMinutes(),
    recorded.getUTCSeconds(), recorded.getUTCMilliseconds(),
  );
  return deadline.toISOString();
}
