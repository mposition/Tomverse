import assert from "node:assert/strict";
import test from "node:test";

import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV,
  pollAmuxV19SessionAnalysisCandidateIds,
  pollAmuxV19MaxSessionAnalysisCandidateIds } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";
import { installAmuxV19FakeAppTiming } from "./support/amuxV19FakeAppTiming.mjs";

installAmuxV19FakeAppTiming();
const origin = "https://staging.tomverse.example/";
const secret = "local_v19_session_012345678901234567890123456";
const candidate = (index) => ({
  reservationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  ideaId: `idea_${index}`,
  provider: ["anthropic", "openai", "github-copilot", "cursor"][index % 4],
  modelId: "frontier-model",
  expiresAt: "2026-10-18T00:00:00.000Z",
  nextInvocationOrdinal: 0,
});
const page = { candidates: Array.from({ length: 32 }, (_, index) => candidate(index)),
  hasMore: true, nextCursor: "next_page_1" };

test("Max queue poll sends only its dedicated launcher credential", async () => {
  const originKey = AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV;
  const maxKey = "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET";
  const priorOrigin = process.env[originKey];
  const priorMax = process.env[maxKey];
  const maxSecret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
  try {
    process.env[originKey] = origin;
    delete process.env[maxKey];
    let calls = 0;
    assert.deepEqual(await pollAmuxV19MaxSessionAnalysisCandidateIds({ origin,
      fetchImpl: async () => { calls++; return Response.json(page); },
    }), { kind: "refused" });
    assert.equal(calls, 0);
    process.env[maxKey] = maxSecret;
    const result = await pollAmuxV19MaxSessionAnalysisCandidateIds({ origin,
      fetchImpl: async (_url, options) => {
        calls++;
        assert.equal(options.headers.authorization, `Bearer ${maxSecret}`);
        assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
        return Response.json({ candidates: [candidate(0)],
          hasMore: false, nextCursor: null });
      },
    });
    assert.deepEqual(result, { kind: "candidates",
      candidates: [candidate(0)], hasMore: false, nextCursor: null });
    assert.equal(calls, 1);
  } finally {
    if (priorOrigin === undefined) delete process.env[originKey];
    else process.env[originKey] = priorOrigin;
    if (priorMax === undefined) delete process.env[maxKey];
    else process.env[maxKey] = priorMax;
  }
});
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
    assert.equal(observed.options.headers.authorization, ["Bearer", secret].join(" "));
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
    const credentialed = new URL(origin);
    credentialed.username = "user";
    credentialed.password = "pass";
    for (const badOrigin of ["http://staging.tomverse.example/",
      "https://staging.tomverse.example/path",
      credentialed.toString(),
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
    const invalid = { kind: "unavailable", reason: "response_invalid" };
    assert.deepEqual(await poll({ fetchImpl: async () => new Response(null,
      { status: 302, headers: { location: "https://other.example/" } }) }),
    invalid);
    const redirected = Response.json(page);
    Object.defineProperty(redirected, "url", { value: "https://other.example/" });
    assert.deepEqual(await poll({ fetchImpl: async () => redirected }), invalid);
    assert.deepEqual(await poll({ fetchImpl: async () => new Response(null, { status: 409 }) }),
      { kind: "disabled" });
    assert.deepEqual(await poll({ after: "stale_cursor", fetchImpl: async () =>
      new Response(null, { status: 400 }) }), { kind: "cursor_rejected" });
    // A read-only poll is asked again through a lost answer, then gives up.
    let lost = 0;
    assert.deepEqual(await poll({ fetchImpl: async () => {
      lost += 1;
      throw Error("sensitive transport");
    } }), { kind: "unavailable", reason: "read_unreachable" });
    assert.ok(lost > 1);
    for (const body of [
      { ...page, prompt: "never pass text" },
      { ...page, candidates: [{ ...candidate(0), prompt: "bad" },
        ...page.candidates.slice(1)] },
      { ...page, candidates: [{ ...candidate(0), reservationId: "bad/id" },
        ...page.candidates.slice(1)] },
      // Every candidate names one of the four subscription CLI channels.
      { ...page, candidates: [{ ...candidate(0), provider: "gemini" },
        ...page.candidates.slice(1)] },
      { ...page, candidates: [Object.fromEntries(Object.entries(candidate(0))
        .filter(([key]) => key !== "provider")), ...page.candidates.slice(1)] },
      { ...page, candidates: [{ ...candidate(0), nextInvocationOrdinal: -1 },
        ...page.candidates.slice(1)] },
      { ...page, candidates: [{ ...candidate(0), nextInvocationOrdinal: 2_147_483_648 },
        ...page.candidates.slice(1)] },
      { ...page, huge: "x".repeat(65_536) },
    ]) {
      assert.deepEqual(await poll({ fetchImpl: async () => Response.json(body) }),
        invalid);
    }
  } finally {
    if (prior === undefined) delete process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = prior;
  }
});
