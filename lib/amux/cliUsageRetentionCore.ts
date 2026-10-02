/** Pure, dark calculations for the owner-approved CLI usage clocks and
 * minimum aggregate size. They do not aggregate, delete, schedule or read DB. */

export const AMUX_CLI_USAGE_EVENT_RETENTION_MONTHS = 13;
export const AMUX_CLI_USAGE_AGGREGATE_RETENTION_MONTHS = 36;
export const AMUX_CLI_USAGE_AGGREGATE_MIN_INVOCATIONS = 5;

const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

/** UTC calendar arithmetic clamps to the target month's last day. */
function addUtcCalendarMonths(recorded: Date, months: number): string {
  const totalMonths = recorded.getUTCFullYear() * 12 + recorded.getUTCMonth() +
    months;
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

/** A future writer must derive this from the immutable DB-recorded time and
 * aggregate before deletion; the calculation authorizes no cleanup alone. */
export function amuxCliUsageRetentionDeadline(recordedAt: string): string {
  return addUtcCalendarMonths(
    canonicalUtcInstant(recordedAt), AMUX_CLI_USAGE_EVENT_RETENTION_MONTHS,
  );
}

/** v24: a long-term cell expires 36 months after its first immutable DB
 * record. Recalculation must not supply a new clock to extend retention. */
export function amuxCliAggregateRetentionDeadline(firstRecordedAt: string): string {
  return addUtcCalendarMonths(
    canonicalUtcInstant(firstRecordedAt), AMUX_CLI_USAGE_AGGREGATE_RETENTION_MONTHS,
  );
}

/** A merged cell inherits the earliest original clock, never the merge time.
 * The future DB writer must prove each input is an original, server-owned clock. */
export function amuxCliMergedAggregateFirstRecordedAt(
  firstRecordedAts: readonly string[],
): string {
  if (!Array.isArray(firstRecordedAts) || firstRecordedAts.length === 0) {
    throw new Error("AMUX CLI aggregate merge needs original recorded times");
  }
  let earliest = canonicalUtcInstant(firstRecordedAts[0]);
  for (const value of firstRecordedAts.slice(1)) {
    const candidate = canonicalUtcInstant(value);
    if (candidate.getTime() < earliest.getTime()) earliest = candidate;
  }
  return earliest.toISOString();
}

/** Count actual distinct invocations rather than trusting a caller-supplied
 * count that could accidentally be model rows, tokens or tasks. */
export function amuxCliAggregateMeetsMinimum(invocationIds: readonly string[]): boolean {
  if (!Array.isArray(invocationIds)) {
    throw new Error("AMUX CLI aggregate needs invocation IDs");
  }
  const distinct = new Set<string>();
  for (const id of invocationIds) {
    if (typeof id !== "string" || !UUID_V4.test(id)) {
      throw new Error("AMUX CLI aggregate invocation ID is invalid");
    }
    distinct.add(id);
  }
  return distinct.size >= AMUX_CLI_USAGE_AGGREGATE_MIN_INVOCATIONS;
}
