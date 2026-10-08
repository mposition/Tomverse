import assert from "node:assert/strict";
import test from "node:test";

import { readAmuxV22PrCreationOutcome } from
  "../lib/amux/v22ExternalReadback.ts";

const branch = "agent/engineering/run-1";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const input = { branch, baseSha, headSha };
const pr = { number: 41,
  base: { ref: "develop", sha: baseSha,
    repo: { full_name: "mposition/Tomverse" } },
  head: { ref: branch, sha: headSha,
    repo: { full_name: "mposition/Tomverse" } } };

test("GitHub PR readback is exact, read-only and uses a separate token", async () => {
  const previous = process.env.AMUX_REVIEW_GITHUB_READ_TOKEN;
  process.env.AMUX_REVIEW_GITHUB_READ_TOKEN = "synthetic-read-token";
  try {
    let calls = 0;
    const fetchImpl = async (url, options) => {
      calls += 1;
      assert.equal(url.origin, "https://api.github.com");
      assert.equal(url.searchParams.get("head"), `mposition:${branch}`);
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer synthetic-read-token");
      return Response.json([pr]);
    };
    assert.deepEqual(await readAmuxV22PrCreationOutcome(input, fetchImpl),
      { status: "confirmed", reference: "41" });
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.AMUX_REVIEW_GITHUB_READ_TOKEN;
    else process.env.AMUX_REVIEW_GITHUB_READ_TOKEN = previous;
  }
});

test("no row, drift, duplicate or incomplete GitHub page never authorizes retry", async () => {
  const previous = process.env.AMUX_REVIEW_GITHUB_READ_TOKEN;
  process.env.AMUX_REVIEW_GITHUB_READ_TOKEN = "synthetic-read-token";
  try {
    for (const rows of [[], [{ ...pr, head: { ...pr.head, sha: baseSha } }],
      [pr, pr], [{ ...pr, base: { ...pr.base,
        repo: { full_name: "other/repo" } } }]]) {
      const result = await readAmuxV22PrCreationOutcome(input,
        async () => Response.json(rows));
      assert.equal(result.status, "outcome_unknown");
    }
    const paged = await readAmuxV22PrCreationOutcome(input,
      async () => Response.json([pr], { headers: {
        link: '<https://api.github.com/next>; rel="next"',
      } }));
    assert.equal(paged.status, "outcome_unknown");
  } finally {
    if (previous === undefined) delete process.env.AMUX_REVIEW_GITHUB_READ_TOKEN;
    else process.env.AMUX_REVIEW_GITHUB_READ_TOKEN = previous;
  }
});

test("unconfigured token and invalid branch do not send a request", async () => {
  const previous = process.env.AMUX_REVIEW_GITHUB_READ_TOKEN;
  delete process.env.AMUX_REVIEW_GITHUB_READ_TOKEN;
  try {
    let called = false;
    const fetchImpl = async () => { called = true; throw new Error("unexpected"); };
    assert.equal((await readAmuxV22PrCreationOutcome(input, fetchImpl)).status,
      "outcome_unknown");
    assert.equal((await readAmuxV22PrCreationOutcome({ ...input,
      branch: "../main" }, fetchImpl)).status, "outcome_unknown");
    assert.equal(called, false);
  } finally {
    if (previous !== undefined) process.env.AMUX_REVIEW_GITHUB_READ_TOKEN = previous;
  }
});
