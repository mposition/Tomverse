import assert from "node:assert/strict";
import test from "node:test";

import {
  CONVERSATION_DATE_BUCKETS,
  conversationDateBucket,
  millisecondsUntilNextDay,
  partitionConversationRows,
} from "../lib/conversationListGrouping.ts";

// The sidebar's date headers. What is pinned here is not the wording but the
// four decisions the module makes: calendar days rather than elapsed hours, the
// reader's own zone, a row with no stamp placed where it claims nothing, and a
// pinned row printed once.

const SEOUL = "Asia/Seoul";
const NOW = new Date("2026-09-16T02:00:00Z"); // 11:00 in Seoul

const at = (iso) => ({ now: NOW, timeZone: SEOUL, ...(iso ? {} : {}) });

test("the buckets are the four the contract names, in order", () => {
  assert.deepEqual([...CONVERSATION_DATE_BUCKETS], [
    "today",
    "yesterday",
    "lastSevenDays",
    "older",
  ]);
});

test("today is the reader's calendar day, not the last 24 hours", () => {
  // 00:30 Seoul today: half an hour old, and today.
  assert.equal(
    conversationDateBucket("2026-09-15T15:30:00Z", at()),
    "today"
  );
  // 23:30 Seoul yesterday: eleven and a half hours old, and yesterday.
  assert.equal(
    conversationDateBucket("2026-09-15T14:30:00Z", at()),
    "yesterday"
  );
});

test("the zone decides the day, so two readers can disagree honestly", () => {
  const stamp = "2026-09-15T15:30:00Z";
  assert.equal(conversationDateBucket(stamp, { now: NOW, timeZone: SEOUL }), "today");
  assert.equal(conversationDateBucket(stamp, { now: NOW, timeZone: "UTC" }), "yesterday");
});

test("two to seven calendar days back is the week bucket, eight is older", () => {
  assert.equal(conversationDateBucket("2026-09-14T02:00:00Z", at()), "lastSevenDays");
  assert.equal(conversationDateBucket("2026-09-09T02:00:00Z", at()), "lastSevenDays");
  assert.equal(conversationDateBucket("2026-09-08T02:00:00Z", at()), "older");
});

test("a missing or unreadable stamp is never guessed into today", () => {
  for (const value of [undefined, null, "", "not a date"]) {
    assert.equal(conversationDateBucket(value, at()), "older", String(value));
  }
});

test("a stamp from a clock that runs ahead stays at the top", () => {
  // Otherwise it would sit under "older" while being the newest row on screen.
  assert.equal(conversationDateBucket("2026-09-17T02:00:00Z", at()), "today");
});

// Daylight saving is where "a day" stops being 24 hours, and it is the case
// an independent review found the first implementation getting wrong: it
// subtracted milliseconds, so on the spring-forward morning the previous
// calendar day fell out of "yesterday" entirely.
const NEW_YORK = "America/New_York";

test("the spring-forward day is still 오늘 and 어제", () => {
  // 2026-03-08 is the US spring-forward day: local midnight to midnight is 23
  // hours. At 00:30 on the 9th, the 8th is yesterday and the 7th is two days
  // back, whatever the clocks did in between.
  const now = new Date("2026-03-09T05:30:00Z"); // 00:30 in New York
  const at = { now, timeZone: NEW_YORK };
  assert.equal(conversationDateBucket("2026-03-09T05:10:00Z", at), "today");
  assert.equal(conversationDateBucket("2026-03-08T20:00:00Z", at), "yesterday");
  assert.equal(conversationDateBucket("2026-03-07T20:00:00Z", at), "lastSevenDays");
});

test("the autumn day that lasts 25 hours groups the same way", () => {
  // 2026-11-01 falls back. At 00:30 on the 2nd, the 1st is yesterday.
  const now = new Date("2026-11-02T05:30:00Z"); // 00:30 in New York
  const at = { now, timeZone: NEW_YORK };
  assert.equal(conversationDateBucket("2026-11-02T05:10:00Z", at), "today");
  assert.equal(conversationDateBucket("2026-11-01T18:00:00Z", at), "yesterday");
  assert.equal(conversationDateBucket("2026-10-31T18:00:00Z", at), "lastSevenDays");
});

for (const [label, now] of [
  ["spring forward", new Date("2026-03-08T12:00:00Z")],
  ["autumn back", new Date("2026-11-01T12:00:00Z")],
  ["an ordinary day", new Date("2026-06-15T12:00:00Z")],
]) {
  test(`the midnight timer lands on the real boundary: ${label}`, () => {
    const options = { now, timeZone: NEW_YORK };
    const delay = millisecondsUntilNextDay(options);
    const justBefore = new Date(now.getTime() + delay - 2 * 60 * 1000);
    const justAfter = new Date(now.getTime() + delay);
    assert.equal(
      conversationDateBucket(now.toISOString(), { now: justBefore, timeZone: NEW_YORK }),
      "today",
      "two minutes before the timer, the day has not turned yet"
    );
    assert.equal(
      conversationDateBucket(now.toISOString(), { now: justAfter, timeZone: NEW_YORK }),
      "yesterday",
      "when the timer fires, the day has turned"
    );
  });
}

test("a pinned row is lifted out and never printed twice", () => {
  const rows = [
    { id: "pinned-old", updatedAt: "2026-08-01T02:00:00Z", pinned: true },
    { id: "today", updatedAt: "2026-09-16T01:00:00Z" },
    { id: "yesterday", updatedAt: "2026-09-15T01:00:00Z" },
  ];
  const { pinned, groups } = partitionConversationRows(rows, at());
  assert.deepEqual(pinned.map((row) => row.id), ["pinned-old"]);
  const printed = groups.flatMap((group) => group.conversations.map((row) => row.id));
  assert.deepEqual(printed, ["today", "yesterday"]);
  assert.equal(printed.includes("pinned-old"), false);
});

test("empty buckets produce no header, and order inside a group is the caller's", () => {
  const rows = [
    { id: "b", updatedAt: "2026-09-16T01:00:00Z" },
    { id: "a", updatedAt: "2026-09-16T00:00:00Z" },
    { id: "c", updatedAt: "2026-08-01T00:00:00Z" },
  ];
  const { groups } = partitionConversationRows(rows, at());
  assert.deepEqual(groups.map((group) => group.bucket), ["today", "older"]);
  assert.deepEqual(groups[0].conversations.map((row) => row.id), ["b", "a"]);
});

test("a list of only pinned rows has no date groups at all", () => {
  const { pinned, groups } = partitionConversationRows(
    [{ id: "one", updatedAt: "2026-09-16T01:00:00Z", pinned: true }],
    at()
  );
  assert.equal(pinned.length, 1);
  assert.deepEqual(groups, []);
});

test("the midnight timer lands after the day turns, never before", () => {
  const delay = millisecondsUntilNextDay({ now: NOW, timeZone: SEOUL });
  assert.ok(delay > 0);
  const before = conversationDateBucket(NOW.toISOString(), { now: NOW, timeZone: SEOUL });
  assert.equal(before, "today");
  const after = new Date(NOW.getTime() + delay);
  assert.equal(
    conversationDateBucket(NOW.toISOString(), { now: after, timeZone: SEOUL }),
    "yesterday",
    "once the timer fires, what was today is yesterday"
  );
});
