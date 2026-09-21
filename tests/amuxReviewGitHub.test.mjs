import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AMUX_REVIEW_MAX_DIFF_BYTES,
  AmuxReviewGitHubError,
  readAmuxReviewPullRequest,
} from "../lib/amux/reviewGitHub.ts";

const PR_NUMBER = 123;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIFF = "diff --git a/example.txt b/example.txt\nindex 123..456 100644\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-old\n+new\n";

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

function githubResponses(first = pullRequest(), diff = DIFF, last = first) {
  const values = [
    new Response(JSON.stringify(first), { headers: { "Content-Type": "application/json" } }),
    diff instanceof Response ? diff : new Response(diff, { headers: { "Content-Type": "text/plain" } }),
    new Response(JSON.stringify(last), { headers: { "Content-Type": "application/json" } }),
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

test("success pins one same-repo develop PR, reads only GET, and hashes bounded diff bytes", async (t) => {
  withToken(t);
  const { fetchImpl, calls } = githubResponses();
  const result = await readAmuxReviewPullRequest(PR_NUMBER, fetchImpl);
  assert.deepEqual(result, {
    prNumber: PR_NUMBER,
    baseSha: SHA_A,
    headSha: SHA_B,
    diffDigest: createHash("sha256").update(DIFF).digest("hex"),
    diffText: DIFF,
    htmlUrl: `https://github.com/mposition/Tomverse/pull/${PR_NUMBER}`,
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, `https://api.github.com/repos/mposition/Tomverse/pulls/${PR_NUMBER}`);
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.headers.Authorization, "Bearer read-only-test-token");
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.deepEqual(calls.map((call) => call.init.headers.Accept), [
    "application/vnd.github+json",
    "application/vnd.github.diff",
    "application/vnd.github+json",
  ]);
});

test("wrong repository, fork, base, closed or merged PRs are refused before diff read", async (t) => {
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

test("head or base movement after diff read fails closed", async (t) => {
  withToken(t);
  const movedHead = githubResponses(pullRequest(), DIFF, pullRequest({ head: {
    sha: SHA_A, repo: { full_name: "mposition/Tomverse" },
  } }));
  await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, movedHead.fetchImpl), "pr_changed");
  assert.equal(movedHead.calls.length, 3);
  const movedBase = githubResponses(pullRequest(), DIFF, pullRequest({ base: {
    ref: "develop", sha: SHA_B, repo: { full_name: "mposition/Tomverse" },
  } }));
  await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, movedBase.fetchImpl), "pr_changed");
  assert.equal(movedBase.calls.length, 3);
});

test("oversized, binary, malformed and JSON-instead-of-diff responses fail closed", async (t) => {
  withToken(t);
  const oversized = githubResponses(pullRequest(), new Response("x".repeat(AMUX_REVIEW_MAX_DIFF_BYTES + 1)));
  await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, oversized.fetchImpl), "oversized_response");
  assert.equal(oversized.calls.length, 2);
  for (const content of [new Uint8Array([0xff, 0xfe]), `diff --git a/a b/a\n\0`, "diff --git a/a b/a\nGIT binary patch\n", "diff --git a/a b/a\nBinary files a/a and b/a differ\n"]) {
    const result = githubResponses(pullRequest(), content);
    await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, result.fetchImpl), "binary_diff");
  }
  const json = githubResponses(pullRequest(), new Response(JSON.stringify({ message: "ignored Accept" }), {
    headers: { "Content-Type": "application/json" },
  }));
  await rejectsCode(readAmuxReviewPullRequest(PR_NUMBER, json.fetchImpl), "invalid_response");
});

test("upstream network errors never expose their original message", async (t) => {
  withToken(t);
  await assert.rejects(
    readAmuxReviewPullRequest(PR_NUMBER, async () => { throw new Error("private upstream detail"); }),
    (error) => error instanceof AmuxReviewGitHubError &&
      error.code === "transport_error" && !error.message.includes("private"),
  );
});
