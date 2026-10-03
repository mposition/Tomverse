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
  ci: [{ workflow: "e2e.yml", runId: "123", job: "playwright", shard: 2, jobConclusion: "failure", label: "undetermined" }],
  releaseLane: [{ workflow: "drift", runId: "456", job: "drift", jobConclusion: "success", existingNotifierStepRan: false }],
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
  assert.deepEqual(digest.notChecked, ["issue_backlog_unavailable", "gates_changed_not_compared"]);
  assert.deepEqual(digest.issues.candidates, []);
});

test("a list over its maximum is replaced by its overflow code, never truncated", () => {
  const input = baseInput();
  input.ci = Array.from({ length: 17 }, (_, i) => ({
    workflow: "e2e.yml",
    runId: String(i + 1),
    job: "playwright",
    shard: 1,
    jobConclusion: "failure",
    label: "infra",
  }));
  input.issueReport.classified = Array.from({ length: 41 }, (_, i) => ({ number: i + 1, verdict: "open_work" }));
  const digest = buildQaReleaseDigest(input);
  assert.deepEqual(digest.ci, []);
  assert.deepEqual(digest.issues.candidates, []);
  assert.deepEqual(digest.notChecked, ["gates_changed_not_compared", "ci_overflow", "issues_overflow"]);
  // Counts survive: the owner still sees how many there were.
  assert.equal(digest.issues.byVerdict.open_work, 41);
});

test("caller codes are kept once", () => {
  const digest = buildQaReleaseDigest({
    ...baseInput(),
    notChecked: ["github_read_unavailable", "github_read_unavailable"],
  });
  assert.deepEqual(digest.notChecked, ["github_read_unavailable", "gates_changed_not_compared"]);
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
  input.ci = Array.from({ length: 16 }, (_, i) => ({
    workflow: "nightly-visual-regression.yml",
    runId: String(1e15 + i),
    job: "visual-regression",
    shard: 32,
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
  assert.equal(digest.ci.length, 16);
  assert.equal(digest.issues.candidates.length, 40);
});

test("one issue list over its cap does not take the lists still inside theirs", () => {
  const input = baseInput();
  input.issueReport.classified = [
    ...Array.from({ length: 41 }, (_, i) => ({ number: i + 1, verdict: "open_work" })),
    { number: 500, verdict: "blocked" },
    { number: 600, verdict: "landed_but_unverified" },
  ];
  const digest = buildQaReleaseDigest(input);
  assert.deepEqual(digest.issues.candidates, []);
  assert.deepEqual(digest.issues.blocked, [500]);
  assert.deepEqual(digest.issues.landedButUnverified, [600]);
  assert.ok(digest.notChecked.includes("issues_overflow"));
});

test("a missing or one-sided hypothetical run is not read as coverage", () => {
  assert.equal(buildQaReleaseDigest(baseInput()).notChecked.includes("memory_condition_unknown"), false);
  for (const reports of [[], [baseInput().hypotheticalReports[0]], [baseInput().hypotheticalReports[1]]]) {
    const digest = buildQaReleaseDigest({ ...baseInput(), hypotheticalReports: reports });
    assert.ok(digest.notChecked.includes("memory_condition_unknown"), String(reports.length));
  }
  // No applicability-unknown gate: nothing to cover.
  const input = baseInput();
  input.gateReport.classified = input.gateReport.classified.filter((row) => row.verdict !== "applicability_unknown");
  assert.equal(buildQaReleaseDigest({ ...input, hypotheticalReports: [] }).notChecked.includes("memory_condition_unknown"), false);
});

test("the changed list is always marked as not a comparison", () => {
  assert.ok(buildQaReleaseDigest(baseInput()).notChecked.includes("gates_changed_not_compared"));
});

test("more applicability-unknown gates than the cap become an overflow code", () => {
  const input = baseInput();
  input.gateReport.classified = Array.from({ length: 41 }, (_, i) => gate(`MEMORY-${String(i).padStart(2, "0")}`, "pending", "applicability_unknown"));
  input.hypotheticalReports = [];
  const digest = buildQaReleaseDigest(input);
  assert.deepEqual(digest.gates.applicabilityUnknown, []);
  assert.equal(digest.gates.byVerdict.applicability_unknown, 41);
  assert.ok(digest.notChecked.includes("applicability_unknown_overflow"));
});

test("a pair that did not classify a gate, or classified it twice, is not coverage and leaves no rows", () => {
  const base = baseInput();
  const stillUnknown = {
    ...base,
    hypotheticalReports: [
      base.hypotheticalReports[0],
      { assumed: false, report: { classified: [gate("MEMORY-01", "pending", "applicability_unknown")] } },
    ],
  };
  const twice = {
    ...base,
    hypotheticalReports: [
      { assumed: true, report: { classified: [gate("MEMORY-01", "pending", "not_implemented"), gate("MEMORY-01", "pending", "evidence_present")] } },
      base.hypotheticalReports[1],
    ],
  };
  for (const input of [stillUnknown, twice, { ...base, hypotheticalReports: [base.hypotheticalReports[0]] }]) {
    const digest = buildQaReleaseDigest(input);
    assert.ok(digest.notChecked.includes("memory_condition_unknown"));
    assert.deepEqual(digest.hypothetical, []);
  }
});
