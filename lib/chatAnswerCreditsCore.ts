/**
 * What a saved Chat answer actually cost, from the reservations that name it
 * (`ChatCreditReservation.assistantMessageId`, written by the Chat route when
 * it reserves a saved turn).
 *
 * Display only. Nothing here settles, refunds or prices anything: the figure
 * is the sum of `settledCredits` the settlement already wrote, shown only once
 * it is final (docs/policy/credit-and-cost-limits.md, "답변별 실제 크레딧").
 *
 * Pure, so the server reader and its tests share one rule.
 */

export type AnswerCreditReservation = {
  assistantMessageId: string | null;
  status: string;
  settledCredits: number;
};

/**
 * The statuses whose `settledCredits` is final. Anything else -- `reserved`
 * above all -- means the settlement has not happened yet, and a figure read
 * then would be a guess about what it will write.
 */
const FINAL_RESERVATION_STATUSES: ReadonlySet<string> = new Set([
  "settled",
  "refunded",
]);

/**
 * Answer id -> credits charged, for each answer whose every reservation is
 * final and whose total is at least one credit.
 *
 * - One answer can have more than one reservation (a continuation replan
 *   settles the first one at nothing and reserves again under the same answer
 *   id), so the rows are summed.
 * - Any reservation still open withholds the whole answer: part of a total is
 *   not the total.
 * - A total of zero is withheld too. `refunded` is the status of a failed
 *   turn, a stop before any output and a turn that cost nothing alike, and a
 *   "0" under a failed answer would read as a claim nobody can check.
 */
export function settledAnswerCredits(
  rows: readonly AnswerCreditReservation[]
): Map<string, number> {
  const totals = new Map<string, number>();
  const open = new Set<string>();
  for (const row of rows) {
    const id = row.assistantMessageId;
    if (!id) continue;
    if (!FINAL_RESERVATION_STATUSES.has(row.status)) {
      open.add(id);
      continue;
    }
    const credits = Number.isSafeInteger(row.settledCredits)
      ? Math.max(0, row.settledCredits)
      : 0;
    totals.set(id, (totals.get(id) ?? 0) + credits);
  }
  for (const id of open) totals.delete(id);
  for (const [id, credits] of totals) {
    if (credits < 1) totals.delete(id);
  }
  return totals;
}

/** One page of a conversation, the most a single read asks about. */
export const MAX_ANSWER_CREDIT_IDS = 50;

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The `ids` query parameter: comma-separated message ids, at least one and at
 * most a page. Null when it is missing or malformed, so the caller refuses it
 * rather than guessing which part was meant.
 */
export function parseAnswerCreditIds(value: string | null): string[] | null {
  if (!value) return null;
  const ids = [...new Set(value.split(","))];
  if (ids.length > MAX_ANSWER_CREDIT_IDS) return null;
  return ids.every((id) => MESSAGE_ID.test(id)) ? ids : null;
}

/**
 * The browser's reading of the endpoint's `credits` object: only positive
 * whole numbers survive, so a malformed body shows nothing rather than a
 * wrong figure.
 */
export function parseAnswerCreditsResponse(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const credits = (value as { credits?: unknown } | null)?.credits;
  if (!credits || typeof credits !== "object" || Array.isArray(credits)) return out;
  for (const [id, amount] of Object.entries(credits as Record<string, unknown>)) {
    if (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 1) {
      out.set(id, amount);
    }
  }
  return out;
}
