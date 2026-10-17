import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV,
  pollAmuxV19SessionAnalysisCandidateIds } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";

const origin = "https://staging.tomverse.example/";
const secret = "local_v19_session_012345678901234567890123456";
const candidate = (index) => ({
  reservationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  ideaId: `idea_${index}`, modelId: "frontier-model",
  expiresAt: "2026-10-18T00:00:00.000Z",
});
const page = { candidates: Array.from({ length: 32 }, (_, index) => candidate(index)),
  hasMore: true, nextCursor: "next_page_1" };
const poll = (input) => pollAmuxV19SessionAnalysisCandidateIds({
  origin, agentSecret: secret, ...input,
});

test("local v19 Agent polls only reservation metadata using pinned origin", async () => {
  const prior = process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
  process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
  try {
    let observed;
    const result = await poll({ after: "previous_page_1", fetchImpl: async (url, options) => {
      observed = { url, options };
      return Response.json(page);
    } });
    assert.deepEqual(result, { kind: "candidates", ...page });
    assert.equal(observed.url,
      "https://staging.tomverse.example/api/internal/amux/v19/analysis-queue");
    assert.equal(observed.options.method, "POST");
    assert.equal(observed.options.redirect, "manual");
    assert.equal(observed.options.cache, "no-store");
    assert.equal(observed.options.headers["x-amux-agent-id"], "amux-intake");
    assert.equal(observed.options.headers.authorization, `Bearer ${secret}`);
    assert.equal(observed.options.body, JSON.stringify({ after: "previous_page_1" }));
  } finally {
    if (prior === undefined) delete process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = prior;
  }
});

test("local v19 poll refuses unpinned or non-HTTPS destinations before network", async () => {
  const prior = process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return Response.json(page); };
  try {
    delete process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
    assert.deepEqual(await poll({ fetchImpl }), { kind: "refused" });
    process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
    for (const badOrigin of ["http://staging.tomverse.example/",
      "https://staging.tomverse.example/path",
      "https://user:pass@staging.tomverse.example/",
      "https://staging.tomverse.example/?x=1",
      "https://other.example/"]) {
      assert.deepEqual(await poll({ origin: badOrigin, fetchImpl }), { kind: "refused" });
    }
    assert.deepEqual(await poll({ agentSecret: "short", fetchImpl }), { kind: "refused" });
    assert.deepEqual(await poll({ after: "bad/cursor", fetchImpl }), { kind: "refused" });
    assert.equal(calls, 0);
  } finally {
    if (prior === undefined) delete process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = prior;
  }
});

test("local v19 poll rejects redirects, unbounded or content-bearing responses", async () => {
  const prior = process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
  process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
  try {
    assert.deepEqual(await poll({ fetchImpl: async () => new Response(null,
      { status: 302, headers: { location: "https://other.example/" } }) }),
    { kind: "unavailable" });
    const redirected = Response.json(page);
    Object.defineProperty(redirected, "url", { value: "https://other.example/" });
    assert.deepEqual(await poll({ fetchImpl: async () => redirected }),
      { kind: "unavailable" });
    assert.deepEqual(await poll({ fetchImpl: async () => new Response(null, { status: 409 }) }),
      { kind: "disabled" });
    assert.deepEqual(await poll({ fetchImpl: async () => { throw Error("sensitive transport"); } }),
      { kind: "unavailable" });
    for (const body of [
      { ...page, prompt: "never pass text" },
      { ...page, candidates: [{ ...candidate(0), prompt: "bad" },
        ...page.candidates.slice(1)] },
      { ...page, candidates: [{ ...candidate(0), reservationId: "bad/id" },
        ...page.candidates.slice(1)] },
      { ...page, huge: "x".repeat(65_536) },
    ]) {
      assert.deepEqual(await poll({ fetchImpl: async () => Response.json(body) }),
        { kind: "unavailable" });
    }
  } finally {
    if (prior === undefined) delete process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = prior;
  }
});
