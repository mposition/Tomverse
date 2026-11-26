/**
 * Pure schedule arithmetic for scheduled Code runs: when a schedule runs next, which occurrences were missed, and how a wall-clock time
 * in a time zone maps to an instant (daylight saving included). It reads no clock and touches no file; callers pass `now`.
 *
 * Daylight saving rules, fixed here and covered by tests:
 * - A wall time that does not exist (the hour skipped when clocks go forward) runs at the same moment the clock would have shown it with
 *   the old offset, which is the first valid instant after the gap (02:30 becomes 03:30).
 * - A wall time that happens twice (the hour repeated when clocks go back) runs once, at its first occurrence.
 */

import { z } from "zod";

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const cadence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES), anchor: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("daily"), time: clock }).strict(),
  z.object({ kind: z.literal("weekly"), time: clock, days: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .refine((days) => new Set(days).size === days.length) }).strict(),
]);
export type Cadence = z.infer<typeof cadence>;
export type Timing = { cadence: Cadence; timeZone: string };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

export function validTimeZone(timeZone: string) {
  try { formatter(timeZone).format(0); return true; }
  catch { return false; }
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The wall clock a time zone shows at an instant. */
export function wallClock(instant: number, timeZone: string): Wall {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** Milliseconds a time zone is ahead of UTC at an instant (rounded to the second; real zones use whole minutes). */
export function zoneOffset(instant: number, timeZone: string) {
  const wall = wallClock(instant, timeZone);
  const shown = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return shown - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall time shows in a zone, by the daylight saving rules above. */
export function zonedInstant(timeZone: string, year: number, month: number, day: number, hour: number, minute: number) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = zoneOffset(wall - DAY, timeZone);
  const after = zoneOffset(wall + DAY, timeZone);
  const candidates = [...new Set([wall - before, wall - after])].filter((instant) => zoneOffset(instant, timeZone) === wall - instant);
  if (candidates.length) return Math.min(...candidates);
  return wall - before;
}

function addDays(year: number, month: number, day: number, days: number) {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

const parseClock = (time: string) => ({ hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) });

/** The first occurrence strictly after `after`, or null when the schedule has no later one. */
export function nextRun(timing: Timing, after: number): number | null {
  const { cadence: rule, timeZone } = timing;
  if (rule.kind === "once") return rule.at > after ? rule.at : null;
  if (rule.kind === "interval") {
    const step = rule.everyMinutes * MINUTE;
    if (after < rule.anchor) return rule.anchor;
    return rule.anchor + (Math.floor((after - rule.anchor) / step) + 1) * step;
  }
  const { hour, minute } = parseClock(rule.time);
  const today = wallClock(after, timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    const date = addDays(today.year, today.month, today.day, offset);
    if (rule.kind === "weekly" && !rule.days.includes(date.weekday)) continue;
    const instant = zonedInstant(timeZone, date.year, date.month, date.day, hour, minute);
    if (instant > after) return instant;
  }
  return null;
}

/** Every occurrence in (from, to], oldest first, at most `cap` of them. */
export function occurrencesBetween(timing: Timing, from: number, to: number, cap = 200) {
  const found: number[] = [];
  let cursor = from;
  while (found.length < cap) {
    const next = nextRun(timing, cursor);
    if (next === null || next > to) break;
    found.push(next);
    cursor = next;
  }
  return found;
}

export const DEFAULT_GRACE_MS = 5 * MINUTE;

/**
 * What to do with the occurrences between two evaluations. At app start every one of them is missed: the app was not running, and a
 * missed run is recorded, never made up later. While the app runs, the newest occurrence that is at most `graceMs` old runs, and any
 * older one (a long sleep, a stalled timer) is missed.
 */
export function evaluateSchedule(timing: Timing, lastEvaluated: number, now: number, options: { startup?: boolean; graceMs?: number } = {}) {
  const due = occurrencesBetween(timing, lastEvaluated, now);
  if (!due.length) return { run: null as number | null, missed: [] as number[] };
  if (options.startup) return { run: null, missed: due };
  const newest = due[due.length - 1]!;
  if (now - newest <= (options.graceMs ?? DEFAULT_GRACE_MS)) return { run: newest, missed: due.slice(0, -1) };
  return { run: null, missed: due };
}

/** Why a timing cannot be saved, or null. A one-time run must be in the future. */
export function timingProblem(timing: Timing, now: number): "time-zone" | "past" | null {
  if (!validTimeZone(timing.timeZone)) return "time-zone";
  if (timing.cadence.kind === "once" && timing.cadence.at <= now) return "past";
  return null;
}
