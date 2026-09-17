import assert from "node:assert/strict";
import test from "node:test";
import {
  OPERATOR_TIME_ZONE,
  denseDailySeries,
  matrixDayTotals,
  matrixHourTotals,
  parseUsagePeriod,
  peakIndex,
  percentChange,
  resolveUsageWindow,
  shareTable,
  stickiness,
  timeZoneRegion,
  weekHourMatrix,
  windowDayKeys,
  zonedStartOfDay,
} from "../lib/adminUsageAnalyticsCore.ts";

// 2026-09-17 05:30 UTC is 15:30 on 17 September in Brisbane (UTC+10, no DST).
const NOW = new Date("2026-09-17T05:30:00.000Z");

test("the operator's zone is Brisbane", () => {
  assert.equal(OPERATOR_TIME_ZONE, "Australia/Brisbane");
});

test("a Brisbane day starts at 14:00 UTC the previous day", () => {
  assert.equal(
    zonedStartOfDay({ year: 2026, month: 9, day: 17 }, "Australia/Brisbane").toISOString(),
    "2026-09-16T14:00:00.000Z"
  );
});

test("local midnight is found on a daylight-saving transition day", () => {
  // Sydney moved to UTC+11 at 02:00 on 4 October 2026; midnight was still +10.
  assert.equal(
    zonedStartOfDay({ year: 2026, month: 10, day: 4 }, "Australia/Sydney").toISOString(),
    "2026-10-03T14:00:00.000Z"
  );
  assert.equal(
    zonedStartOfDay({ year: 2026, month: 10, day: 5 }, "Australia/Sydney").toISOString(),
    "2026-10-04T13:00:00.000Z"
  );
});

test("a day whose midnight is skipped starts at the first instant that exists", () => {
  // Chile moved from UTC-4 to UTC-3 at 00:00 on 6 September 2026, so that day
  // began at 01:00 local time.
  assert.equal(
    zonedStartOfDay({ year: 2026, month: 9, day: 6 }, "America/Santiago").toISOString(),
    "2026-09-06T04:00:00.000Z"
  );
  assert.equal(
    zonedStartOfDay({ year: 2026, month: 9, day: 7 }, "America/Santiago").toISOString(),
    "2026-09-07T03:00:00.000Z"
  );
});

test("an unknown period falls back to today", () => {
  assert.equal(parseUsagePeriod("fortnight"), "today");
  assert.equal(parseUsagePeriod(undefined), "today");
  assert.equal(parseUsagePeriod(["last7", "today"]), "last7");
});

test("today compares with the same elapsed span of yesterday", () => {
  const window = resolveUsageWindow("today", NOW);
  assert.equal(window.start.toISOString(), "2026-09-16T14:00:00.000Z");
  assert.equal(window.end.toISOString(), NOW.toISOString());
  assert.equal(window.previousStart.toISOString(), "2026-09-15T14:00:00.000Z");
  assert.equal(window.previousEnd.toISOString(), "2026-09-16T05:30:00.000Z");
  assert.equal(window.firstDay, "2026-09-17");
  assert.equal(window.dayCount, 1);
  assert.equal(window.inProgress, true);
});

test("yesterday is a whole closed Brisbane day", () => {
  const window = resolveUsageWindow("yesterday", NOW);
  assert.equal(window.start.toISOString(), "2026-09-15T14:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-09-16T14:00:00.000Z");
  assert.equal(window.previousStart.toISOString(), "2026-09-14T14:00:00.000Z");
  assert.equal(window.previousEnd.toISOString(), "2026-09-15T14:00:00.000Z");
  assert.equal(window.firstDay, "2026-09-16");
  assert.equal(window.inProgress, false);
});

test("the last 7 days include today and compare with the 7 before", () => {
  const window = resolveUsageWindow("last7", NOW);
  assert.equal(window.start.toISOString(), "2026-09-10T14:00:00.000Z");
  assert.equal(window.previousStart.toISOString(), "2026-09-03T14:00:00.000Z");
  assert.equal(window.previousEnd.toISOString(), "2026-09-10T05:30:00.000Z");
  assert.deepEqual(windowDayKeys(window), [
    "2026-09-11",
    "2026-09-12",
    "2026-09-13",
    "2026-09-14",
    "2026-09-15",
    "2026-09-16",
    "2026-09-17",
  ]);
});

test("this month compares with the same day of last month", () => {
  const window = resolveUsageWindow("thisMonth", NOW);
  assert.equal(window.start.toISOString(), "2026-08-31T14:00:00.000Z");
  assert.equal(window.previousStart.toISOString(), "2026-07-31T14:00:00.000Z");
  assert.equal(window.previousEnd.toISOString(), "2026-08-17T05:30:00.000Z");
  assert.equal(window.dayCount, 17);
});

test("this month's comparison stops at the end of a shorter month", () => {
  // 31 March: February has no 31st, so the comparison is all of February.
  const window = resolveUsageWindow("thisMonth", new Date("2026-03-31T02:00:00.000Z"));
  assert.equal(window.previousStart.toISOString(), "2026-01-31T14:00:00.000Z");
  assert.equal(window.previousEnd.toISOString(), "2026-02-28T14:00:00.000Z");
});

test("last month is the whole previous calendar month, across a year", () => {
  const window = resolveUsageWindow("lastMonth", new Date("2026-01-10T00:00:00.000Z"));
  assert.equal(window.start.toISOString(), "2025-11-30T14:00:00.000Z");
  assert.equal(window.end.toISOString(), "2025-12-31T14:00:00.000Z");
  assert.equal(window.firstDay, "2025-12-01");
  assert.equal(window.lastDay, "2025-12-31");
  assert.equal(window.dayCount, 31);
  assert.equal(window.previousStart.toISOString(), "2025-10-31T14:00:00.000Z");
});

test("a rise from zero has no percentage", () => {
  assert.equal(percentChange(5, 0), null);
  assert.equal(percentChange(15, 10), 50);
  assert.equal(percentChange(5, 10), -50);
});

test("share tables keep unknown visible and fold the tail into other", () => {
  const table = shareTable(
    [
      { key: "ko", count: 6 },
      { key: null, count: 2 },
      { key: "en", count: 4 },
      { key: "ja", count: 1 },
      { key: "fr", count: 1 },
      { key: "de", count: 0 },
    ],
    3
  );
  assert.equal(table.total, 14);
  assert.deepEqual(
    table.rows.map((row) => [row.key, row.count]),
    [
      ["ko", 6],
      ["en", 4],
      ["other", 4],
    ]
  );
  const withUnknown = shareTable([{ key: "", count: 1 }, { key: "ko", count: 1 }]);
  assert.deepEqual(
    withUnknown.rows.map((row) => row.key),
    ["ko", "unknown"]
  );
  assert.equal(withUnknown.rows[0].share, 0.5);
});

test("the week-hour matrix puts Monday first and ignores bad cells", () => {
  const matrix = weekHourMatrix([
    { dow: 0, hour: 9, count: 3 }, // Sunday
    { dow: 1, hour: 20, count: 5 }, // Monday
    { dow: 7, hour: 1, count: 99 },
    { dow: 2, hour: 24, count: 99 },
  ]);
  assert.equal(matrix[0][20], 5);
  assert.equal(matrix[6][9], 3);
  assert.deepEqual(matrixDayTotals(matrix), [5, 0, 0, 0, 0, 0, 3]);
  assert.equal(matrixHourTotals(matrix)[20], 5);
  assert.equal(peakIndex(matrixHourTotals(matrix)), 20);
  assert.equal(peakIndex([0, 0]), null);
});

test("time zones become continents, and the rest is unknown", () => {
  assert.equal(timeZoneRegion("Asia/Seoul"), "Asia");
  assert.equal(timeZoneRegion("Australia/Brisbane"), "Australia");
  assert.equal(timeZoneRegion("UTC"), "UTC");
  assert.equal(timeZoneRegion("Etc/GMT+3"), "UTC");
  assert.equal(timeZoneRegion("US/Pacific"), "unknown");
  assert.equal(timeZoneRegion(null), "unknown");
});

test("the daily series fills quiet days with zeros", () => {
  const series = denseDailySeries(
    ["2026-09-15", "2026-09-16"],
    [{ day: "2026-09-16", accounts: 2 }, { day: "2026-09-16", messages: 7 }]
  );
  assert.deepEqual(series, [
    { day: "2026-09-15", accounts: 0, guests: 0, requests: 0, messages: 0 },
    { day: "2026-09-16", accounts: 2, guests: 0, requests: 0, messages: 7 },
  ]);
});

test("stickiness is null without active accounts", () => {
  assert.equal(stickiness([1, 1], 0), null);
  assert.equal(stickiness([], 3), null);
  assert.equal(stickiness([2, 4], 6), 0.5);
});
