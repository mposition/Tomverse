import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_USER_TIME_ZONE,
  getUserTimeZoneChangeAllowedAt,
  getZonedDayWindow,
  normalizeIanaTimeZone,
} from "../lib/userTimeZone.ts";

test("uses the account's Brisbane midnight for the daily window", () => {
  const window = getZonedDayWindow(
    "Australia/Brisbane",
    new Date("2026-07-17T03:00:00.000Z")
  );

  assert.equal(window.start.toISOString(), "2026-07-16T14:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-07-17T14:00:00.000Z");
});

test("uses the account's Seoul midnight rather than UTC midnight", () => {
  const window = getZonedDayWindow(
    "Asia/Seoul",
    new Date("2026-07-17T03:00:00.000Z")
  );

  assert.equal(window.start.toISOString(), "2026-07-16T15:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-07-17T15:00:00.000Z");
});

test("allows a 23-hour local day when daylight saving starts", () => {
  const window = getZonedDayWindow(
    "America/New_York",
    new Date("2026-03-08T12:00:00.000Z")
  );

  assert.equal(window.start.toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(window.end.getTime() - window.start.getTime(), 23 * 60 * 60 * 1000);
});

test("allows a 25-hour local day when daylight saving ends", () => {
  const window = getZonedDayWindow(
    "America/New_York",
    new Date("2026-11-01T12:00:00.000Z")
  );

  assert.equal(window.start.toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(window.end.getTime() - window.start.getTime(), 25 * 60 * 60 * 1000);
});

test("falls back to UTC for a missing or invalid stored time zone", () => {
  assert.equal(normalizeIanaTimeZone("Not/A_Time_Zone"), DEFAULT_USER_TIME_ZONE);
  const window = getZonedDayWindow(
    "Not/A_Time_Zone",
    new Date("2026-07-17T03:00:00.000Z")
  );
  assert.equal(window.timeZone, "UTC");
  assert.equal(window.start.toISOString(), "2026-07-17T00:00:00.000Z");
  assert.equal(window.end.toISOString(), "2026-07-18T00:00:00.000Z");
});

test("calculates the next permitted time-zone change after 30 days", () => {
  assert.equal(
    getUserTimeZoneChangeAllowedAt(
      new Date("2026-07-01T00:00:00.000Z")
    )?.toISOString(),
    "2026-07-31T00:00:00.000Z"
  );
  assert.equal(getUserTimeZoneChangeAllowedAt(null), null);
});
