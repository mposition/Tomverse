import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AMUX_REVIEW_MAX_DIFF_BYTES,
  AmuxReviewGitHubError,
  readAmuxReviewPullRequest,
} from "../lib/amux/reviewGitHub.ts";
import { pullChangeDigest } from "../lib/pullDiffDigestCore.ts";

const PR_NUMBER = 123;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const TREE = "e".repeat(40);
const DIFF = "diff --git a/example.txt b/example.txt\nindex 123..456 100644\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n";
const CHANGE = pullChangeDigest({ mergeBaseSha: MERGE_BASE, headSha: SHA_B, headTreeSha: TREE });
const API = "https://api.github.com/repos/mposition/Tomverse";

function pullRequest(overrides = {}) {
  return {
    number: PR_NUMBER,
    state: "open",
    merged: false,
    base: { ref: "develop", sha: SHA_A, repo: { full_name: "mposition/Tomverse" } },
    head: { sha: SHA_B, repo: { full_name: "mposition/Tomverse" } },
    ...overrides,
  };
}

const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

/** The reads in order: the PR, the change digest's compare and head commit, the diff, the PR again. */
function githubResponses(first = pullRequest(), diff = DIFF, last = first,
  { compare = { status: "ahead", merge_base_commit: { sha: MERGE_BASE } }, commit = { sha: SHA_B, tree: { sha: TREE } } } = {}) {
  const values = [
    json(first),
    json(compare),
    json(commit),
    diff instanceof Response ? diff : new Response(diff, { headers: { "Content-Type": "text/plain" } }),
    json(last),
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const response = values.shift();
    assert.ok(response, "unexpected GitHub request");
    return response;
  };
  return { fetchImpl, calls };
}

function withToken(t, value = "read-only-test-token") {
  const before = process.env.AMUX_REVIEW_GITHUB_READ_TOKEN;
  if (value === null) delete process.env.AMUX_REVIEW_GITHUB_READ_TOKEN;
  else process.env.AMUX_REVIEW_GITHUB_READ_TOKEN = value;
  t.after(() => {
    if (before === undefined) delete process.env.AMUX_REVIEW_GITHUB_READ_TOKEN;
    else process.env.AMUX_REVIEW_GITHUB_READ_TOKEN = before;
  });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof AmuxReviewGitHubError && error.code === code);
}

test("missing review-specific token and invalid PR numbers fail before network", async (t) => {
  withToken(t, null);
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("must not fetch"); };
  await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, fetchImpl), "not_configured");
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, "123", "https://evil.test"]){
    await rejectsCode(readAmuxReviewPullRequest(number, fetchImpl), "invalid_pr_number");
  }
  assert.equal(calls, 0);
});

test("success pins one same-repo develop PR, reads only GET, binds the change digest and shows the diff", async (t) => {
  withToken(t);
  const { fetchImpl, calls } = githubResponses();
  const result = await readAmuxReviewPullRequest(PR_NUMBER, fetchImpl);
  assert.deepEqual(result, {
    prNumber: PR_NUMBER,
    baseSha: SHA_A,
    headSha: SHA_B,
    changeDigest: CHANGE,
    diffDigest: createHash("sha256").update(DIFF).digest("hex"),
    diffText: DIFF,
    diffHidden: null,
    htmlUrl: `https://github.com/mposition/Tomverse/pull/${PR_NUMBER}`,
  });
  assert.deepEqual(calls.map((call) => call.url), [
    `${API}/pulls/${PR_NUMBER}`,
    `${API}/compare/develop...${SHA_B}?per_page=1&page=1`,
    `${API}/git/commits/${SHA_B}`,
    `${API}/pulls/${PR_NUMBER}`,
    `${API}/pulls/${PR_NUMBER}`,
  ]);
  for (const call of calls) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.headers.Authorization, "Bearer read-only-test-token");
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.deepEqual(calls.map((call) => call.init.headers.Accept), [
    "application/vnd.github+json",
    "application/vnd.github+json",
    "application/vnd.github+json",
    "application/vnd.github.diff",
    "application/vnd.github+json",
  ]);
});

test("wrong repository, fork, base, closed or merged PRs are refused before any other read", async (t) => {
  withToken(t);
  const cases = [
    pullRequest({ base: { ref: "develop", sha: SHA_A, repo: { full_name: "other/repo" } } }),
    pullRequest({ head: { sha: SHA_B, repo: { full_name: "fork/Tomverse" } } }),
    pullRequest({ base: { ref: "main", sha: SHA_A, repo: { full_name: "mposition/Tomverse" } } }),
    pullRequest({ state: "closed" }),
    pullRequest({ merged: true }),
    pullRequest({ number: 999 }),
    pullRequest({ head: { sha: "not-a-sha", repo: { full_name: "mposition/Tomverse" } } }),
  ];
  for (const pr of cases) {
    const { fetchImpl, calls } = githubResponses(pr);
    await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, fetchImpl), "wrong_pr");
    assert.equal(calls.length, 1);
  }
});

test("head or base movement after the reads fails closed", async (t) => {
  withToken(t);
  const movedHead = githubResponses(pullRequest(), DIFF, pullRequest({ head: {
    sha: SHA_A, repo: { full_name: "mposition/Tomverse" },
  } }));
  await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, movedHead.fetchImpl), "pr_changed");
  assert.equal(movedHead.calls.length, 5);
  const movedBase = githubResponses(pullRequest(), DIFF, pullRequest({ base: {
    ref: "develop", sha: SHA_B, repo: { full_name: "mposition/Tomverse" },
  } }));
  await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, movedBase.fetchImpl), "pr_changed");
  assert.equal(movedBase.calls.length, 5);
});

test("a change digest that cannot be read is no artifact", async (t) => {
  withToken(t);
  for (const options of [{ compare: { status: "ahead", merge_base_commit: { sha: "x" } } },
    { commit: { sha: SHA_A, tree: { sha: TREE } } }, { commit: { sha: SHA_B } }]) {
    const { fetchImpl } = githubResponses(pullRequest(), DIFF, pullRequest(), options);
    await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, fetchImpl), "invalid_response");
  }
});

test("an oversized or binary diff is not shown, and still binds by its change digest (owner decision 2026-11-18)", async (t) => {
  withToken(t);
  const hiddenAs = async (diff, reason) => {
    const { fetchImpl, calls } = githubResponses(pullRequest(), diff);
    const result = await readAmuxReviewPullRequest(PR_NUMBER, fetchImpl);
    assert.equal(calls.length, 5);
    assert.deepEqual([result.changeDigest, result.diffText, result.diffDigest, result.diffHidden], [CHANGE, null, null, reason]);
  };
  await hiddenAs(new Response("x".repeat(AMUX_REVIEW_MAX_DIFF_BYTES + 1)), "oversized");
  // GitHub's own answer for a diff too large to render.
  await hiddenAs(new Response("too large", { status: 406 }), "oversized");
  for (const content of [new Uint8Array([0xff, 0xfe]), `diff --git a/a b/a\n\0`, "diff --git a/a b/a\nGIT binary patch\n",
    "diff --git a/a b/a\nBinary files a/a and b/a differ\n"]) {
    await hiddenAs(content, "binary");
  }
  const jsonDiff = githubResponses(pullRequest(), json({ message: "ignored Accept" }));
  await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, jsonDiff.fetchImpl), "invalid_response");
});

test("visually unsafe diff controls are never shown; the approval binds the change digest instead", async (t) => {
  withToken(t);
  for (const control of ["\u001b", "\u061C", "\u202E", "\u2067", "\u200F"]) {
    const response = githubResponses(pullRequest(), `${DIFF}+hidden${control}reordered\n`);
    const result = await readAmuxReviewPullRequest(PR_NUMBER, response.fetchImpl);
    assert.deepEqual([result.diffText, result.diffDigest, result.diffHidden, result.changeDigest],
      [null, null, "unsafe_display", CHANGE]);
  }
});

test("upstream network errors never expose their original message", async (t) => {
  withToken(t);
  await assert.rejects(
    readAmuxReviewPullRequest(PR_NUMBER, async () => { throw new Error("private upstream detail"); }),
    (error) => error instanceof AmuxReviewGitHubError &&
      error.code === "transport_error" && !error.message.includes("private"),
  );
});
