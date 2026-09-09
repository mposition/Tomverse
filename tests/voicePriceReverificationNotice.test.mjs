import assert from "node:assert/strict";
import { test } from "node:test";

import {
  auditVoicePriceRegister,
  voicePriceReverificationNotices,
  VOICE_MODEL_PRICE_REGISTER,
  VOICE_PRICE_REVERIFY_NOTICE_DAYS,
  VOICE_PRICE_REVERIFY_WARNING_WINDOW_DAYS,
} from "../lib/voiceInputPricing.ts";

// The warning window in front of a voice price deadline.
//
// The deadline itself already worked: `check:voice-price-register` fails on
// it, and that check is a PR Fast Gate check. What it did not have was a way
// to say so beforehand, so the first signal would have been every pull
// request turning red at once on the morning of 2026-12-01 -- a correct gate
// arriving as an outage.

const entry = (overrides = {}) => ({
  modelId: "test-transcribe",
  price: {
    audioInputPerMillionTokensUsd: 3,
    textInputPerMillionTokensUsd: 1.25,
    outputPerMillionTokensUsd: 5,
    estimatedCostPerMinuteUsd: 0.003,
  },
  costObservation: null,
  verifiedAt: "2026-09-02",
  owner: "@mposition",
  ticket: "#1247",
  reverifyBy: "2026-12-01",
  ...overrides,
});

const noticesOn = (day, register = [entry()]) =>
  voicePriceReverificationNotices({
    modelIds: register.map((row) => row.modelId),
    now: new Date(`${day}T09:00:00Z`),
    register,
  });

test("nothing is said while the deadline is further away than the window", () => {
  assert.deepEqual(noticesOn("2026-10-31"), []);
});

test("the window opens exactly thirty days out", () => {
  const [notice] = noticesOn("2026-11-01");
  assert.equal(notice?.daysRemaining, VOICE_PRICE_REVERIFY_WARNING_WINDOW_DAYS);
  assert.equal(notice?.thresholdDays, 30);
  assert.equal(notice?.ticket, "#1247");
  assert.equal(notice?.owner, "@mposition");
});

test("each mark is reached on its own day", () => {
  assert.equal(noticesOn("2026-11-17")[0]?.daysRemaining, 14);
  assert.equal(noticesOn("2026-11-17")[0]?.thresholdDays, 14);
  assert.equal(noticesOn("2026-11-24")[0]?.daysRemaining, 7);
  assert.equal(noticesOn("2026-11-24")[0]?.thresholdDays, 7);
});

test("a day between marks still resolves to the mark already passed", () => {
  // Why a missed run delays a notice instead of losing it: the mark is the
  // largest one already reached, so the next day resolves the same one and
  // the sender's own de-duplication decides whether it has been sent.
  assert.equal(noticesOn("2026-11-10")[0]?.thresholdDays, 30);
  assert.equal(noticesOn("2026-11-20")[0]?.thresholdDays, 14);
  assert.equal(noticesOn("2026-11-30")[0]?.thresholdDays, 7);
});

test("the answer does not depend on the hour the run happens at", () => {
  const day = (hour) =>
    voicePriceReverificationNotices({
      modelIds: ["test-transcribe"],
      now: new Date(`2026-11-17T${hour}:00:00Z`),
      register: [entry()],
    })[0];
  assert.equal(day("00")?.daysRemaining, 14);
  assert.equal(day("23")?.daysRemaining, 14);
});

test("the last day before the deadline still warns, and the deadline itself does not", () => {
  assert.equal(noticesOn("2026-11-30")[0]?.daysRemaining, 1);
  // On the deadline the audit is what speaks, and only the audit. The first
  // version of this test asserted `daysRemaining === 0` here -- under this
  // very name -- so the assertion and the name disagreed and the name was the
  // one telling the truth about the contract.
  assert.deepEqual(noticesOn("2026-12-01"), []);
  assert.deepEqual(noticesOn("2026-12-02"), []);
});

test("the deadline day is the audit's alone, so the two layers never both speak", () => {
  // The property the boundary exists for, asserted as a property rather than
  // as a day: on every day from the deadline onward exactly one layer has
  // something to say, and it is the blocking one.
  for (const day of ["2026-12-01", "2026-12-02", "2026-12-31"]) {
    const input = {
      modelIds: ["test-transcribe"],
      now: new Date(`${day}T09:00:00Z`),
      register: [entry()],
    };
    assert.deepEqual(
      voicePriceReverificationNotices(input),
      [],
      `${day}: the warning window has closed`
    );
    assert.equal(
      auditVoicePriceRegister(input).filter(
        (problem) => problem.code === "expired"
      ).length,
      1,
      `${day}: and the audit is failing`
    );
  }
});

test("an expired deadline is the audit's, not the notice's", () => {
  const register = [entry()];
  const expired = { modelIds: ["test-transcribe"], now: new Date("2026-12-05T09:00:00Z"), register };
  assert.deepEqual(voicePriceReverificationNotices(expired), []);
  const problems = auditVoicePriceRegister(expired);
  assert.equal(
    problems.filter((problem) => problem.code === "expired").length,
    1,
    "the deadline having passed is a blocking problem, reported exactly once"
  );
});

test("a warning cannot fail the gate, because the audit cannot produce one", () => {
  // Structural rather than remembered: the blocking function has no code for
  // an approaching deadline, so no future edit can make a warning block.
  const inWindow = {
    modelIds: ["test-transcribe"],
    now: new Date("2026-11-05T09:00:00Z"),
    register: [entry()],
  };
  assert.equal(voicePriceReverificationNotices(inWindow).length, 1);
  assert.deepEqual(auditVoicePriceRegister(inWindow), []);
});

test("every model in the window is reported, not just the first", () => {
  const register = [
    entry(),
    entry({ modelId: "second-transcribe", owner: "@someone-else" }),
  ];
  const notices = noticesOn("2026-11-17", register);
  assert.deepEqual(
    notices.map((notice) => notice.modelId).sort(),
    ["second-transcribe", "test-transcribe"]
  );
});

test("a model the deployment cannot reach is not warned about", () => {
  const notices = voicePriceReverificationNotices({
    modelIds: [],
    now: new Date("2026-11-17T09:00:00Z"),
    register: [entry()],
  });
  assert.deepEqual(notices, []);
});

test("the marks are descending, which is what makes the lookup correct", () => {
  const marks = [...VOICE_PRICE_REVERIFY_NOTICE_DAYS];
  assert.deepEqual(marks, [...marks].sort((a, b) => b - a));
  assert.equal(marks[0], VOICE_PRICE_REVERIFY_WARNING_WINDOW_DAYS);
});

test("the real register's deadlines are readable by this rule", () => {
  // Not a schedule assertion -- the dates move. It only proves the shipped
  // entries parse, so a typo cannot make the notifier silently say nothing.
  for (const row of VOICE_MODEL_PRICE_REGISTER) {
    const dayBefore = new Date(`${row.reverifyBy}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const [notice] = voicePriceReverificationNotices({
      modelIds: [row.modelId],
      now: dayBefore,
      register: VOICE_MODEL_PRICE_REGISTER,
    });
    assert.equal(
      notice?.daysRemaining,
      1,
      `${row.modelId}: the day before its deadline has to be one day out`
    );
    assert.equal(notice?.ticket, row.ticket);
  }
});
