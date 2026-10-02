import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  QA_RELEASE_CHECK_NAMES,
  QA_RELEASE_CI_CLASSES,
  QA_RELEASE_CI_JOBS,
  QA_RELEASE_CI_WORKFLOWS,
  QA_RELEASE_DIGEST_ARRAY_LIMITS,
  QA_RELEASE_DIGEST_MAX_BYTES,
  QA_RELEASE_GATE_STATUSES,
  QA_RELEASE_GATE_VERDICTS,
  QA_RELEASE_ISSUE_VERDICTS,
  QA_RELEASE_JOB_CONCLUSIONS,
  QA_RELEASE_NOT_CHECKED_CODES,
  qaReleaseDigestByteLength,
  qaReleaseDigestSchema,
} from "../lib/qaReleaseDigestSchemaCore.ts";
import { GATE_VERDICTS } from "../scripts/report-release-gate-evidence-core.mjs";
import { VERDICTS } from "../scripts/report-issue-backlog-core.mjs";

const longest = (values) => values.reduce((a, b) => (b.length > a.length ? b : a));
const repeat = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const sha = "f".repeat(40);
const instant = "2026-10-03T21:00:00.000Z";
const gateId = "MODERATION-01";
const counts = (keys) => Object.fromEntries(keys.map((key) => [key, 9999]));

/** The longest document the schema admits. */
function worstCaseDigest() {
  const L = QA_RELEASE_DIGEST_ARRAY_LIMITS;
  const longestStatus = longest(QA_RELEASE_GATE_STATUSES);
  const longestVerdict = longest(QA_RELEASE_GATE_VERDICTS);
  const longGateId = "ABCDEFGHIJKLM-99"; // 16 characters, the schema's maximum
  return {
    schemaVersion: 1,
    digestDate: "2026-10-03",
    baseSha: sha,
    generatedAt: instant,
    runDeadline: instant,
    gates: {
      byVerdict: counts(QA_RELEASE_GATE_VERDICTS),
      byStatus: counts(QA_RELEASE_GATE_STATUSES),
      changed: repeat(L.gatesChanged, () => ({ id: longGateId, from: longestStatus, to: longestStatus })),
      applicabilityUnknown: repeat(L.applicabilityUnknown, () => longGateId),
    },
    hypothetical: repeat(L.hypothetical, () => ({
      condition: "memory-release-b-enabled",
      assumed: false,
      id: longGateId,
      verdict: longestVerdict,
    })),
    issues: {
      status: "unavailable",
      byVerdict: counts(QA_RELEASE_ISSUE_VERDICTS),
      candidates: repeat(L.issuesCandidates, () => 999_999),
      blocked: repeat(L.issuesBlocked, () => 999_999),
      landedButUnverified: repeat(L.issuesLandedButUnverified, () => 999_999),
    },
    checks: repeat(L.checks, () => ({ name: longest(QA_RELEASE_CHECK_NAMES), result: "pass" })),
    ci: repeat(L.ci, () => ({
      workflow: "nightly-visual-regression.yml",
      runId: "9".repeat(16),
      job: "visual-regression",
      shard: null, // null serializes longer than any shard number
      jobConclusion: "startup_failure",
      label: longest(QA_RELEASE_CI_CLASSES),
    })),
    releaseLane: repeat(L.releaseLane, () => ({
      workflow: "back-merge",
      runId: "9".repeat(16),
      job: "back-merge",
      jobConclusion: longest(QA_RELEASE_JOB_CONCLUSIONS),
      existingNotifierStepRan: false,
    })),
    notChecked: [...QA_RELEASE_NOT_CHECKED_CODES],
  };
}

test("the enums match their sources", () => {
  assert.deepEqual([...QA_RELEASE_GATE_VERDICTS].sort(), Object.values(GATE_VERDICTS).sort());
  assert.deepEqual([...QA_RELEASE_ISSUE_VERDICTS].sort(), Object.values(VERDICTS).sort());
  const registry = readFileSync(new URL("../docs/release-gates/tomverse-chat-v1.yaml", import.meta.url), "utf8");
  const block = registry.split("allowedStatuses:")[1].split(/\n\s{4}\w/)[0];
  const statuses = [...block.matchAll(/^\s+- ([a-z-]+)$/gm)].map((m) => m[1]);
  assert.deepEqual([...QA_RELEASE_GATE_STATUSES].sort(), statuses.sort());
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of QA_RELEASE_CHECK_NAMES) assert.ok(pkg.scripts[name], `npm script ${name}`);
  for (const workflow of QA_RELEASE_CI_WORKFLOWS) {
    const text = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8");
    const jobsBlock = text.split(/^jobs:\s*$/m)[1] ?? "";
    const jobIds = [...jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
    assert.deepEqual([...QA_RELEASE_CI_JOBS[workflow]].sort(), jobIds.sort(), workflow);
  }
  // The worst case uses the longest workflow-job pair and conclusion; keep it honest.
  const pairs = Object.entries(QA_RELEASE_CI_JOBS).flatMap(([w, jobs]) => jobs.map((j) => w.length + j.length));
  assert.equal(Math.max(...pairs), "nightly-visual-regression.yml".length + "visual-regression".length);
  assert.equal(longest(QA_RELEASE_JOB_CONCLUSIONS).length, "startup_failure".length);
});

test("the worst-case document passes the schema and fits the 16 KiB contract", (t) => {
  const digest = worstCaseDigest();
  assert.equal(qaReleaseDigestSchema.safeParse(digest).success, true);
  const bytes = qaReleaseDigestByteLength(digest);
  t.diagnostic(`worst case ${bytes} bytes`);
  assert.ok(bytes <= QA_RELEASE_DIGEST_MAX_BYTES, `worst case is ${bytes} bytes`);
});

test("one item over any array limit is refused", () => {
  const L = QA_RELEASE_DIGEST_ARRAY_LIMITS;
  const over = [
    (d) => d.gates.changed.push(d.gates.changed[0]),
    (d) => d.gates.applicabilityUnknown.push(gateId),
    (d) => d.hypothetical.push(d.hypothetical[0]),
    (d) => d.issues.candidates.push(1),
    (d) => d.issues.blocked.push(1),
    (d) => d.issues.landedButUnverified.push(1),
    (d) => d.checks.push(d.checks[0]),
    (d) => d.ci.push(d.ci[0]),
    (d) => d.releaseLane.push(d.releaseLane[0]),
    (d) => d.notChecked.push("ci_overflow"),
  ];
  assert.equal(over.length, Object.keys(L).length);
  for (const grow of over) {
    const digest = worstCaseDigest();
    grow(digest);
    assert.equal(qaReleaseDigestSchema.safeParse(digest).success, false, grow.toString());
  }
});

test("free text has nowhere to go", () => {
  const extraField = { ...worstCaseDigest(), note: "anything" };
  assert.equal(qaReleaseDigestSchema.safeParse(extraField).success, false);
  const titleInCi = worstCaseDigest();
  titleInCi.ci[0].title = "test title";
  assert.equal(qaReleaseDigestSchema.safeParse(titleInCi).success, false);
  const textRunId = worstCaseDigest();
  textRunId.ci[0].runId = "run-123";
  assert.equal(qaReleaseDigestSchema.safeParse(textRunId).success, false);
  const freeGateId = worstCaseDigest();
  freeGateId.gates.applicabilityUnknown[0] = "see the log for details";
  assert.equal(qaReleaseDigestSchema.safeParse(freeGateId).success, false);
});

test("counts and numbers stay inside their bounds", () => {
  const tooMany = worstCaseDigest();
  tooMany.gates.byVerdict.unmapped = 10_000;
  assert.equal(qaReleaseDigestSchema.safeParse(tooMany).success, false);
  const fraction = worstCaseDigest();
  fraction.issues.candidates[0] = 1.5;
  assert.equal(qaReleaseDigestSchema.safeParse(fraction).success, false);
  const zero = worstCaseDigest();
  zero.issues.candidates[0] = 0;
  assert.equal(qaReleaseDigestSchema.safeParse(zero).success, false);
  const missingKey = worstCaseDigest();
  delete missingKey.issues.byVerdict.blocked;
  assert.equal(qaReleaseDigestSchema.safeParse(missingKey).success, false);
});

test("a CI row names its job, and carries a class exactly when the job failed", () => {
  const row = (overrides) => {
    const digest = worstCaseDigest();
    digest.ci = [{ workflow: "e2e.yml", runId: "1", job: "playwright", shard: 3, jobConclusion: "failure", label: "infra", ...overrides }];
    return qaReleaseDigestSchema.safeParse(digest).success;
  };
  assert.equal(row({}), true);
  assert.equal(row({ jobConclusion: "success", label: null }), true);
  assert.equal(row({ job: "regression", shard: null }), true);
  assert.equal(row({ jobConclusion: "success", label: "undetermined" }), false);
  assert.equal(row({ label: null }), false);
  assert.equal(row({ job: "verify" }), false);
  assert.equal(row({ shard: 0 }), false);
});

test("a release-lane row names a job of its own workflow", () => {
  const digest = worstCaseDigest();
  digest.releaseLane = [{ workflow: "drift", runId: "1", job: "verify", jobConclusion: "failure", existingNotifierStepRan: false }];
  assert.equal(qaReleaseDigestSchema.safeParse(digest).success, false);
  digest.releaseLane[0].job = "drift";
  assert.equal(qaReleaseDigestSchema.safeParse(digest).success, true);
});

test("every not-checked code can be carried at once, each at most once", () => {
  const digest = worstCaseDigest();
  assert.equal(digest.notChecked.length, QA_RELEASE_NOT_CHECKED_CODES.length);
  digest.notChecked = ["ci_overflow", "ci_overflow"];
  assert.equal(qaReleaseDigestSchema.safeParse(digest).success, false);
});

test("a hypothetical row carries a gate verdict, not a label of its own", () => {
  const digest = worstCaseDigest();
  digest.hypothetical[0].verdict = "hypothetical_if_enabled";
  assert.equal(qaReleaseDigestSchema.safeParse(digest).success, false);
});
