// The shape of the two secret-store entries.
//
// Prose left every field optional in practice, which is how a Pending with no
// deployment id becomes a rollback nobody can aim. These cases are the ones
// that shape exists to refuse: a missing field, a field of the wrong form, and
// -- the one that reads as healthy -- an entry that is the other one's
// leftover.
//
// None of this is evidence about a deployment. Every field is written by hand.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MOBILE_STORE_ENTRY_DISCLAIMER,
  mobileStoreEntryProblems,
  mobileStorePairProblems,
} from "../scripts/mobile-auth-store-entry-core.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const active = (overrides = {}) => ({
  kind: "active",
  phase: "deployed",
  rotationId: "rot-2026-09-03-a",
  createdAt: "2026-09-03T10:00:00Z",
  fingerprint: { algorithm: "sha256-of-public-keys", value: "aaaa" },
  targetSha: SHA_A,
  deploymentId: "11111111-1111-1111-1111-111111111111",
  ...overrides,
});

const pending = (overrides = {}) => ({
  kind: "pending",
  phase: "drafted",
  rotationId: "rot-2026-09-03-b",
  createdAt: "2026-09-03T11:00:00Z",
  fingerprint: { algorithm: "sha256-of-public-keys", value: "bbbb" },
  targetSha: SHA_B,
  ...overrides,
});

const problems = (entry) => mobileStoreEntryProblems(entry, "e");
const pair = (overrides = {}) =>
  mobileStorePairProblems({ active: active(), pending: pending(), ...overrides });

test("the two shapes in the repository are the shapes the rules describe", () => {
  // The templates are what an operator copies, so they and the rules cannot be
  // allowed to drift. Their fingerprints are placeholders on purpose -- the
  // algorithm is undecided -- and everything else has to hold.
  const loaded = {};
  for (const [slot, path] of [
    ["active", "docs/ops/mobile-auth-store-entries/active.template.json"],
    ["pending", "docs/ops/mobile-auth-store-entries/pending.template.json"],
  ]) {
    loaded[slot] = JSON.parse(readFileSync(path, "utf8"));
    const found = mobileStoreEntryProblems(loaded[slot], path).filter(
      (problem) => !/fingerprint/.test(problem)
    );
    assert.deepEqual(found, []);
  }

  // And as a pair: the two templates must not read as each other's leftovers
  // either, or an operator copying both starts from a state the checker
  // refuses.
  assert.deepEqual(
    mobileStorePairProblems(loaded).filter((problem) => !/fingerprint/.test(problem)),
    []
  );
});

test("every required field is required", () => {
  for (const field of ["kind", "phase", "rotationId", "createdAt", "targetSha", "fingerprint"]) {
    const entry = active();
    delete entry[field];
    assert.ok(
      problems(entry).some((problem) => problem.includes(field)),
      `${field} was not required`
    );
  }
});

test("a field of the wrong form is refused, not accepted as a string", () => {
  const cases = [
    [{ rotationId: "Rot With Spaces" }, /rotationId/],
    [{ rotationId: "no" }, /rotationId/],
    [{ createdAt: "2026-09-03" }, /createdAt/],
    [{ createdAt: "2026-09-03 10:00:00" }, /createdAt/],
    [{ targetSha: "abc123" }, /targetSha/],
    [{ targetSha: SHA_A.toUpperCase() }, /targetSha/],
    [{ deploymentId: "short" }, /deploymentId/],
    [{ fingerprint: "aaaa" }, /fingerprint must be an object/],
    [{ fingerprint: { value: "aaaa" } }, /algorithm/],
    [{ fingerprint: { algorithm: "sha256", value: "" } }, /value/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.match(problems(active(overrides)).join("\n"), pattern, JSON.stringify(overrides));
  }
});

// --- drafted and deployed are different documents ---------------------------

test("a drafted pending has no deploymentId, and must not fake one", () => {
  assert.deepEqual(problems(pending()), []);

  // An empty string or a placeholder reads as an answer. Absence reads as
  // "not yet", which is what it is.
  for (const value of ["", "TBD", "pending"]) {
    assert.match(
      problems(pending({ deploymentId: value })).join("\n"),
      /must be absent/,
      JSON.stringify(value)
    );
  }
});

test("a deployed pending must name its deployment", () => {
  assert.match(
    problems(pending({ phase: "deployed" })).join("\n"),
    /deploymentId is required/
  );
  assert.deepEqual(
    problems(pending({ phase: "deployed", deploymentId: "22222222-2222-2222-2222-222222222222" })),
    []
  );
});

test("an active entry is deployed by definition and always names its deployment", () => {
  assert.match(problems(active({ phase: "drafted" })).join("\n"), /phase is 'deployed'/);
  const withoutId = active();
  delete withoutId.deploymentId;
  assert.match(problems(withoutId).join("\n"), /deploymentId is required/);
});

test("section 5.1's entry has pending's shape under its own kind", () => {
  assert.deepEqual(problems(pending({ kind: "emergency-pending" })), []);
  assert.match(problems(pending({ kind: "candidate" })).join("\n"), /kind/);
});

// --- one entry being the other's leftover ----------------------------------

test("a pending carrying the deployed rotation is refused", () => {
  // The dangerous one: every field is well formed, and the entry reads as a
  // candidate while being what is already running.
  assert.match(
    pair({ pending: pending({ rotationId: active().rotationId }) }).join("\n"),
    /same rotationId|both entries carry rotationId/
  );
});

test("a pending whose material equals the deployed material is refused", () => {
  assert.match(
    pair({ pending: pending({ fingerprint: active().fingerprint }) }).join("\n"),
    /same fingerprint/
  );
});

test("a pending reusing the deployed deployment id is refused", () => {
  assert.match(
    pair({
      pending: pending({ phase: "deployed", deploymentId: active().deploymentId }),
    }).join("\n"),
    /both entries name deployment/
  );
});

test("a pending older than active is a leftover, not a candidate", () => {
  assert.match(
    pair({ pending: pending({ createdAt: "2026-09-01T00:00:00Z" }) }).join("\n"),
    /created before Active/
  );
  assert.deepEqual(pair(), []);
});

test("the kinds are checked against the slots they were read from", () => {
  assert.match(pair({ pending: active() }).join("\n"), /declares itself active/);
  assert.match(pair({ active: pending() }).join("\n"), /declares kind "pending"/);
});

// --- the document is metadata, not a ring ----------------------------------

test("a ring pasted into the metadata is refused, and not echoed back", () => {
  const ring = `sign-2:${"A".repeat(64)}`;
  for (const entry of [
    active({ note: ring }),
    active({ signingRing: "anything" }),
    active({ secret: "anything" }),
  ]) {
    const found = problems(entry).join("\n");
    assert.match(found, /vault's secret fields/);
    assert.equal(found.includes(ring), false, "the refusal repeated the material");
  }
});

test("the disclaimer says what a pass does not mean", () => {
  // It travels with the judgement rather than being a sentence somebody
  // remembers to add: a structural pass is not evidence about a deployment.
  assert.match(MOBILE_STORE_ENTRY_DISCLAIMER, /not evidence that anything was deployed/);
});
