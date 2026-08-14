import assert from "node:assert/strict";
import test from "node:test";

import {
  DRILL_SCENARIOS,
  auditFallbackDrill,
} from "../scripts/verify-fallback-drill-core.mjs";

// The half of the drill that decides whether it passed. Tested here because a
// verifier whose only exercise is a real drill is a verifier whose bugs are
// found during the drill -- when the thing under scrutiny is the accounting,
// and a false pass is the worst possible outcome.

const passingRun = (overrides = {}) => ({
  runs: [
    {
      rerouteCount: 1,
      fallbackState: "fallback_used",
      passThroughUsed: false,
      recoveryCandidateModelId: "gpt-5-6-luna",
    },
  ],
  reservations: [{ status: "settled", settledAt: new Date() }],
  attempts: [
    { attemptIndex: 0, outcome: "failed_pre_token" },
    { attemptIndex: 1, outcome: "succeeded" },
  ],
  manifests: [
    { attemptId: "a0", finalizedAt: new Date() },
    { attemptId: "a1", finalizedAt: new Date() },
  ],
  attemptUsage: [
    { attemptIndex: 0, provider: "openai", userBilled: false },
    { attemptIndex: 1, provider: "google", userBilled: true },
  ],
  leases: [],
  logs: [
    '{"event":"chat_fault_injection_armed"}',
    '{"event":"chat_auto_fallback_dispatched"}',
  ],
  ...overrides,
});

const failures = (result) =>
  result.checks.filter((check) => !check.ok).map((check) => check.message);

test("a clean step-4 drill passes", () => {
  const result = auditFallbackDrill(passingRun(), "fallback_succeeds");
  assert.deepEqual(failures(result), []);
  assert.equal(result.passed, true);
});

test("two runs fail it: a retry must not start a second logical response", () => {
  const result = auditFallbackDrill(
    passingRun({ runs: [passingRun().runs[0], passingRun().runs[0]] }),
    "fallback_succeeds"
  );
  assert.equal(result.passed, false);
  assert.match(failures(result).join(" "), /expected 1 RoutingRun, found 2/);
});

test("two reservations fail it", () => {
  const result = auditFallbackDrill(
    passingRun({
      reservations: [
        { status: "settled", settledAt: new Date() },
        { status: "settled", settledAt: new Date() },
      ],
    }),
    "fallback_succeeds"
  );
  assert.match(failures(result).join(" "), /expected 1 ChatCreditReservation/);
});

test("a missing second attempt is reported with what was actually there", () => {
  // "Expected 2 attempts" is a bug report; naming what was found is a
  // diagnosis, and the person reading it is mid-drill.
  const result = auditFallbackDrill(
    passingRun({ attempts: [{ attemptIndex: 0, outcome: "failed_pre_token" }] }),
    "fallback_succeeds"
  );
  assert.match(
    failures(result).join(" "),
    /expected 2 attempt\(s\), found 1 \(0:failed_pre_token\)/
  );
});

test("a third attempt fails it, whatever the outcomes are", () => {
  const result = auditFallbackDrill(
    passingRun({
      attempts: [
        { attemptIndex: 0, outcome: "failed_pre_token" },
        { attemptIndex: 1, outcome: "failed_pre_token" },
        { attemptIndex: 2, outcome: "succeeded" },
      ],
    }),
    "fallback_succeeds"
  );
  assert.equal(result.passed, false);
});

test("a shared or unfinalized manifest fails it", () => {
  // §5: an independent manifest per attempt. A reused one would describe a
  // request that was never sent to that model.
  const shared = auditFallbackDrill(
    passingRun({
      manifests: [
        { attemptId: "a0", finalizedAt: new Date() },
        { attemptId: "a0", finalizedAt: new Date() },
      ],
    }),
    "fallback_succeeds"
  );
  assert.match(failures(shared).join(" "), /share a manifest/);

  const draft = auditFallbackDrill(
    passingRun({
      manifests: [
        { attemptId: "a0", finalizedAt: new Date() },
        { attemptId: "a1", finalizedAt: null },
      ],
    }),
    "fallback_succeeds"
  );
  assert.match(failures(draft).join(" "), /finalized manifest/);
});

test("two billed attempts fail it — the user pays once", () => {
  const result = auditFallbackDrill(
    passingRun({
      attemptUsage: [
        { attemptIndex: 0, provider: "openai", userBilled: true },
        { attemptIndex: 1, provider: "google", userBilled: true },
      ],
    }),
    "fallback_succeeds"
  );
  assert.match(failures(result).join(" "), /exactly 1 billed attempt, found 2/);
});

test("a two-attempt turn with no usage rows fails it", () => {
  const result = auditFallbackDrill(
    passingRun({ attemptUsage: [] }),
    "fallback_succeeds"
  );
  assert.match(failures(result).join(" "), /must .*record what each attempt cost/);
});

test("a lease still held fails it", () => {
  // The failure that only shows up under load: a slot this turn never gave
  // back.
  const result = auditFallbackDrill(
    passingRun({ leases: [{ id: "lease-1" }] }),
    "fallback_succeeds"
  );
  assert.match(failures(result).join(" "), /lease\(s\) still held/);
});

test("a spent pass-through fails it while the Planner is \"none\"", () => {
  const result = auditFallbackDrill(
    passingRun({
      runs: [{ ...passingRun().runs[0], passThroughUsed: true }],
    }),
    "fallback_succeeds"
  );
  assert.match(failures(result).join(" "), /downgrade is supposed to be held/);
});

test("a successful fallback with no §8 recovery candidate fails it", () => {
  const result = auditFallbackDrill(
    passingRun({
      runs: [{ ...passingRun().runs[0], recoveryCandidateModelId: null }],
    }),
    "fallback_succeeds"
  );
  assert.match(failures(result).join(" "), /recovery candidate missing/);
});

test("a failed fallback that recorded a recovery candidate fails it", () => {
  // The inverse, and the one that would quietly send the next turn back to a
  // model that never worked.
  const result = auditFallbackDrill(
    {
      ...passingRun(),
      attempts: [
        { attemptIndex: 0, outcome: "failed_pre_token" },
        { attemptIndex: 1, outcome: "failed_pre_token" },
      ],
      attemptUsage: [
        { attemptIndex: 0, provider: "openai", userBilled: false },
        { attemptIndex: 1, provider: "google", userBilled: true },
      ],
    },
    "fallback_fails"
  );
  assert.match(
    failures(result).join(" "),
    /recorded for a fallback that did not succeed/
  );
});

test("the post-token control expects one attempt and no substitution", () => {
  const result = auditFallbackDrill(
    {
      runs: [
        {
          rerouteCount: 0,
          fallbackState: "none",
          passThroughUsed: false,
          recoveryCandidateModelId: null,
        },
      ],
      reservations: [{ status: "settled", settledAt: new Date() }],
      attempts: [{ attemptIndex: 0, outcome: "failed_post_token" }],
      manifests: [{ attemptId: "a0", finalizedAt: new Date() }],
      attemptUsage: [],
      leases: [],
      logs: ['{"event":"chat_fault_injection_armed"}'],
    },
    "no_fallback_after_token"
  );
  assert.deepEqual(failures(result), []);
});

test("the disconnect case expects a cancelled fallback and no recovery", () => {
  // §7 excludes client disconnect from fallback, so the turn ends on the
  // second attempt. Nothing was delivered, so there is no successful model to
  // keep and no displaced one to remember going back to.
  const result = auditFallbackDrill(
    {
      ...passingRun(),
      runs: [{ ...passingRun().runs[0], recoveryCandidateModelId: null }],
      attempts: [
        { attemptIndex: 0, outcome: "failed_pre_token" },
        { attemptIndex: 1, outcome: "cancelled" },
      ],
    },
    "disconnect_during_fallback"
  );
  assert.deepEqual(failures(result), []);
});

test("a disconnect that recorded a recovery candidate fails it", () => {
  // The user never saw the answer, so keeping the fallback as the sticky model
  // and remembering the primary to return to would both be conclusions drawn
  // from a turn that delivered nothing.
  const result = auditFallbackDrill(
    {
      ...passingRun(),
      attempts: [
        { attemptIndex: 0, outcome: "failed_pre_token" },
        { attemptIndex: 1, outcome: "cancelled" },
      ],
    },
    "disconnect_during_fallback"
  );
  assert.match(
    failures(result).join(" "),
    /recorded for a fallback that did not succeed/
  );
});

test("a third attempt after a disconnect fails it", () => {
  // The one that would mean a hung-up client is being answered by model after
  // model at the user's expense.
  const result = auditFallbackDrill(
    {
      ...passingRun(),
      runs: [{ ...passingRun().runs[0], recoveryCandidateModelId: null }],
      attempts: [
        { attemptIndex: 0, outcome: "failed_pre_token" },
        { attemptIndex: 1, outcome: "cancelled" },
        { attemptIndex: 2, outcome: "succeeded" },
      ],
    },
    "disconnect_during_fallback"
  );
  assert.equal(result.passed, false);
});

test("a drill with no armed line in the logs fails it", () => {
  // Without it a drill is indistinguishable from a real outage in the log
  // record, which is the one place both of them end up.
  const result = auditFallbackDrill(passingRun({ logs: [] }), "fallback_succeeds");
  assert.match(failures(result).join(" "), /chat_fault_injection_armed/);
});

test("an unknown scenario is refused rather than treated as passing", () => {
  const result = auditFallbackDrill(passingRun(), "whatever");
  assert.equal(result.passed, false);
});

test("every scenario names a fault the injector actually offers", () => {
  for (const [name, scenario] of Object.entries(DRILL_SCENARIOS)) {
    assert.ok(scenario.fault, `${name} has no fault`);
    assert.match(scenario.fault, /^attempt_[01]_(pre|post)_token$/);
  }
});
