import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STANDARD_LANE_CLAIM_TTL_MS,
  STANDARD_RETRY_CURVES,
  nextStandardAttempt,
  standardMaxAttempts,
} from "../lib/standardEmailRetryCore.ts";
import { templateDefinitionProblems } from "../lib/emailTemplateDefinitions.ts";

// The standard lane's retry curves.
// Contract: docs/policy/email-notifications.md §9.4.

test("every curve starts sooner than it ends", () => {
  for (const [classification, curve] of Object.entries(STANDARD_RETRY_CURVES)) {
    assert.ok(curve.length > 0, `${classification} has no attempts`);
    for (let i = 1; i < curve.length; i += 1) {
      assert.ok(
        curve[i] >= curve[i - 1],
        `${classification} backs off non-monotonically at ${i}`
      );
    }
  }
});

test("a classification runs its curve and is then abandoned", () => {
  const curve = STANDARD_RETRY_CURVES.transactional;

  assert.deepEqual(nextStandardAttempt({ attemptsMade: 1, classification: "transactional" }), {
    retry: true,
    delayMs: curve[0],
  });
  assert.deepEqual(
    nextStandardAttempt({ attemptsMade: curve.length, classification: "transactional" }),
    { retry: true, delayMs: curve[curve.length - 1] }
  );
  assert.deepEqual(
    nextStandardAttempt({ attemptsMade: curve.length + 1, classification: "transactional" }),
    { retry: false, reason: "attempts_exhausted" }
  );
  assert.equal(standardMaxAttempts("transactional"), curve.length + 1);
});

test("legal is the curve that outlasts a working day", () => {
  const total = (classification) =>
    STANDARD_RETRY_CURVES[classification].reduce((sum, ms) => sum + ms, 0);

  // A deletion notice or a breach notification has to reach someone, so it is
  // still trying when everything else has given up.
  assert.ok(total("legal") > total("transactional"));
  assert.ok(total("legal") > 24 * 60 * 60_000);
});

test("marketing gives up almost immediately", () => {
  assert.equal(STANDARD_RETRY_CURVES.marketing.length, 2);

  // Persistence is the failure mode here: hammering a provider that just
  // refused a bulk send turns a momentary block into a lasting one.
  const total = STANDARD_RETRY_CURVES.marketing.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total <= 2 * 60 * 60_000);
  assert.ok(
    STANDARD_RETRY_CURVES.marketing.length <
      STANDARD_RETRY_CURVES.transactional.length
  );
});

test("a claim expires long before a stuck row would be noticed by a human", () => {
  assert.ok(STANDARD_LANE_CLAIM_TTL_MS >= 60_000);
  assert.ok(STANDARD_LANE_CLAIM_TTL_MS <= 15 * 60_000);
});

test("every template definition agrees with the rule the database enforces", () => {
  // The same invariant as the EmailTemplate CHECK constraints, checked here so
  // a bad definition fails the build rather than the insert -- and so the two
  // cannot drift into disagreeing about what marketing means.
  const definitions = [
    { key: "ok_marketing", classification: "marketing", purpose: "promotions", requiresUnsubscribe: true },
    { key: "ok_transactional", classification: "transactional", purpose: null, requiresUnsubscribe: false },
  ];
  for (const definition of definitions) {
    assert.deepEqual(templateDefinitionProblems(definition), []);
  }

  assert.match(
    templateDefinitionProblems({
      key: "bad",
      classification: "marketing",
      purpose: "promotions",
      requiresUnsubscribe: false,
    })[0],
    /must carry an unsubscribe link/
  );

  // The reverse matters as much: an unsubscribe link on a login code is a
  // button that locks people out of their own account.
  assert.match(
    templateDefinitionProblems({
      key: "bad",
      classification: "transactional",
      purpose: null,
      requiresUnsubscribe: true,
    })[0],
    /must not carry an unsubscribe link/
  );

  assert.match(
    templateDefinitionProblems({
      key: "bad",
      classification: "legal",
      purpose: "newsletter",
      requiresUnsubscribe: false,
    })[0],
    /not gateable/
  );
});
