// Invariant 10: what the probe may touch, and what its answers have to say.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 7.1
// (invariant 10), 7.5 (why the keyring canary is not this) and 12 (S10a).
//
// This is the only check in the email system that writes. Every test here is
// about one of the two ways that goes wrong: it writes to somebody who is not
// the probe, or it reports a pass for something it did not actually do.

import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_WRITES,
  PROBE_REFUSALS,
  PROBE_REFUSAL_REMEDY,
  PROBE_STEPS,
  RESERVED_PROBE_DOMAINS,
  RESERVED_PROBE_SUFFIXES,
  isReservedProbeAddress,
  probeAccountProblems,
  probeVerdict,
  stepProblems,
  writeScopeProblems,
  writeShapeProblems,
} from "../lib/emailSyntheticProbeCore.ts";

test("only a reserved name can be the probe address", () => {
  // The whole basis for "the probe subject is not a customer". These names are
  // reserved by RFC 2606 and RFC 6761, so no registrar delegates them and no
  // person holds a mailbox under one.
  for (const suffix of RESERVED_PROBE_SUFFIXES) {
    assert.equal(isReservedProbeAddress(`probe@tomverse${suffix}`), true, suffix);
  }
  for (const domain of RESERVED_PROBE_DOMAINS) {
    assert.equal(isReservedProbeAddress(`probe@${domain}`), true, domain);
  }
});

test("a deliverable address is refused, however much it looks like a probe", () => {
  // Each of these is somebody's mailbox, and the probe would unsubscribe them.
  for (const address of [
    "probe@tomverse.app",
    "synthetic-probe@gmail.com",
    "noreply@tomverse.app",
    "probe@example.community",
    "probe@notexample.com",
  ]) {
    assert.equal(isReservedProbeAddress(address), false, address);
  }
});

test("a malformed address is refused rather than parsed generously", () => {
  for (const address of ["", "probe", "probe@", "@example.com", "probe.example.com"]) {
    assert.equal(isReservedProbeAddress(address), false, JSON.stringify(address));
  }
});

test("case and surrounding space do not change the answer", () => {
  assert.equal(isReservedProbeAddress("  Probe@Tomverse.INVALID "), true);
  assert.equal(isReservedProbeAddress("  Probe@Tomverse.APP "), false);
});

test("every refusal tells the operator what to do about it", () => {
  // A check that refuses without saying why gets disabled rather than fixed.
  for (const refusal of PROBE_REFUSALS) {
    const remedy = PROBE_REFUSAL_REMEDY[refusal];
    assert.equal(typeof remedy, "string", refusal);
    assert.ok(remedy.length > 30, `${refusal} has no usable remedy`);
  }
  assert.equal(
    Object.keys(PROBE_REFUSAL_REMEDY).length,
    PROBE_REFUSALS.length,
    "a remedy exists for something that is not a refusal"
  );
});

test("an account with any customer history cannot be the probe's", () => {
  const clean = {
    creditLots: 0,
    conversations: 0,
    hasBillingIdentity: false,
    purchases: 0,
  };
  assert.deepEqual(probeAccountProblems(clean), []);
  assert.equal(probeAccountProblems({ ...clean, creditLots: 1 }).length, 1);
  assert.equal(probeAccountProblems({ ...clean, conversations: 4 }).length, 1);
  assert.equal(probeAccountProblems({ ...clean, hasBillingIdentity: true }).length, 1);
  assert.equal(probeAccountProblems({ ...clean, purchases: 2 }).length, 1);
  // All four at once are four problems, not one: an operator reading the report
  // should see the whole reason the account is somebody's.
  assert.equal(
    probeAccountProblems({
      creditLots: 1,
      conversations: 1,
      hasBillingIdentity: true,
      purchases: 1,
    }).length,
    4
  );
});

const answer = (key, status, body) => ({ key, status, body });

const allGood = () => [
  answer("no_token", 400, { error: "Invalid link." }),
  answer("forged_token", 400, { error: "Invalid link." }),
  answer("valid_token", 200, { ok: true, scope: "purpose", purpose: "product_updates" }),
  answer("replayed_token", 200, { ok: true, scope: "purpose", purpose: "product_updates" }),
];

test("the happy path has nothing to report", () => {
  assert.deepEqual(stepProblems(allGood()), []);
});

test("a refusal that answers 200 is caught", () => {
  // The failure that matters most here: an endpoint that accepts a token it
  // could not open would be accepting forged ones.
  const observed = allGood();
  observed[1] = answer("forged_token", 200, { ok: true, scope: "purpose" });
  const problems = stepProblems(observed);
  assert.ok(problems.some((line) => line.startsWith("forged_token:")));
});

test("an absent token and a forged one must answer identically", () => {
  // Distinguishing them turns the endpoint into an oracle for which tokens are
  // real, so the two steps assert the same status and the same body.
  const absent = PROBE_STEPS.find((step) => step.key === "no_token");
  const forged = PROBE_STEPS.find((step) => step.key === "forged_token");
  assert.equal(absent.expectedStatus, forged.expectedStatus);
  assert.deepEqual(absent.expectedBody, forged.expectedBody);
});

test("a replay must be a success", () => {
  // A recipient who already unsubscribed and is shown an error goes looking for
  // a problem that does not exist, and reaches for the spam button instead.
  const replay = PROBE_STEPS.find((step) => step.key === "replayed_token");
  assert.equal(replay.expectedStatus, 200);
  assert.equal(replay.expectedBody.ok, true);
});

test("a step that did not run is a problem, not an absence", () => {
  const problems = stepProblems(allGood().slice(0, 2));
  assert.ok(problems.some((line) => line.includes("valid_token: the step did not run")));
  assert.ok(problems.some((line) => line.includes("replayed_token: the step did not run")));
});

test("an answer for a step that is not in the path is reported", () => {
  const problems = stepProblems([...allGood(), answer("something_else", 200, {})]);
  assert.ok(problems.some((line) => line.startsWith("something_else:")));
});

test("a body that is not an object is named as such", () => {
  // An HTML error page from a proxy in front of the app, which would otherwise
  // read as a missing field.
  const observed = allGood();
  observed[2] = answer("valid_token", 200, null);
  const problems = stepProblems(observed);
  assert.ok(problems.some((line) => line.includes("the body was not an object")));
});

test("an extra field in the body is not a failure", () => {
  // Subset comparison: the endpoint may add a field without this check needing
  // an edit. A field it stopped sending is still caught.
  const observed = allGood();
  observed[2] = answer("valid_token", 200, {
    ok: true,
    scope: "purpose",
    purpose: "product_updates",
    somethingNew: 1,
  });
  assert.deepEqual(stepProblems(observed), []);
});

const subject = { userId: "u_probe", emailAddress: "probe@tomverse.invalid" };

const writtenSet = () => [
  { table: "EmailPreference", id: "u_probe:product_updates", userId: "u_probe", emailAddress: null },
  { table: "EmailPreferenceTransition", id: "t1", userId: "u_probe", emailAddress: null },
  { table: "ConsentRecord", id: "c1", userId: "u_probe", emailAddress: "probe@tomverse.invalid" },
  { table: "SuppressionCause", id: "s1", userId: null, emailAddress: "probe@tomverse.invalid" },
];

test("rows belonging to the probe subject are in scope", () => {
  assert.deepEqual(writeScopeProblems(writtenSet(), subject), []);
});

test("a row belonging to another account is named", () => {
  const rows = writtenSet();
  rows[1] = { ...rows[1], userId: "u_customer" };
  const problems = writeScopeProblems(rows, subject);
  assert.deepEqual(problems, ["EmailPreferenceTransition:t1 belongs to account u_customer"]);
});

test("a row belonging to another address is named", () => {
  const rows = writtenSet();
  rows[3] = { ...rows[3], emailAddress: "someone@gmail.com" };
  const problems = writeScopeProblems(rows, subject);
  assert.deepEqual(problems, ["SuppressionCause:s1 belongs to a different address"]);
});

test("a row that can be attributed to nothing is a problem, not a pass", () => {
  const rows = [...writtenSet(), { table: "Mystery", id: "m1", userId: null, emailAddress: null }];
  const problems = writeScopeProblems(rows, subject);
  assert.deepEqual(problems, ["Mystery:m1 belongs to no account and no address"]);
});

test("one unsubscribe writes one of each row", () => {
  assert.deepEqual(writeShapeProblems(writtenSet()), []);
  assert.deepEqual(Object.keys(EXPECTED_WRITES).sort(), [
    "ConsentRecord",
    "EmailPreference",
    "EmailPreferenceTransition",
    "SuppressionCause",
  ]);
});

test("a replay that wrote again is caught", () => {
  // The four steps click twice. A second withdrawal row for one recipient's one
  // click is a consent history saying they refused twice.
  const rows = [
    ...writtenSet(),
    { table: "ConsentRecord", id: "c2", userId: "u_probe", emailAddress: "probe@tomverse.invalid" },
  ];
  const problems = writeShapeProblems(rows);
  assert.deepEqual(problems, ["ConsentRecord: 2 row(s), expected 1"]);
});

test("a row the path wrote and this check does not name is reported", () => {
  // The list is written out rather than derived, so the cost of the write path
  // gaining a table is one failing test rather than a silent gap.
  const problems = writeShapeProblems([
    ...writtenSet(),
    { table: "UserSettings", id: "us1", userId: "u_probe", emailAddress: null },
  ]);
  assert.deepEqual(problems, ["UserSettings: written by the path and not named by this check"]);
});

test("a step that never happened is caught by its absent row too", () => {
  const problems = writeShapeProblems(writtenSet().slice(0, 2));
  assert.deepEqual(problems.sort(), [
    "ConsentRecord: 0 row(s), expected 1",
    "SuppressionCause: 0 row(s), expected 1",
  ]);
});

test("a handler that answers ok without writing does not pass", () => {
  // The step this whole file exists for. It cannot be found by reading the
  // handler's own report of itself, so the preference is read back separately.
  const verdict = probeVerdict({
    observed: allGood(),
    written: writtenSet(),
    subject,
    preferenceDisabled: false,
  });
  assert.equal(verdict.ran, true);
  assert.equal(verdict.passed, false);
  assert.ok(
    verdict.problems.some((line) =>
      line.includes("answered ok and the preference is still enabled")
    )
  );
});

test("a run with nothing wrong passes", () => {
  const verdict = probeVerdict({
    observed: allGood(),
    written: writtenSet(),
    subject,
    preferenceDisabled: true,
  });
  assert.deepEqual(verdict, { ran: true, passed: true, problems: [] });
});
