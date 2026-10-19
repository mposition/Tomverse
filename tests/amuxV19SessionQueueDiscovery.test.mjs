import assert from "node:assert/strict";
import { after, test } from "node:test";

import { discoverAmuxV19SessionAnalysisOnce } from
  "../lib/amux/ideaLocalSessionAnalysisQueueDiscovery.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";

const origin = "https://tomverse.test";
const secret = "a".repeat(32);
const reservationId = "ec61a12d-d02a-478f-a499-aea9dd752270";
const ideaId = "idea:session-123";
const expiresAt = "2026-10-18T00:00:00.000Z";
const previousOrigin = process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
after(() => {
  if (previousOrigin === undefined)
    delete process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
  else process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = previousOrigin;
});

test("the v19 queue discovery reads once and selects an approved model", async () => {
  process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ candidates: [
      { reservationId, ideaId, modelId: "unsupported-model", expiresAt,
        nextInvocationOrdinal: 0 },
      { reservationId: "96c7e280-6cb1-4a9a-b677-a25293488c46",
        ideaId, modelId: "claude-opus-5-5", expiresAt,
        nextInvocationOrdinal: 0 },
    ], hasMore: false, nextCursor: null });
  };
  const result = await discoverAmuxV19SessionAnalysisOnce({
    origin, agentSecret: secret, fetchImpl,
  });
  assert.equal(result.kind, "discovered");
  assert.equal(result.candidate.modelId, "claude-opus-5-5");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url,
    `${origin}/api/internal/amux/v19/analysis-queue`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
});

test("no admitted model or disabled queue cannot proceed to an invocation", async () => {
  process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
  const base = { origin, agentSecret: secret };
  const unsupported = await discoverAmuxV19SessionAnalysisOnce({ ...base,
    fetchImpl: async () => Response.json({ candidates: [
      { reservationId, ideaId, modelId: "unsupported-model", expiresAt,
        nextInvocationOrdinal: 0 },
    ], hasMore: false, nextCursor: null }),
  });
  assert.deepEqual(unsupported, { kind: "catalog_unapproved" });
  const disabled = await discoverAmuxV19SessionAnalysisOnce({ ...base,
    fetchImpl: async () => new Response(null, { status: 409 }),
  });
  assert.deepEqual(disabled, { kind: "disabled" });
});

test("an approved candidate on a later page is discovered without a claim", async () => {
  process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
  const bodies = [];
  const firstPage = Array.from({ length: 32 }, (_, index) => ({
    reservationId: `ec61a12d-d02a-478f-a499-${String(index).padStart(12, "0")}`,
    ideaId, modelId: "unsupported-model", expiresAt,
    nextInvocationOrdinal: 0,
  }));
  const result = await discoverAmuxV19SessionAnalysisOnce({
    origin, agentSecret: secret,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Response.json(bodies.length === 1
        ? { candidates: firstPage, hasMore: true, nextCursor: "page2" }
        : { candidates: [{ reservationId, ideaId,
          modelId: "claude-opus-5-5", expiresAt,
          nextInvocationOrdinal: 0 }],
          hasMore: false, nextCursor: null });
    },
  });
  assert.equal(result.kind, "discovered");
  assert.equal(result.candidate.reservationId, reservationId);
  assert.deepEqual(bodies, [{}, { after: "page2" }]);
});

test("a repeated cursor stops queue discovery", async () => {
  process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
  let calls = 0;
  const result = await discoverAmuxV19SessionAnalysisOnce({
    origin, agentSecret: secret,
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ candidates: Array.from({ length: 32 },
        () => ({ reservationId, ideaId,
          modelId: "unsupported-model", expiresAt,
          nextInvocationOrdinal: 0 })),
        hasMore: true, nextCursor: "same-page" });
    },
  });
  assert.deepEqual(result, { kind: "unavailable" });
  assert.equal(calls, 2);
});

test("fresh cursors end a bounded attempt with a continuation", async () => {
  process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ candidates: Array.from({ length: 32 },
      () => ({ reservationId, ideaId,
        modelId: "unsupported-model", expiresAt,
        nextInvocationOrdinal: 0 })),
      hasMore: true, nextCursor: `page-${calls}` });
  };
  const result = await discoverAmuxV19SessionAnalysisOnce({
    origin, agentSecret: secret, fetchImpl,
  });
  assert.deepEqual(result, { kind: "more_unexamined", after: "page-8" });
  assert.equal(calls, 8);
});
