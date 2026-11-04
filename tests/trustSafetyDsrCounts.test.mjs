import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { countDsrDeadlines } from "../lib/trustSafetyDsrCountsCore.ts";

/**
 * DSR deadline counting (docs/policy/trust-safety-compliance-agent.md §1-1, §14).
 *
 * The rules these pin are the ones the policy states as absolutes: legal hold
 * never leaves the denominator, `status` is not what decides whether a request
 * finished, and the module produces counts rather than a verdict.
 */

const MODULE = "lib/trustSafetyDsrCountsCore.ts";
const DAY = 86_400_000;
const NOW = new Date("2026-11-04T00:00:00.000Z");
const at = (offsetDays) => new Date(NOW.getTime() + offsetDays * DAY);

const row = (overrides) => ({
  id: "req_1",
  requestType: "erasure",
  status: "open",
  dueAt: at(10),
  legalHold: false,
  createdAt: at(-30),
  completedAt: null,
  ...overrides,
});

const count = (rows, imminentWithinDays = 7) =>
  countDsrDeadlines({ rows, now: NOW, imminentWithinDays });

test("an open request past its due date is overdue", () => {
  const counts = count([row({ dueAt: at(-1) })]);
  assert.equal(counts.overdue.total, 1);
  assert.equal(counts.imminent.total, 0);
  assert.equal(counts.closedLate.total, 0);
  assert.equal(counts.observed.total, 1);
});

test("the due instant itself counts as overdue, not imminent", () => {
  // A deadline that has arrived has arrived. Putting it in `imminent` would
  // report a passed deadline as one still ahead.
  const counts = count([row({ dueAt: NOW })]);
  assert.equal(counts.overdue.total, 1);
  assert.equal(counts.imminent.total, 0);
});

test("imminent is the window the caller gave, inclusive of its last instant", () => {
  const counts = count([
    row({ id: "a", dueAt: at(1) }),
    row({ id: "b", dueAt: at(7) }),
    row({ id: "c", dueAt: at(8) }),
  ]);
  assert.equal(counts.imminent.total, 2, "day 1 and day 7 are inside a 7-day window");
  assert.equal(counts.overdue.total, 0);
  assert.equal(counts.observed.total, 3, "day 8 is still observed, just not imminent");
});

test("legal hold is counted as its own dimension and never left out of the total", () => {
  // §1-1: "legal hold를 분모에서 빼지 않고 별도 차원으로 센다".
  const counts = count([
    row({ id: "a", dueAt: at(-2), legalHold: true }),
    row({ id: "b", dueAt: at(-1), legalHold: false }),
  ]);
  assert.equal(counts.overdue.total, 2, "the held request is still overdue");
  assert.equal(counts.overdue.legalHold, 1);
  assert.equal(counts.observed.total, 2);
  assert.equal(counts.observed.legalHold, 1);
});

test("completedAt decides whether a request finished, not status", () => {
  // §1-1 counts "status와 무관하게". A row whose status says "completed" while
  // completedAt is null is still an open deadline; the reverse is still closed.
  const stillOpen = count([row({ status: "completed", dueAt: at(-1), completedAt: null })]);
  assert.equal(stillOpen.overdue.total, 1, "a status label does not close a request");

  const closed = count([
    row({ status: "open", dueAt: at(-5), completedAt: at(-1) }),
  ]);
  assert.equal(closed.overdue.total, 0, "a completed request is not overdue");
  assert.equal(closed.closedLate.total, 1);
});

test("a request completed on or before its due date is not late", () => {
  const counts = count([
    row({ id: "a", dueAt: at(-5), completedAt: at(-6) }),
    row({ id: "b", dueAt: at(-5), completedAt: at(-5) }),
  ]);
  assert.equal(counts.closedLate.total, 0);
  assert.equal(counts.worstLateClosureDays, null);
  assert.equal(counts.observed.total, 2);
});

test("worstLateClosureDays is the worst overrun in whole days", () => {
  const counts = count([
    row({ id: "a", dueAt: at(-10), completedAt: at(-8) }),
    row({ id: "b", dueAt: at(-10), completedAt: at(-5) }),
  ]);
  assert.equal(counts.closedLate.total, 2);
  assert.equal(counts.worstLateClosureDays, 5);
});

test("an overrun under a day reports 0, and no late closure reports null", () => {
  // §14 reads this to tell "하루 이내에 그치면" from "여러 날에 걸치면", so the
  // two cases must not collapse into the same number.
  const underADay = count([
    row({ dueAt: at(-5), completedAt: new Date(at(-5).getTime() + 3 * 3_600_000) }),
  ]);
  assert.equal(underADay.closedLate.total, 1);
  assert.equal(underADay.worstLateClosureDays, 0);

  assert.equal(count([]).worstLateClosureDays, null);
});

test("no rows is a zero count, not an error", () => {
  const counts = count([]);
  assert.deepEqual(counts.observed, { total: 0, legalHold: 0 });
  assert.deepEqual(counts.overdue, { total: 0, legalHold: 0 });
  assert.deepEqual(counts.imminent, { total: 0, legalHold: 0 });
  assert.deepEqual(counts.closedLate, { total: 0, legalHold: 0 });
});

test("the window is echoed so a reader knows what imminent meant", () => {
  assert.equal(count([], 14).imminentWithinDays, 14);
  // A zero-day window is a legitimate choice: it means "nothing is imminent,
  // only overdue counts". It must not be read as "unset".
  const zero = count([row({ dueAt: at(1) })], 0);
  assert.equal(zero.imminent.total, 0);
  assert.equal(zero.imminentWithinDays, 0);
});

test("a window that is not a whole number of days is refused", () => {
  for (const bad of [-1, 1.5, Number.NaN, "7", null, undefined]) {
    assert.throws(
      () => countDsrDeadlines({ rows: [], now: NOW, imminentWithinDays: bad }),
      /whole number of days/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("an invalid now is refused rather than counted against NaN", () => {
  assert.throws(
    () => countDsrDeadlines({ rows: [], now: new Date("nonsense"), imminentWithinDays: 7 }),
    /valid Date/,
  );
});

test("the module produces counts, never a verdict", () => {
  // §13-1 forbids attestation: no synthesised score and no overall pass field.
  // Anchored to the returned shape, not to prose about it.
  const keys = Object.keys(count([])).sort();
  assert.deepEqual(keys, [
    "closedLate",
    "imminent",
    "imminentWithinDays",
    "observed",
    "overdue",
    "worstLateClosureDays",
  ]);
});

test("the module states no imminence threshold of its own", () => {
  // §12 (1)'s tables do not approve one, so a number here would read as an
  // approved figure. The window arrives as an argument and nowhere else.
  const source = readFileSync(MODULE, "utf8");
  assert.doesNotMatch(
    source,
    /(DEFAULT|APPROVED)[A-Z_]*(IMMINENT|WINDOW|DAYS)/,
    "no default imminence constant may be declared here",
  );
  // That it is taken as an input is proved by behaviour, not by text: the
  // "window is echoed" test calls it with 14 and with 0 and reads both back.
  // A regex over a destructuring list would break on formatting instead.
  assert.equal(count([], 14).imminentWithinDays, 14);
  assert.equal(count([], 3).imminentWithinDays, 3);
});

test("the module reads only the seven allowed fields", () => {
  // §1-1 fixes the select allowlist. A field read here that is not on it would
  // mean the observer touched something the policy did not allow.
  const source = readFileSync(MODULE, "utf8");
  for (const forbidden of ["email", "note", "handledBy", "legalHoldReason", "userId"]) {
    assert.ok(!source.includes(forbidden), `${forbidden} is not on the allowlist`);
  }
});

test("an unreadable date is refused rather than counted only in observed", () => {
  // Review finding, 2026-11-04 (copilot/moonshot, minor): a NaN date fails
  // every comparison, so the row landed in `observed` and in no bucket -- an
  // overdue request could leave `overdue` with nothing saying so.
  assert.throws(
    () => count([row({ dueAt: new Date("nonsense") })]),
    /unreadable dueAt/,
  );
  assert.throws(
    () => count([row({ dueAt: at(-5), completedAt: new Date("nonsense") })]),
    /unreadable completedAt/,
  );
  // A null completedAt is the ordinary open request, not an unreadable one.
  assert.equal(count([row({ dueAt: at(-1), completedAt: null })]).overdue.total, 1);
});
