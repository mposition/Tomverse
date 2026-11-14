import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rejectionSummary, reviewStep } from "../scripts/amux-v52-review-runner.mjs";
import {
  AMUX_V52_FINDINGS_SUMMARY_MAX_CHARS,
  AMUX_V52_FINDINGS_SUMMARY_MAX_LINES,
  amuxV52RejectionView,
  normalizeAmuxV52FindingsSummary,
} from "../lib/amux/v52ReviewFindingsCore.ts";

// Owner decision 2026-11-14: a rejected v52 review keeps a short reason so
// the owner decides from Admin without reading the review server.

const input = { attemptId: "4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f",
  baseSha: "a".repeat(40), commitSha: "b".repeat(40),
  reviewRef: "refs/amux-v52-review/4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f",
  author: "claude", authorVendor: "anthropic",
  scope: "Title: Fix bug\nCompletion criteria:\n- Covered",
  touchesContract: false };

const rejectStatus = (jobId) => ({ jobId, base: input.baseSha,
  head: input.commitSha, author: input.author, repo: "tomverse",
  authorVendor: input.authorVendor, touchesContract: false, status: "reject",
  reviews: [{ slot: 0, vendor: "openai", verdict: "reject", findings: [
    { severity: "minor", summary: "Tests do not cover the empty trailer." },
    { severity: "major", file: "lib/chat/stream.ts", line: 42,
      summary: "artifactUnavailable is\nnever set   on a failed upload." },
    { severity: "unknown", summary: "dropped" },
  ] }] });

test("the summary orders findings by severity, one bounded line each", () => {
  const summary = rejectionSummary(rejectStatus("r-20261114-100000-abcdef"));
  assert.equal(summary, [
    "- [major · openai] lib/chat/stream.ts:42 artifactUnavailable is never set on a failed upload.",
    "- [minor · openai] Tests do not cover the empty trailer.",
  ].join("\n"));
  const many = { reviews: [{ verdict: "reject", vendor: "openai",
    findings: Array.from({ length: 20 }, (_, index) => ({ severity: "nit",
      summary: `finding ${index} ${"x".repeat(100)}` })) }] };
  const lines = rejectionSummary(many).split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines.at(-1), "- … 12 more");
  const long = { reviews: [{ verdict: "reject", vendor: "openai",
    findings: Array.from({ length: 20 }, () => ({ severity: "nit", summary: "z".repeat(600) })) }] };
  const longLines = rejectionSummary(long).split("\n");
  assert.ok(longLines.every((line) => line.length <= 280));
  assert.ok(rejectionSummary(long).length <= 2_000 + "\n- … 99 more".length);
  assert.equal(longLines.at(-1), `- … ${20 - (longLines.length - 1)} more`);
  assert.equal(rejectionSummary({ reviews: [{ verdict: "accept", findings: [
    { severity: "major", summary: "not a reject" }] }] }), null);
  assert.equal(rejectionSummary(null), null);
});

test("a reject step returns and keeps its summary; an accept carries none", () => {
  const jobId = "r-20261114-100001-abcdef";
  const stateDir = mkdtempSync(join(tmpdir(), "amux-v52-findings-"));
  const options = { stateDir, client: join(stateDir, "review.mjs"),
    uid: statSync(stateDir).uid, prepareRepository: () => stateDir,
    run: (_program, args) => args.includes("submit") ?
      { code: 3, stdout: JSON.stringify({ jobId }) } :
      { code: 1, stdout: JSON.stringify(rejectStatus(jobId)) } };
  try {
    assert.equal(reviewStep(input, options).kind, "pending");
    const final = reviewStep(input, options);
    assert.equal(final.evidence.verdict, "reject");
    assert.match(final.findingsSummary, /^- \[major · openai\] lib\/chat\/stream\.ts:42 /);
    // The evidence the app digests is unchanged by the summary.
    assert.deepEqual(Object.keys(final.evidence).sort(), ["author_vendor", "base_sha",
      "commit_sha", "job_id", "reviewer_vendors", "touches_contract", "verdict"]);
    // A re-read of the durable final returns the same summary without a call.
    const again = reviewStep(input, { ...options, run: () => { throw new Error("no call"); } });
    assert.deepEqual(again, final);
    const state = JSON.parse(readFileSync(join(stateDir, `${input.attemptId}.json`), "utf8"));
    assert.equal(state.findingsSummary, final.findingsSummary);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }

  const acceptDir = mkdtempSync(join(tmpdir(), "amux-v52-findings-"));
  try {
    const accepted = { ...rejectStatus(jobId), status: "accept",
      reviews: [{ slot: 0, vendor: "openai", verdict: "accept", findings: [] }] };
    const run = (_program, args) => args.includes("submit") ?
      { code: 3, stdout: JSON.stringify({ jobId }) } :
      { code: 0, stdout: JSON.stringify(accepted) };
    const acceptOptions = { stateDir: acceptDir, client: join(acceptDir, "review.mjs"),
      uid: statSync(acceptDir).uid, prepareRepository: () => acceptDir, run };
    reviewStep(input, acceptOptions);
    const final = reviewStep(input, acceptOptions);
    assert.equal(final.evidence.verdict, "accept");
    assert.equal("findingsSummary" in final, false);
  } finally { rmSync(acceptDir, { recursive: true, force: true }); }
});

test("a malformed findings list never changes a reject verdict", () => {
  const jobId = "r-20261114-100002-abcdef";
  const stateDir = mkdtempSync(join(tmpdir(), "amux-v52-findings-"));
  const status = { ...rejectStatus(jobId), reviews: [{ slot: 0, vendor: "openai",
    verdict: "reject", findings: [null, 7, { severity: "major", summary: 3 }] }] };
  const options = { stateDir, client: join(stateDir, "review.mjs"),
    uid: statSync(stateDir).uid, prepareRepository: () => stateDir,
    run: (_program, args) => args.includes("submit") ?
      { code: 3, stdout: JSON.stringify({ jobId }) } :
      { code: 1, stdout: JSON.stringify(status) } };
  try {
    reviewStep(input, options);
    assert.deepEqual(reviewStep(input, options), { kind: "final", evidence: {
      job_id: jobId, base_sha: input.baseSha, commit_sha: input.commitSha,
      verdict: "reject", author_vendor: input.authorVendor,
      reviewer_vendors: ["openai"], touches_contract: false } });
    assert.equal(rejectionSummary({ reviews: [{ verdict: "reject", findings: "x" }] }), null);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("the app drops credential-like lines, hides links and bounds the text", () => {
  const token = `ghp_${"A".repeat(36)}`;
  const normalized = normalizeAmuxV52FindingsSummary([
    "- [major] leaks the token " + token,
    "- [minor] see https://review.internal.example/job/1 for\u0007 detail",
    "",
    "   ",
  ].join("\r\n"));
  assert.equal(normalized, [
    "- [redacted: looked like a credential]",
    "- [minor] see [link] for detail",
  ].join("\n"));
  assert.equal(normalizeAmuxV52FindingsSummary("   \n  "), null);
  assert.equal(normalizeAmuxV52FindingsSummary(42), null);
  const long = normalizeAmuxV52FindingsSummary(
    Array.from({ length: 40 }, (_, index) => `- ${index} ${"y".repeat(500)}`).join("\n"));
  assert.ok(long.length <= AMUX_V52_FINDINGS_SUMMARY_MAX_CHARS);
  assert.ok(long.split("\n").length <= AMUX_V52_FINDINGS_SUMMARY_MAX_LINES);
});

test("the owner view is a summary, the review job for an older record, or nothing", () => {
  assert.deepEqual(amuxV52RejectionView({ verdict: "reject", jobId: "r-20261113-111120-93735a",
    reviewerVendors: ["openai"], findingsSummary: "- [major] a\n- [minor] b" }),
  { kind: "summary", lines: ["- [major] a", "- [minor] b"],
    jobId: "r-20261113-111120-93735a", reviewerVendors: ["openai"] });
  assert.deepEqual(amuxV52RejectionView({ verdict: "reject", jobId: "r-20261113-111543-cca3be",
    reviewerVendors: [], findingsSummary: null }),
  { kind: "job", jobId: "r-20261113-111543-cca3be", reviewerVendors: [] });
  assert.equal(amuxV52RejectionView({ verdict: "reject", jobId: "not-a-job",
    reviewerVendors: [], findingsSummary: null })?.kind, "none");
  assert.equal(amuxV52RejectionView({ verdict: "accept", jobId: null }), null);
  assert.equal(amuxV52RejectionView(null), null);
});
