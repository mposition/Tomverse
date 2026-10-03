import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { cohortDigest, coveredAt } from "../scripts/seal-risk-accepted-cohort-core.mjs";

// The seal tool's scope digest and coverage rule. A sealed approval cannot be
// edited, so what the dry run shows and what --apply seals must be the same
// list. Contract: docs/policy/email-product-news-redesign-draft.md section 5.6.

const at = new Date("2026-09-16T13:59:59.000Z");
const base = {
  approvedAt: at,
  purposeKey: "product_updates",
  addressNormalizationVersion: "v1",
  members: [
    { userId: "b", addressDigest: "d2" },
    { userId: "a", addressDigest: "d1" },
  ],
};

test("the digest does not depend on the order the rows arrive in", () => {
  const reversed = { ...base, members: [...base.members].reverse() };
  assert.equal(cohortDigest(base), cohortDigest(reversed));
});

test("every part of the scope moves the digest", () => {
  const digest = cohortDigest(base);
  assert.notEqual(digest, cohortDigest({ ...base, approvedAt: new Date(at.getTime() + 1) }));
  assert.notEqual(digest, cohortDigest({ ...base, purposeKey: "newsletter" }));
  assert.notEqual(digest, cohortDigest({ ...base, addressNormalizationVersion: "v2" }));
  // An address changed, a member swapped, a member dropped.
  assert.notEqual(digest, cohortDigest({ ...base, members: [{ userId: "a", addressDigest: "dX" }, base.members[0]] }));
  assert.notEqual(digest, cohortDigest({ ...base, members: [{ userId: "c", addressDigest: "d1" }, base.members[0]] }));
  assert.notEqual(digest, cohortDigest({ ...base, members: [base.members[0]] }));
});

test("covered means an address and a signup date at or before the approval", () => {
  assert.equal(coveredAt({ email: "a@example.test", createdAt: at }, at), true);
  assert.equal(coveredAt({ email: "a@example.test", createdAt: new Date(at.getTime() + 1) }, at), false);
  assert.equal(coveredAt({ email: null, createdAt: at }, at), false);
  assert.equal(coveredAt({ email: "a@example.test", createdAt: null }, at), false);
});

test("--apply seals inside one serializable transaction that rechecks and recomputes", () => {
  // The single-seal guarantee rests on the isolation level and on the recheck
  // and digest compare happening inside the transaction that seals.
  const source = readFileSync("scripts/seal-risk-accepted-cohort.mjs", "utf8");
  assert.ok(source.includes('isolationLevel: "Serializable"'));
  const tx = source.slice(source.indexOf("prisma.$transaction("));
  assert.ok(tx.indexOf("ALREADY_SEALED") > 0);
  assert.ok(tx.indexOf("cohortAt(tx, approvedAt)") > tx.indexOf("ALREADY_SEALED"));
  assert.ok(tx.indexOf("current.digest !== confirmCohort") > tx.indexOf("cohortAt(tx, approvedAt)"));
  assert.ok(tx.indexOf("client: tx") > tx.indexOf("current.digest !== confirmCohort"));
});
