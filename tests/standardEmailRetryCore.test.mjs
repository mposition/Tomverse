import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RETRY_CLASSIFICATIONS,
  STANDARD_LANE_CLAIM_TTL_MS,
  STANDARD_RETRY_CURVES,
  abandonmentEscalation,
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
  // One send and one retry. Was two retries until 2026-08-21, when §9.4's
  // marketing row turned out to name a cap of 2 beside two backoffs; the cap
  // won, because it is the number the section's argument is about.
  assert.equal(STANDARD_RETRY_CURVES.marketing.length, 1);
  assert.equal(standardMaxAttempts("marketing"), 2);

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
    { key: "ok_marketing", classification: "marketing", senderRole: "marketing", purpose: "promotions", requiresUnsubscribe: true },
    { key: "ok_transactional", classification: "transactional", senderRole: "general", purpose: null, requiresUnsubscribe: false },
  ];
  for (const definition of definitions) {
    assert.deepEqual(templateDefinitionProblems(definition), []);
  }

  assert.match(
    templateDefinitionProblems({
      key: "bad",
      classification: "marketing",
      senderRole: "marketing",
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
      senderRole: "general",
      purpose: null,
      requiresUnsubscribe: true,
    })[0],
    /must not carry an unsubscribe link/
  );

  assert.match(
    templateDefinitionProblems({
      key: "bad",
      classification: "legal",
      senderRole: "security",
      purpose: "newsletter",
      requiresUnsubscribe: false,
    })[0],
    /not gateable/
  );
});

// ---------------------------------------------------------------------------
// What running out of attempts is worth telling an operator (§9.4, §9.5)
// ---------------------------------------------------------------------------

test("every classification has an answer to running out of attempts", () => {
  // A classification with no entry would fall through to `undefined` and
  // abandon silently, which is the one outcome §9.4 gives only to marketing.
  for (const classification of RETRY_CLASSIFICATIONS) {
    assert.ok(
      abandonmentEscalation(classification),
      `${classification} has no escalation`
    );
  }
  assert.deepEqual(
    [...RETRY_CLASSIFICATIONS].sort(),
    Object.keys(STANDARD_RETRY_CURVES).sort(),
    "a classification with a curve but no escalation, or the reverse"
  );
});

test("legal is the only critical abandonment, and the only one that ignores its cooldown", () => {
  const legal = abandonmentEscalation("legal");
  assert.equal(legal.notify, true);
  assert.equal(legal.severity, "fatal");
  // §9.4 asks for manual follow-up and an alternate channel. Both are things a
  // person does, per message -- so two in half an hour are two duties unmet,
  // not one event repeating, and the second must not be swallowed.
  assert.equal(legal.forceNotification, true);

  for (const classification of ["transactional", "service"]) {
    const escalation = abandonmentEscalation(classification);
    assert.equal(escalation.notify, true, classification);
    assert.equal(escalation.severity, "error", classification);
    assert.equal(escalation.forceNotification, false, classification);
  }
});

test("marketing gives up quietly", () => {
  // Not a smaller incident -- none. A promotion nobody received is a promotion
  // nobody missed, and §9.4 is explicit that persistence is the failure mode.
  assert.equal(abandonmentEscalation("marketing").notify, false);
});

test("no two classifications share an incident code", () => {
  // The cooldown in lib/operationalMonitoring.ts is keyed by code. A shared
  // code would make the cooldown a shared resource, and the classification that
  // abandons most often would decide whether the others are heard -- with
  // marketing, the quietest by policy, able to silence legal, the loudest.
  const codes = RETRY_CLASSIFICATIONS.map(abandonmentEscalation)
    .filter((escalation) => escalation.notify)
    .map((escalation) => escalation.code);
  assert.equal(new Set(codes).size, codes.length, codes.join(", "));
  for (const code of codes) {
    assert.match(code, /^EMAIL_[A-Z]+_DELIVERY_ABANDONED$/);
  }
});

// ---------------------------------------------------------------------------
// The table itself (§9.4), transcribed
// ---------------------------------------------------------------------------

test("every curve matches §9.4's cap, and holds one fewer delay than that", () => {
  // The policy's own numbers, written out. The marketing row shipped with a cap
  // of 2 beside two backoffs, which cannot both hold; every other row reads as
  // delays = cap - 1, and the cap is what the prose argues about, so the second
  // marketing delay went rather than the cap (resolved 2026-08-21).
  const TABLE = {
    transactional: { maxAttempts: 8, delays: ["10s", "30s", "1m", "5m", "15m", "1h", "4h"] },
    service: { maxAttempts: 6, delays: ["1m", "5m", "15m", "1h", "4h"] },
    legal: {
      maxAttempts: 10,
      delays: ["10s", "30s", "1m", "5m", "15m", "1h", "4h", "12h", "24h"],
    },
    marketing: { maxAttempts: 2, delays: ["5m"] },
  };
  const ms = (text) => {
    const [, amount, unit] = /^(\d+)([smh])$/.exec(text);
    return Number(amount) * { s: 1_000, m: 60_000, h: 3_600_000 }[unit];
  };

  for (const [classification, row] of Object.entries(TABLE)) {
    assert.deepEqual(
      [...STANDARD_RETRY_CURVES[classification]],
      row.delays.map(ms),
      `${classification} does not match the table`
    );
    assert.equal(
      standardMaxAttempts(classification),
      row.maxAttempts,
      `${classification} allows the wrong number of attempts`
    );
    // The invariant that made the marketing row detectable in the first place.
    assert.equal(
      STANDARD_RETRY_CURVES[classification].length,
      row.maxAttempts - 1,
      `${classification} breaks delays === maxAttempts - 1`
    );
  }
});
