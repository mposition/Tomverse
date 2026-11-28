import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_V52_REVIEW_SCOPE_TRANSPORT_MAX_BYTES, amuxV52ReviewScopeFits,
  amuxV52ReviewScopeWithDependencies, decideAmuxV52ReviewDisposition, formatAmuxV52ReviewScope,
  validAmuxV52ReviewEvidence } from "../lib/amux/v52ReviewCore.ts";

const evidence = (overrides = {}) => ({
  jobId: "r-20261016-101442-654908",
  baseSha: "a".repeat(40), commitSha: "b".repeat(40),
  verdict: "accept", authorVendor: "openai",
  reviewerVendors: ["anthropic"], touchesContract: false,
  ...overrides,
});

test("review scope preserves the largest valid Task title and completion criteria", () => {
  const title = "T".repeat(500);
  const criteria = Array.from({ length: 12 }, (_, index) =>
    `${index}:` + "C".repeat(496));
  const scope = formatAmuxV52ReviewScope(title, criteria);
  assert.ok(scope.length > 4_000);
  assert.match(scope, /Title: T{500}/);
  assert.ok(scope.endsWith(`- ${criteria.at(-1)}`));
  // Owner decision 2026-11-28: no character cap; the bound is the transport's bytes.
  assert.doesNotThrow(() => formatAmuxV52ReviewScope("T", ["C".repeat(20_001)]));
  assert.doesNotThrow(() => formatAmuxV52ReviewScope("T", ["C".repeat(79_000)]));
  assert.throws(() => formatAmuxV52ReviewScope("T", ["C".repeat(AMUX_V52_REVIEW_SCOPE_TRANSPORT_MAX_BYTES)]),
    /exceeds the transport/);
  // Korean counts by its bytes: three per character.
  assert.equal(amuxV52ReviewScopeFits("가".repeat(26_000)), true);
  assert.equal(amuxV52ReviewScopeFits("가".repeat(27_000)), false);
});

// 2026-11-28 (AMUX-PUBLIC-004): its review was rejected for missing context;
// its criteria named AMUX-PUBLIC-002's list, which the reviewer never saw.
test("review scope carries the cards the Task depends on whole while they fit, and names the rest", () => {
  const scope = formatAmuxV52ReviewScope("T", ["Every item on AMUX-PUBLIC-002's list is fixed."]);
  assert.equal(amuxV52ReviewScopeWithDependencies(scope, []), scope);
  const list = "| key | fix |\n" + "| pricing.copy.x | 문구를 고칩니다 |\n".repeat(400);
  const withList = amuxV52ReviewScopeWithDependencies(scope, [{ label: "AMUX-PUBLIC-002", text: list }]);
  assert.ok(withList.startsWith(`${scope}\n\nThe cards this Task depends on`));
  assert.ok(withList.endsWith(`## AMUX-PUBLIC-002\n${list}`), "whole");
  // One that does not fit is named, never cut; the ones after it are named too.
  const huge = "x".repeat(AMUX_V52_REVIEW_SCOPE_TRANSPORT_MAX_BYTES);
  const mixed = amuxV52ReviewScopeWithDependencies(scope, [
    { label: "A", text: list }, { label: "B", text: huge }, { label: "C", text: "small" }]);
  assert.ok(mixed.includes(`## A\n${list}`));
  assert.doesNotMatch(mixed, /## B|## C/);
  assert.match(mixed, /Not included, larger than the review request can carry:\n- B \(\d+ characters\)\n- C \(5 characters\)$/);
  assert.equal(amuxV52ReviewScopeFits(mixed), true);
});

test("review evidence binds one job and an independent reviewer", () => {
  assert.equal(validAmuxV52ReviewEvidence(evidence()), true);
  assert.equal(validAmuxV52ReviewEvidence(evidence({
    touchesContract: true, reviewerVendors: ["anthropic", "moonshot"],
  })), true);
  for (const invalid of [
    { baseSha: "a".repeat(39) }, { commitSha: "a".repeat(40) },
    { jobId: null }, { reviewerVendors: [] },
    { reviewerVendors: ["openai"] },
    { reviewerVendors: ["anthropic", "anthropic"] },
    { touchesContract: true },
  ]) assert.equal(validAmuxV52ReviewEvidence(evidence(invalid)), false);
});

test("unknown outcomes may lack a job but cannot be resubmitted as accepted", () => {
  assert.equal(validAmuxV52ReviewEvidence(evidence({
    verdict: "unknown", jobId: null, reviewerVendors: [],
  })), true);
  // An unknown review runs the Task again (a fresh review).
  assert.deepEqual(decideAmuxV52ReviewDisposition("unknown", 0),
    { status: "todo", reason: "review_server_unknown" });
});

test("a rejection runs the Task again; only the same finding rejected again blocks it", () => {
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 0),
    { status: "todo", reason: "review_server_rejected" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 1),
    { status: "todo", reason: "review_server_rejected" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 6),
    { status: "todo", reason: "review_server_rejected" }, "no fixed count blocks");
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 1, true),
    { status: "blocked", reason: "review_server_rejected_twice" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 0, true),
    { status: "todo", reason: "review_server_rejected" }, "nothing earlier to repeat since an owner retry");
  assert.deepEqual(decideAmuxV52ReviewDisposition("accept", 1),
    { status: "review", reason: "review_server_accepted" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("accept", -1),
    { status: "blocked", reason: "review_history_unavailable" });
});
