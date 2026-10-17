import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reviewFindings, reviewStep } from "../scripts/amux-v52-review-runner.mjs";

const input = { attemptId: "4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f",
  baseSha: "a".repeat(40), commitSha: "b".repeat(40),
  reviewRef: "refs/amux-v52-review/4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f",
  author: "claude", authorVendor: "anthropic",
  scope: "Title: Fix bug\nCompletion criteria:\n- Covered",
  touchesContract: false };

function fixture(run) {
  const stateDir = mkdtempSync(join(tmpdir(), "amux-v52-review-"));
  return { options: { stateDir, worktree: stateDir,
    client: join(stateDir, "review.mjs"), uid: statSync(stateDir).uid,
    prepareRepository: () => stateDir, run },
  cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test("one submission stays pending and then records independent acceptance", () => {
  let submits = 0;
  let statuses = 0;
  const jobId = "r-20261016-110000-abcdef";
  const { options, cleanup } = fixture((_program, args) => {
    if (args.includes("submit")) {
      submits += 1;
      assert.equal(args.includes("--base"), false);
      assert.deepEqual(args.slice(4, 6), ["--author-vendor", input.authorVendor]);
      assert.deepEqual(args.slice(-4), ["--head", input.commitSha,
        "--head-ref", input.reviewRef]);
      return { code: 3, stdout: JSON.stringify({ jobId }) };
    }
    statuses += 1;
    return { code: statuses === 1 ? 3 : 0, stdout: JSON.stringify({ jobId,
      base: input.baseSha, head: input.commitSha,
      author: input.author, repo: "tomverse",
      authorVendor: input.authorVendor, touchesContract: false,
      status: statuses === 1 ? "pending" : "accept",
      reviews: statuses === 1 ? [] : [{ vendor: "openai" }] }) };
  });
  try {
    assert.deepEqual(reviewStep(input, options), { kind: "pending", jobId });
    assert.deepEqual(reviewStep(input, options), { kind: "pending", jobId });
    assert.equal(reviewStep(input, options).evidence.verdict, "accept");
    assert.equal(reviewStep(input, options).evidence.verdict, "accept");
    assert.equal(submits, 1);
    assert.equal(statuses, 2);
  } finally { cleanup(); }
});

test("ambiguous submit records unknown and never submits again", () => {
  let submits = 0;
  const { options, cleanup } = fixture(() => {
    submits += 1;
    return { code: 65, stdout: "" };
  });
  try {
    assert.equal(reviewStep(input, options).evidence.verdict, "unknown");
    assert.equal(reviewStep(input, options).evidence.verdict, "unknown");
    assert.equal(submits, 1);
  } finally { cleanup(); }
});

test("a known job survives transient status failure without resubmission", () => {
  let submits = 0;
  let statuses = 0;
  const jobId = "r-20261016-110005-abcdef";
  const { options, cleanup } = fixture((_program, args) => {
    if (args.includes("submit")) {
      submits += 1;
      return { code: 3, stdout: JSON.stringify({ jobId }) };
    }
    statuses += 1;
    return statuses === 1 ? { code: 65, stdout: "" } :
      { code: 0, stdout: JSON.stringify({ jobId, base: input.baseSha,
        head: input.commitSha, author: input.author, repo: "tomverse",
        authorVendor: input.authorVendor, touchesContract: false,
        status: "accept", reviews: [{ vendor: "openai" }] }) };
  });
  try {
    assert.deepEqual(reviewStep(input, options), { kind: "pending", jobId });
    assert.deepEqual(reviewStep(input, options), { kind: "pending", jobId });
    assert.equal(reviewStep(input, options).evidence.verdict, "accept");
    assert.equal(submits, 1);
  } finally { cleanup(); }
});

test("three failed reads of a known job end unknown without resubmission", () => {
  let submits = 0;
  const jobId = "r-20261016-110006-abcdef";
  const { options, cleanup } = fixture((_program, args) => {
    if (args.includes("submit")) {
      submits += 1;
      return { code: 3, stdout: JSON.stringify({ jobId }) };
    }
    return { code: 65, stdout: "" };
  });
  try {
    assert.equal(reviewStep(input, options).kind, "pending");
    assert.equal(reviewStep(input, options).kind, "pending");
    assert.equal(reviewStep(input, options).kind, "pending");
    assert.equal(reviewStep(input, options).evidence.verdict, "unknown");
    assert.equal(submits, 1);
  } finally { cleanup(); }
});

test("contract acceptance requires two other reviewer vendors", () => {
  const contract = { ...input, touchesContract: true };
  const jobId = "r-20261016-110001-abcdef";
  const { options, cleanup } = fixture((_program, args) => {
    if (args.includes("submit")) {
      assert.deepEqual(args.slice(-2), ["--reviewers", "2"]);
      return { code: 3, stdout: JSON.stringify({ jobId }) };
    }
    return { code: 0, stdout: JSON.stringify({ jobId,
      base: input.baseSha, head: input.commitSha,
      author: input.author, repo: "tomverse",
      authorVendor: input.authorVendor, touchesContract: true,
      status: "accept", reviews: [{ vendor: "openai" }] }) };
  });
  try {
    assert.equal(reviewStep(contract, options).kind, "pending");
    assert.equal(reviewStep(contract, options).evidence.verdict, "unknown");
  }
  finally { cleanup(); }
});

test("AMUX contract classification accepts two vendors even when server paths differ", () => {
  const contract = { ...input, touchesContract: true };
  const jobId = "r-20261016-110003-abcdef";
  const { options, cleanup } = fixture((_program, args) => {
    if (args.includes("submit")) return { code: 3,
      stdout: JSON.stringify({ jobId }) };
    return { code: 0, stdout: JSON.stringify({ jobId,
      base: input.baseSha, head: input.commitSha,
      author: input.author, repo: "tomverse",
      authorVendor: input.authorVendor, touchesContract: false,
      status: "accept", reviews: [{ vendor: "openai" },
        { vendor: "moonshot" }] }) };
  });
  try {
    assert.equal(reviewStep(contract, options).kind, "pending");
    assert.equal(reviewStep(contract, options).evidence.verdict, "accept");
  } finally { cleanup(); }
});

test("prior reject findings are read from the review server", () => {
  const jobId = "r-20261016-110002-abcdef";
  const { options, cleanup } = fixture((_program, args) => args.includes("status") ?
    { code: 1, stdout: JSON.stringify({ jobId, status: "reject",
      reviews: [{ slot: 0, verdict: "reject" },
        { slot: 1, verdict: "accept" }] }) } :
    { code: 0, stdout: "Fix the edge case." });
  try { assert.equal(reviewFindings(jobId, options), "Fix the edge case."); }
  finally { cleanup(); }
});

test("review findings cap the number of remote report reads", () => {
  const jobId = "r-20261016-110004-abcdef";
  const { options, cleanup } = fixture((_program, args) => {
    assert.ok(args.includes("status"));
    return { code: 1, stdout: JSON.stringify({ jobId, status: "reject",
      reviews: Array.from({ length: 5 }, (_, slot) =>
        ({ slot, verdict: "reject" })) }) };
  });
  try {
    assert.throws(() => reviewFindings(jobId, options),
      /review findings unavailable/);
  } finally { cleanup(); }
});
