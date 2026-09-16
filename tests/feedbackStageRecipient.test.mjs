import assert from "node:assert/strict";
import test from "node:test";
import {
  FEEDBACK_LIFECYCLE_STAGE,
  FEEDBACK_STAGE_NEEDS_CONSENT,
  feedbackStageRecipient,
} from "../lib/feedbackLifecycleCore.ts";

/**
 * Who each lifecycle email may go to (docs/policy/email-notifications.md §3).
 *
 * The rule this pins is the one whose absence lost an operator's reply on
 * 2026-09-15: the answer to a report is transactional and needs only an
 * address, while the two progress notices need the reporter's tick.
 */

const stages = Object.values(FEEDBACK_LIFECYCLE_STAGE);

test("the answer to a report needs an address and nothing else", () => {
  assert.deepEqual(
    feedbackStageRecipient({
      stage: "completed",
      email: "reporter@example.com",
      emailUpdatesConsent: false,
    }),
    { canSend: true }
  );
  assert.deepEqual(
    feedbackStageRecipient({
      stage: "completed",
      email: "reporter@example.com",
      emailUpdatesConsent: true,
    }),
    { canSend: true }
  );
});

test("progress notices need the reporter's tick", () => {
  for (const stage of ["received", "reviewing"]) {
    assert.deepEqual(
      feedbackStageRecipient({
        stage,
        email: "reporter@example.com",
        emailUpdatesConsent: false,
      }),
      { canSend: false, reason: "not_consented" },
      stage
    );
    assert.deepEqual(
      feedbackStageRecipient({
        stage,
        email: "reporter@example.com",
        emailUpdatesConsent: true,
      }),
      { canSend: true },
      stage
    );
  }
});

test("no address means no stage can be sent, whatever the tick says", () => {
  for (const stage of stages) {
    for (const consent of [true, false, null, undefined]) {
      for (const email of [null, undefined, ""]) {
        assert.deepEqual(
          feedbackStageRecipient({ stage, email, emailUpdatesConsent: consent }),
          { canSend: false, reason: "no_address" },
          `${stage} ${String(consent)} ${String(email)}`
        );
      }
    }
  }
});

test("every stage states whether the tick governs it", () => {
  assert.deepEqual(Object.keys(FEEDBACK_STAGE_NEEDS_CONSENT).sort(), [...stages].sort());
  assert.equal(FEEDBACK_STAGE_NEEDS_CONSENT.completed, false);
});
