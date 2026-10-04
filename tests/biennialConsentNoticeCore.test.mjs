import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BIENNIAL_NOTICE_WARN_DAYS,
  biennialNoticeDueAt,
  biennialNoticeVerdict,
} from "../lib/biennialConsentNoticeCore.ts";

// When Korea's two-yearly consent notice falls due.
// Contract: docs/policy/email-product-news-redesign-draft.md section 7.7.

const DAY = 86_400_000;
const anchor = (anchoredAt, source = "consent", userId = "u1") => ({
  userId,
  anchoredAt: new Date(anchoredAt),
  source,
});

test("two years on, in the calendar the statute counts in", () => {
  // Seoul, not UTC. A consent at 2026-01-01T00:00Z is 09:00 on the 1st in
  // Seoul, and its notice is due at 09:00 on 2028-01-01 there -- which is
  // 2028-01-01T00:00Z again, so the two agree here.
  assert.equal(
    biennialNoticeDueAt(new Date("2026-01-01T00:00:00.000Z")).toISOString(),
    "2028-01-01T00:00:00.000Z"
  );

  // And where they do not. 2026-12-31T20:00Z is already 2027-01-01 in Seoul, so
  // the notice is due in 2029 rather than 2028.
  assert.equal(
    biennialNoticeDueAt(new Date("2026-12-31T20:00:00.000Z")).toISOString(),
    "2028-12-31T20:00:00.000Z"
  );
});

test("a 29 February anchor is due on 28 February", () => {
  // Section 7.7 fixes this: 2028 is a leap year and 2030 is not, so rolling
  // forward to 1 March would be a day late, and late is the direction that
  // matters.
  assert.equal(
    biennialNoticeDueAt(new Date("2028-02-29T00:00:00.000Z")).toISOString(),
    "2030-02-28T00:00:00.000Z"
  );
  // A leap day two years from a leap day still exists where the target year has
  // one.
  assert.equal(
    biennialNoticeDueAt(new Date("2024-02-29T00:00:00.000Z")).toISOString(),
    "2026-02-28T00:00:00.000Z"
  );
});

test("nobody anchored is not a problem", () => {
  // No Korean recipient is no obligation, and reporting one would be reporting
  // the absence of a duty.
  const verdict = biennialNoticeVerdict({ anchors: [], now: new Date() });
  assert.deepEqual(verdict, { earliestDueAt: null, recipients: 0, problems: [] });
});

test("the earliest anchor is the one that decides", () => {
  const now = new Date("2026-09-28T00:00:00.000Z");
  const verdict = biennialNoticeVerdict({
    anchors: [
      anchor("2026-06-01T00:00:00.000Z", "signup_date_deemed", "a"),
      anchor("2026-01-15T00:00:00.000Z", "consent", "b"),
      anchor("2026-08-20T00:00:00.000Z", "consent", "c"),
    ],
    now,
  });
  assert.equal(verdict.recipients, 3);
  assert.equal(verdict.earliestDueAt.toISOString(), "2028-01-15T00:00:00.000Z");
  assert.deepEqual(verdict.problems, []);
});

test("sixty days out it warns, and past the date it blocks", () => {
  const due = biennialNoticeDueAt(new Date("2026-01-15T00:00:00.000Z"));
  const anchors = [anchor("2026-01-15T00:00:00.000Z")];

  const early = biennialNoticeVerdict({
    anchors,
    now: new Date(due.getTime() - (BIENNIAL_NOTICE_WARN_DAYS + 1) * DAY),
  });
  assert.deepEqual(early.problems, []);

  const soon = biennialNoticeVerdict({
    anchors,
    now: new Date(due.getTime() - BIENNIAL_NOTICE_WARN_DAYS * DAY),
  });
  assert.equal(soon.problems[0].severity, "warning");
  assert.equal(soon.problems[0].code, "EMAIL_BIENNIAL_CONSENT_NOTICE_SOON");

  // The instant it falls due, not the day after.
  const exactly = biennialNoticeVerdict({ anchors, now: due });
  assert.equal(exactly.problems[0].severity, "error");
  assert.equal(exactly.problems[0].code, "EMAIL_BIENNIAL_CONSENT_NOTICE_DUE");

  const late = biennialNoticeVerdict({ anchors, now: new Date(due.getTime() + DAY) });
  assert.equal(late.problems[0].severity, "error");
});

test("the message says how many recipients and when, and names no one", () => {
  const verdict = biennialNoticeVerdict({
    anchors: [anchor("2020-01-01T00:00:00.000Z", "consent", "somebody")],
    now: new Date("2026-09-28T00:00:00.000Z"),
  });
  const message = verdict.problems[0].message;
  assert.match(message, /1 Korean recipient/);
  assert.match(message, /2022-01-01/);
  assert.ok(!message.includes("somebody"), "a readiness message names no account");
});
