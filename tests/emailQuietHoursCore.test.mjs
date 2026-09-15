import assert from "node:assert/strict";
import { test } from "node:test";

import { parseQuietHours, quietHoursEnd } from "../lib/emailQuietHoursCore.ts";
import { JURISDICTION_PROFILE_SEED } from "../lib/emailJurisdictionSeed.ts";

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

test("outside the window nothing is deferred, and the edges are [start, end)", () => {
  assert.equal(quietHoursEnd(KR, seoul("2026-09-16T08:00:00")), null);
  assert.equal(quietHoursEnd(KR, seoul("2026-09-16T12:00:00")), null);
  assert.equal(quietHoursEnd(KR, seoul("2026-09-15T20:59:59")), null);
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
});
