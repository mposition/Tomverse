import assert from "node:assert/strict";
import { test } from "node:test";

import {
  QUIET_HOURS_START_MARGIN_MS,
  deferralFor,
  parseQuietHours,
  quietHoursEnd,
} from "../lib/emailQuietHoursCore.ts";
import {
  JURISDICTION_PROFILE_SEED,
  jurisdictionSeedProblems,
} from "../lib/emailJurisdictionSeed.ts";

// Night-time delivery rules. Contract: docs/policy/email-notifications.md
// §5.2 E5, §12.6, §21 Q4.

const KR = { start: "21:00", end: "08:00", tz: "Asia/Seoul" };

// Seoul is UTC+9 all year.
const seoul = (iso) => new Date(`${iso}+09:00`);

test("inside the Seoul window a message waits for 08:00 Seoul time", () => {
  assert.equal(
    quietHoursEnd(KR, seoul("2026-09-15T21:00:00"))?.toISOString(),
    seoul("2026-09-16T08:00:00").toISOString()
  );
  assert.equal(
    quietHoursEnd(KR, seoul("2026-09-15T23:42:17.250"))?.toISOString(),
    seoul("2026-09-16T08:00:00").toISOString()
  );
  assert.equal(
    quietHoursEnd(KR, seoul("2026-09-16T07:59:59"))?.toISOString(),
    seoul("2026-09-16T08:00:00").toISOString()
  );
});

test("outside the window nothing is deferred, and the window ends at end", () => {
  assert.equal(quietHoursEnd(KR, seoul("2026-09-16T08:00:00")), null);
  assert.equal(quietHoursEnd(KR, seoul("2026-09-16T12:00:00")), null);
  assert.equal(quietHoursEnd(KR, seoul("2026-09-15T20:54:59")), null);
});

test("just before the start counts as inside, so a send cannot straddle 21:00", () => {
  assert.equal(QUIET_HOURS_START_MARGIN_MS, 5 * 60 * 1_000);
  for (const at of ["2026-09-15T20:55:00", "2026-09-15T20:59:59"]) {
    assert.equal(
      quietHoursEnd(KR, seoul(at))?.toISOString(),
      seoul("2026-09-16T08:00:00").toISOString(),
      at
    );
  }
});

test("a clock change inside the window moves the end with it", () => {
  const ny = { start: "21:00", end: "08:00", tz: "America/New_York" };
  // 2026-11-01: 01:30 EDT (05:30Z) is inside; 08:00 is EST, 13:00Z.
  assert.equal(quietHoursEnd(ny, new Date("2026-11-01T05:30:00Z"))?.toISOString(), "2026-11-01T13:00:00.000Z");
  // 2026-03-08: 23:00 EST (04:00Z) is inside; 08:00 is EDT, 12:00Z.
  assert.equal(quietHoursEnd(ny, new Date("2026-03-08T04:00:00Z"))?.toISOString(), "2026-03-08T12:00:00.000Z");
  // A zone that changes only in the middle of the year and back.
  const casablanca = { start: "21:00", end: "08:00", tz: "Africa/Casablanca" };
  const end = quietHoursEnd(casablanca, new Date("2026-02-14T22:00:00Z"));
  assert.ok(end);
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Casablanca",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(end);
  assert.equal(local, "08:00");
});

test("several windows defer to the latest end, and one unreadable window is reported", () => {
  const at = seoul("2026-09-15T22:00:00");
  assert.deepEqual(deferralFor([{ profileKey: "US", quietHours: null }], at), { until: null });
  assert.equal(
    deferralFor(
      [
        { profileKey: "US", quietHours: null },
        { profileKey: "KR", quietHours: KR },
      ],
      at
    ).until?.toISOString(),
    seoul("2026-09-16T08:00:00").toISOString()
  );
  assert.deepEqual(deferralFor([{ profileKey: "XX", quietHours: { start: "x" } }], at), {
    invalid: "XX",
  });
});

test("the server's clock and zone do not matter, only the profile's", () => {
  // 13:30 UTC is 22:30 in Seoul.
  const now = new Date("2026-09-15T13:30:00Z");
  assert.equal(quietHoursEnd(KR, now)?.toISOString(), "2026-09-15T23:00:00.000Z");
});

test("a same-day window works too", () => {
  const lunch = { start: "12:00", end: "13:00", tz: "UTC" };
  assert.equal(
    quietHoursEnd(lunch, new Date("2026-09-15T12:30:00Z"))?.toISOString(),
    "2026-09-15T13:00:00.000Z"
  );
  assert.equal(quietHoursEnd(lunch, new Date("2026-09-15T13:00:00Z")), null);
});

test("malformed windows are refused rather than guessed", () => {
  assert.equal(parseQuietHours(null), null);
  assert.equal(parseQuietHours(undefined), null);
  for (const value of [
    "21:00-08:00",
    { start: "21:00", end: "08:00" },
    { start: "9pm", end: "08:00", tz: "Asia/Seoul" },
    { start: "21:00", end: "21:00", tz: "Asia/Seoul" },
    { start: "21:00", end: "08:00", tz: "Mars/Olympus" },
  ]) {
    assert.equal(parseQuietHours(value), "invalid", JSON.stringify(value));
  }
  assert.deepEqual(parseQuietHours(KR), KR);
});

test("the seeded KR window is the one this module reads", () => {
  const profiles = JURISDICTION_PROFILE_SEED.filter((profile) => profile.quietHours);
  assert.deepEqual(
    profiles.map((profile) => profile.profileKey),
    ["KR"]
  );
  assert.deepEqual(parseQuietHours(profiles[0].quietHours), KR);
  assert.deepEqual(jurisdictionSeedProblems(), []);
});

test("an offset change across UTC+11 and UTC+12 ends at local 08:00", () => {
  const norfolk = { start: "21:00", end: "08:00", tz: "Pacific/Norfolk" };
  const localHm = (at) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Pacific/Norfolk",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
  for (const iso of ["2026-04-04T11:00:00Z", "2026-10-03T11:00:00Z"]) {
    const end = quietHoursEnd(norfolk, new Date(iso));
    assert.ok(end, iso);
    assert.equal(localHm(end), "08:00", iso);
    assert.ok(end.getTime() - Date.parse(iso) < 14 * 60 * 60 * 1_000, iso);
  }
});

test("a repeated hour does not reopen the window between its two occurrences", () => {
  // New York, 2026-11-01: 01:00-02:00 happens twice. A window ending 01:30
  // ends at the second 01:30 (EST, 06:30Z), not the first (EDT, 05:30Z).
  const ny = { start: "21:00", end: "01:30", tz: "America/New_York" };
  assert.equal(
    quietHoursEnd(ny, new Date("2026-11-01T05:15:00Z"))?.toISOString(),
    "2026-11-01T06:30:00.000Z"
  );
});

test("a one-minute tail inside a repeated hour is not missed", () => {
  const ny = { start: "21:00", end: "01:01", tz: "America/New_York" };
  assert.equal(
    quietHoursEnd(ny, new Date("2026-11-01T05:00:00Z"))?.toISOString(),
    "2026-11-01T06:01:00.000Z"
  );
});
