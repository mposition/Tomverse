// The owner date (docs/policy/sre-ops.md §5, §9 decision T-1): the calendar
// date in Australia/Brisbane, which is UTC+10 all year with no daylight
// saving, so the date is plain arithmetic on the instant.
//
// Two readers share these rules. The page service names the owner date of its
// run start; the advance accepts a reservation only for the owner date of the
// database clock, or of the clock one run deadline ago (a run that started
// before midnight). Since every advance commits by its run deadline, a date's
// reservations are final once the date has ended plus two run deadlines, and
// only then is its daily digest taken.

import { RUN_DEADLINE_MS } from "./transaction-bounds-core.mjs";

/** The owner's time zone (decision T-1). */
export const OWNER_TIME_ZONE = "Australia/Brisbane";
const OWNER_UTC_OFFSET_MS = 10 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The owner date of an instant: its calendar date in Australia/Brisbane. */
export function ownerDateOf(ms) {
  return new Date(ms + OWNER_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** The owner dates a reservation committed at `nowMs` may name. */
export function admissibleReservationDates(nowMs) {
  return [...new Set([ownerDateOf(nowMs), ownerDateOf(nowMs - RUN_DEADLINE_MS)])];
}

/** The instant an owner date ends (midnight after it, in Brisbane). */
export function ownerDateEndMs(ownerDate) {
  return Date.parse(`${ownerDate}T00:00:00.000Z`) - OWNER_UTC_OFFSET_MS + DAY_MS;
}

/**
 * When an owner date's reservations can no longer change: its end, plus the
 * window in which a reservation may still name it, plus the deadline by which
 * that advance must commit, plus a margin for clock reads.
 */
export const DATE_FINAL_AFTER_MS = 2 * RUN_DEADLINE_MS + 30_000;

/** Whether an owner date is closed at `nowMs`. */
export function ownerDateIsFinal(ownerDate, nowMs) {
  return nowMs >= ownerDateEndMs(ownerDate) + DATE_FINAL_AFTER_MS;
}
