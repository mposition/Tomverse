import assert from "node:assert/strict";
import test from "node:test";
import {
  DAY, MINUTE, cadence, evaluateSchedule, nextRun, occurrencesBetween, timingProblem, validTimeZone, wallClock, zonedInstant, type Timing,
} from "../src/schedule-core";

const utc = (iso: string) => Date.parse(iso);
const daily = (time: string, timeZone: string): Timing => ({ cadence: { kind: "daily", time }, timeZone });
const local = (instant: number, timeZone: string) => {
  const wall = wallClock(instant, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`;
};

test("a one-time schedule has one occurrence and then none", () => {
  const timing: Timing = { cadence: { kind: "once", at: utc("2026-12-01T00:00:00Z") }, timeZone: "UTC" };
  assert.equal(nextRun(timing, utc("2026-11-30T00:00:00Z")), utc("2026-12-01T00:00:00Z"));
  assert.equal(nextRun(timing, utc("2026-12-01T00:00:00Z")), null);
});

test("an interval keeps its anchor grid whatever the time of the check", () => {
  const anchor = utc("2026-12-01T00:00:00Z");
  const timing: Timing = { cadence: { kind: "interval", everyMinutes: 30, anchor }, timeZone: "UTC" };
  assert.equal(nextRun(timing, anchor - DAY), anchor);
  assert.equal(nextRun(timing, anchor), anchor + 30 * MINUTE);
  assert.equal(nextRun(timing, anchor + 31 * MINUTE), anchor + 60 * MINUTE);
  assert.deepEqual(occurrencesBetween(timing, anchor, anchor + 100 * MINUTE), [30, 60, 90].map((minutes) => anchor + minutes * MINUTE));
});

test("daily runs follow the wall clock of the zone, not UTC", () => {
  const sydney = daily("09:00", "Australia/Sydney");
  const next = nextRun(sydney, utc("2026-11-30T20:00:00Z"));
  assert.equal(local(next!, "Australia/Sydney"), "2026-12-01 09:00");
  const after = nextRun(sydney, next!);
  assert.equal(local(after!, "Australia/Sydney"), "2026-12-02 09:00");
});

test("a weekly schedule runs only on its days", () => {
  const timing: Timing = { cadence: { kind: "weekly", time: "08:30", days: [1, 5] }, timeZone: "Australia/Brisbane" };
  const found = occurrencesBetween(timing, utc("2026-11-29T00:00:00Z"), utc("2026-12-14T00:00:00Z")).map((instant) => local(instant, "Australia/Brisbane"));
  assert.deepEqual(found, ["2026-11-30 08:30", "2026-12-04 08:30", "2026-12-07 08:30", "2026-12-11 08:30", "2026-12-14 08:30"]);
});

test("a wall time skipped by daylight saving runs right after the gap", () => {
  // New York, 2026-03-08: 02:00 jumps to 03:00, so 02:30 does not exist.
  const instant = zonedInstant("America/New_York", 2026, 3, 8, 2, 30);
  assert.equal(local(instant, "America/New_York"), "2026-03-08 03:30");
  const timing = daily("02:30", "America/New_York");
  const days = occurrencesBetween(timing, utc("2026-03-07T12:00:00Z"), utc("2026-03-10T12:00:00Z")).map((value) => local(value, "America/New_York"));
  assert.deepEqual(days, ["2026-03-08 03:30", "2026-03-09 02:30", "2026-03-10 02:30"]);
});

test("a wall time that happens twice runs once, at its first occurrence", () => {
  // New York, 2026-11-01: 02:00 goes back to 01:00, so 01:30 happens twice.
  const instant = zonedInstant("America/New_York", 2026, 11, 1, 1, 30);
  assert.equal(new Date(instant).toISOString(), "2026-11-01T05:30:00.000Z");
  const timing = daily("01:30", "America/New_York");
  const found = occurrencesBetween(timing, utc("2026-10-31T12:00:00Z"), utc("2026-11-02T12:00:00Z"));
  assert.equal(found.length, 2);
  assert.equal(new Date(found[0]!).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(new Date(found[1]!).toISOString(), "2026-11-02T06:30:00.000Z");
});

test("a zone without daylight saving never shifts", () => {
  const timing = daily("00:00", "Asia/Seoul");
  const found = occurrencesBetween(timing, utc("2026-03-01T00:00:00Z"), utc("2026-03-04T00:00:00Z"));
  assert.deepEqual(found.map((value) => new Date(value).toISOString()), ["2026-03-01T15:00:00.000Z", "2026-03-02T15:00:00.000Z", "2026-03-03T15:00:00.000Z"]);
});

test("at app start every occurrence since the last evaluation is missed and none runs", () => {
  const timing = daily("09:00", "UTC");
  const result = evaluateSchedule(timing, utc("2026-12-01T10:00:00Z"), utc("2026-12-04T09:01:00Z"), { startup: true });
  assert.equal(result.run, null);
  assert.deepEqual(result.missed.map((value) => new Date(value).toISOString()), ["2026-12-02T09:00:00.000Z", "2026-12-03T09:00:00.000Z", "2026-12-04T09:00:00.000Z"]);
});

test("while the app runs, a fresh occurrence runs and a stale one is missed", () => {
  const timing = daily("09:00", "UTC");
  const fresh = evaluateSchedule(timing, utc("2026-12-02T08:59:00Z"), utc("2026-12-02T09:00:20Z"));
  assert.equal(fresh.run, utc("2026-12-02T09:00:00Z"));
  assert.deepEqual(fresh.missed, []);
  const stale = evaluateSchedule(timing, utc("2026-12-02T08:59:00Z"), utc("2026-12-02T14:00:00Z"));
  assert.equal(stale.run, null);
  assert.deepEqual(stale.missed, [utc("2026-12-02T09:00:00Z")]);
  const nothing = evaluateSchedule(timing, utc("2026-12-02T09:00:00Z"), utc("2026-12-02T09:30:00Z"));
  assert.deepEqual(nothing, { run: null, missed: [] });
});

test("only the newest of several due occurrences runs", () => {
  const timing: Timing = { cadence: { kind: "interval", everyMinutes: 5, anchor: utc("2026-12-01T00:00:00Z") }, timeZone: "UTC" };
  const result = evaluateSchedule(timing, utc("2026-12-01T00:00:00Z"), utc("2026-12-01T00:16:00Z"));
  assert.equal(result.run, utc("2026-12-01T00:15:00Z"));
  assert.deepEqual(result.missed, [utc("2026-12-01T00:05:00Z"), utc("2026-12-01T00:10:00Z")]);
});

test("timing validation names the problem", () => {
  const now = utc("2026-12-01T00:00:00Z");
  assert.equal(timingProblem({ cadence: { kind: "once", at: now - 1 }, timeZone: "UTC" }, now), "past");
  assert.equal(timingProblem({ cadence: { kind: "daily", time: "09:00" }, timeZone: "Not/AZone" }, now), "time-zone");
  assert.equal(timingProblem({ cadence: { kind: "daily", time: "09:00" }, timeZone: "UTC" }, now), null);
  assert.equal(validTimeZone("Europe/London"), true);
});

test("the cadence schema refuses malformed times, empty or repeated days, and tiny intervals", () => {
  assert.equal(cadence.safeParse({ kind: "daily", time: "24:00" }).success, false);
  assert.equal(cadence.safeParse({ kind: "weekly", time: "09:00", days: [] }).success, false);
  assert.equal(cadence.safeParse({ kind: "weekly", time: "09:00", days: [1, 1] }).success, false);
  assert.equal(cadence.safeParse({ kind: "interval", everyMinutes: 1, anchor: 1 }).success, false);
  assert.equal(cadence.safeParse({ kind: "daily", time: "09:00", extra: true }).success, false);
});
