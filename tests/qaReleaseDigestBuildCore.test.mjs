import assert from "node:assert/strict";
import test from "node:test";

import { buildQaReleaseDigest } from "../lib/qaReleaseDigestBuildCore.ts";
import {
  QA_RELEASE_DIGEST_MAX_BYTES,
  qaReleaseDigestByteLength,
} from "../lib/qaReleaseDigestSchemaCore.ts";

const gate = (id, status, verdict) => ({
  id,
  status,
  verdict,
  // Fields the reports carry that the digest must not.
  note: "free text from the report",
  present: ["lib/somewhere.ts"],
});

const baseInput = () => ({
  digestDate: "2026-10-03",
  baseSha: "a".repeat(40),
  generatedAt: "2026-10-03T21:00:00.000Z",
  runDeadline: "2026-10-03T21:15:00.000Z",
  gateReport: {
    classified: [
      gate("ROUTE-01", "pending", "implemented_unmeasured"),
      gate("PACKAGE-01", "approved", "evidence_present"),
      gate("MEMORY-01", "pending", "applicability_unknown"),
    ],
  },
  hypotheticalReports: [
    { assumed: true, report: { classified: [gate("MEMORY-01", "pending", "not_implemented"), gate("ROUTE-01", "pending", "implemented_unmeasured")] } },
    { assumed: false, report: { classified: [gate("MEMORY-01", "pending", "not_applicable")] } },
  ],
  issueReport: {
    classified: [
      { number: 12, verdict: "open_work", title: "an issue title" },
      { number: 15, verdict: "blocked", title: "x" },
      { number: 20, verdict: "landed_but_unverified", title: "y" },
      { number: 21, verdict: "resolved_in_code", title: "z" },
    ],
  },
  checks: [{ name: "check:release-records", result: "pass" }],
  ci: [{ workflow: "e2e.yml", runId: "123", jobConclusion: "failure", label: "undetermined" }],
  releaseLane: [{ workflow: "drift", runId: "456", jobConclusion: "success", existingNotifierStepRan: false }],
  notChecked: [],
});

test("counts, ids and numbers come through; report text does not", () => {
  const digest = buildQaReleaseDigest(baseInput());
  assert.deepEqual(digest.gates.byVerdict, {
    applicability_unknown: 1,
    not_applicable: 0,
    unmapped: 0,
    not_implemented: 0,
    implemented_unmeasured: 1,
    evidence_present: 1,
  });
  assert.equal(digest.gates.byStatus.pending, 2);
  assert.equal(digest.gates.byStatus.approved, 1);
  assert.deepEqual(digest.gates.applicabilityUnknown, ["MEMORY-01"]);
  assert.deepEqual(digest.gates.changed, []);
  assert.deepEqual(digest.issues.candidates, [12]);
  assert.deepEqual(digest.issues.blocked, [15]);
  assert.deepEqual(digest.issues.landedButUnverified, [20]);
  assert.equal(digest.issues.byVerdict.resolved_in_code, 1);
  const serialized = JSON.stringify(digest);
  for (const text of ["free text", "lib/somewhere.ts", "an issue title"]) {
    assert.equal(serialized.includes(text), false, text);
  }
});

test("hypothetical results cover only the gates whose applicability is unknown", () => {
  const digest = buildQaReleaseDigest(baseInput());
  assert.deepEqual(digest.hypothetical, [
    { condition: "memory-release-b-enabled", assumed: true, id: "MEMORY-01", verdict: "not_implemented" },
    { condition: "memory-release-b-enabled", assumed: false, id: "MEMORY-01", verdict: "not_applicable" },
  ]);
});

test("an unavailable backlog says so instead of reading as an empty one", () => {
  const digest = buildQaReleaseDigest({ ...baseInput(), issueReport: null });
  assert.equal(digest.issues.status, "unavailable");
  assert.deepEqual(digest.notChecked, ["issue_backlog_unavailable"]);
  assert.deepEqual(digest.issues.candidates, []);
});

test("a list over its maximum is replaced by its overflow code, never truncated", () => {
  const input = baseInput();
  input.ci = Array.from({ length: 25 }, (_, i) => ({
    workflow: "e2e.yml",
    runId: String(i + 1),
    jobConclusion: "failure",
    label: "infra",
  }));
  input.issueReport.classified = Array.from({ length: 41 }, (_, i) => ({ number: i + 1, verdict: "open_work" }));
  const digest = buildQaReleaseDigest(input);
  assert.deepEqual(digest.ci, []);
  assert.deepEqual(digest.issues.candidates, []);
  assert.deepEqual(digest.notChecked, ["ci_overflow", "issues_overflow"]);
  // Counts survive: the owner still sees how many there were.
  assert.equal(digest.issues.byVerdict.open_work, 41);
});

test("caller codes are kept once", () => {
  const digest = buildQaReleaseDigest({
    ...baseInput(),
    notChecked: ["github_read_unavailable", "github_read_unavailable"],
  });
  assert.deepEqual(digest.notChecked, ["github_read_unavailable"]);
});

test("an unknown verdict or status is refused rather than dropped", () => {
  const input = baseInput();
  input.gateReport.classified.push(gate("NEW-01", "pending", "some_new_verdict"));
  assert.throws(() => buildQaReleaseDigest(input), RangeError);
  const issueInput = baseInput();
  issueInput.issueReport.classified.push({ number: 99, verdict: "mystery" });
  assert.throws(() => buildQaReleaseDigest(issueInput), RangeError);
});

test("every document it returns fits the 16 KiB contract", () => {
  const input = baseInput();
  input.ci = Array.from({ length: 24 }, (_, i) => ({
    workflow: "back-merge-main-to-develop.yml",
    runId: String(1e15 + i),
    jobConclusion: "startup_failure",
    label: "consecutive_repro",
  }));
  input.issueReport.classified = [
    ...Array.from({ length: 40 }, (_, i) => ({ number: 900_000 + i, verdict: "open_work" })),
    ...Array.from({ length: 30 }, (_, i) => ({ number: 800_000 + i, verdict: "blocked" })),
    ...Array.from({ length: 30 }, (_, i) => ({ number: 700_000 + i, verdict: "landed_but_unverified" })),
  ];
  const digest = buildQaReleaseDigest(input);
  assert.ok(qaReleaseDigestByteLength(digest) <= QA_RELEASE_DIGEST_MAX_BYTES);
  assert.equal(digest.ci.length, 24);
  assert.equal(digest.issues.candidates.length, 40);
});
