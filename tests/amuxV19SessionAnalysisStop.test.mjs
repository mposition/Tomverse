import assert from "node:assert/strict";
import test from "node:test";

import { shouldAmuxSessionAnalysisStop } from
  "../lib/amux/ideaSessionAnalysisStopRead.ts";
import { shouldStopAmuxV19SessionAnalysis } from
  "../lib/amux/ideaLocalSessionAnalysisStopPoll.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";

const now = new Date("2026-10-18T00:00:00.000Z");
const claimId = "00000000-0000-4000-8000-000000000001";
const reservationId = "00000000-0000-4000-8000-000000000002";
const origin = "https://tomverse.example/";
const agentSecret = "v19_session_stop_012345678901234567890123456789";
const active = { namespace: "agent/amux-intake", claimStatus: "in_flight",
  closedAt: null, resolutionAuditLogId: null, reservationStatus: "queued",
  operatingScopeSettingId: "scope_1", latestScopeId: "scope_1",
  submissionOrigin: "session", ideaState: "submitted",
  cancelledAt: null, analysisCompletedAt: null,
  analysisDeadlineAt: new Date(now.getTime() + 1), rawAvailable: true,
  provenanceAvailable: true, rawPurgedAt: null, now };

test("session stop decision loses permission on cancellation, expiry and claim changes", () => {
  assert.equal(shouldAmuxSessionAnalysisStop(active), false);
  assert.equal(shouldAmuxSessionAnalysisStop({ ...active,
    ideaState: "analyzing" }), false);
  for (const change of [
    { namespace: "other" }, { claimStatus: "outcome_unknown" },
    { closedAt: now }, { resolutionAuditLogId: "audit_1" },
    { reservationStatus: "cancelled" }, { latestScopeId: "scope_2" },
    { submissionOrigin: "admin" },
    { ideaState: "registered" }, { cancelledAt: now },
    { analysisCompletedAt: now }, { analysisDeadlineAt: now },
    { rawAvailable: false }, { provenanceAvailable: false },
    { rawPurgedAt: now },
  ]) assert.equal(shouldAmuxSessionAnalysisStop({ ...active, ...change }), true,
    `must stop after ${Object.keys(change)[0]}`);
});

test("session stop client accepts only exact pinned continue receipt", async () => {
  const prior = process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
  process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
  const base = { origin, claimId, reservationId, agentSecret };
  const reply = { claimId, reservationId, stop: false };
  try {
    let requested;
    assert.equal(await shouldStopAmuxV19SessionAnalysis({ ...base,
      fetchImpl: async (url, options) => {
        requested = { url, options }; return Response.json(reply);
      } }), false);
    assert.equal(requested.url,
      `https://tomverse.example/api/internal/amux/v19/session-analysis-stop?claimId=${claimId}&reservationId=${reservationId}`);
    assert.equal(requested.options.redirect, "manual");
    assert.equal(requested.options.headers.authorization, `Bearer ${agentSecret}`);
    for (const response of [Response.json({ ...reply, stop: true }),
      Response.json({ ...reply, claimId: reservationId }),
      Response.json({ ...reply, prompt: "leak" }),
      Response.json(reply, { status: 409 }),
      new Response(null, { status: 302,
        headers: { location: "https://other.example/" } })]) {
      assert.equal(await shouldStopAmuxV19SessionAnalysis({ ...base,
        fetchImpl: async () => response }), true);
    }
    assert.equal(await shouldStopAmuxV19SessionAnalysis({ ...base,
      origin: "https://other.example/", fetchImpl: async () => {
        throw new Error("must not fetch");
      } }), true);
  } finally {
    if (prior === undefined) delete process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
    else process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = prior;
  }
});

test("session stop route admits exact IDs and denies unauthorised or malformed polls", async () => {
  const imported = await import(
    "../app/api/internal/amux/v19/session-analysis-stop/route.ts");
  const GET = imported.GET ?? imported.default.GET;
  const secretKey = "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET";
  const readKey = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ";
  const syncKey = "TOMVERSE_AMUX_SYNC_SECRET";
  const previous = [secretKey, readKey, syncKey].map((key) =>
    [key, process.env[key]]);
  const endpoint = "https://tomverse.example/api/internal/amux/v19/session-analysis-stop";
  const headers = { authorization: `Bearer ${agentSecret}`,
    "x-amux-agent-id": "amux-intake" };
  const request = (query, selectedHeaders = headers) =>
    new Request(`${endpoint}${query}`, { headers: selectedHeaders });
  try {
    process.env[secretKey] = agentSecret;
    delete process.env[readKey];
    delete process.env[syncKey];
    const query = `?claimId=${claimId}&reservationId=${reservationId}`;
    assert.equal((await GET(request(query, {}))).status, 401);
    const dark = await GET(request(query));
    assert.equal(dark.status, 409);
    assert.match(dark.headers.get("cache-control") ?? "", /no-store/);
    process.env[readKey] = "enabled";
    for (const bad of ["", `?claimId=${claimId}`,
      `?claimId=${claimId}&reservationId=bad/id`,
      `?claimId=${claimId}&claimId=${claimId}&reservationId=${reservationId}`,
      `${query}&extra=1`]) {
      const response = await GET(request(bad));
      assert.equal(response.status, 400, bad);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
    const prismaModule = await import("../lib/prisma.ts");
    const prisma = prismaModule.prisma ?? prismaModule.default.prisma;
    const transaction = prisma.$transaction;
    let dbCalls = 0;
    try {
      prisma.$transaction = async () => {
        dbCalls += 1;
        return { claimId, reservationId, stop: false };
      };
      const valid = await GET(request(query));
      assert.equal(valid.status, 200);
      assert.deepEqual(await valid.json(), { claimId, reservationId, stop: false });
      assert.equal(dbCalls, 1);
    } finally {
      prisma.$transaction = transaction;
    }
    process.env[syncKey] = agentSecret;
    assert.equal((await GET(request(query))).status, 401);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
