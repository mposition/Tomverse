/**
 * Is this string a day that exists?
 *
 * `/^\d{4}-\d{2}-\d{2}$/` is a shape, and a shape admits `2026-99-99` and
 * `2026-02-30`. Every signature record in this family carries a date that a
 * reader is meant to be able to look up — when the sample was frozen, when the
 * subtype table was confirmed — and a date nobody can look up records nothing
 * while passing every check written so far.
 *
 * The round trip is what makes it a calendar question rather than a grammar
 * one: `Date.UTC` normalises out-of-range parts (month 13 becomes January of
 * the next year, 30 February becomes 2 March), so a value that comes back
 * unchanged is a day and one that does not is arithmetic.
 *
 * ## Why this is its own module
 *
 * `mem-eval-succ-7` and `mem-eval-succ-8` both carry their own `ISO_DAY`
 * regex with this weakness. Neither is edited here: both are frozen and
 * signed, and their `reviewedAt`/`approvedAt` values are real days that a
 * person wrote and a person checked. Reaching into them to swap a constant
 * would move a digest that a signature names, which is a worse trade than
 * leaving a superseded check in a superseded module. New records use this.
 */

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDay(value: unknown): boolean {
    if (typeof value !== "string") return false;
    const parts = SHAPE.exec(value);
    if (!parts) return false;
    const [, year, month, day] = parts;
    const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
    if (Number.isNaN(stamp)) return false;
    return new Date(stamp).toISOString().slice(0, 10) === value;
}
