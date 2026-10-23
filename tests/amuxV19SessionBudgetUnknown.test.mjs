import assert from "node:assert/strict";
import test from "node:test";

const claimId = "00000000-0000-4000-8000-000000000001";
const reservationId = "00000000-0000-4000-8000-000000000002";
const ideaId = "00000000-0000-4000-8000-000000000003";
const requestId = "00000000-0000-4000-8000-000000000004";
const agentSecret = "v19_session_unknown_012345678901234567890123456789";
const endpoint = "https://tomverse.example/api/internal/amux/v19/analysis-budget/unknown";
const body = { claimId, reservationId, ideaId, requestId,
  invocationOrdinal: 0, outcome: "outcome_unknown",
  inputTokens: null, outputTokens: null };

test("v19 unknown outcome write is authenticated, default-off and unknown-only", async () => {
  const imported = await import(
    "../app/api/internal/amux/v19/analysis-budget/unknown/route.ts");
  const POST = imported.POST ?? imported.default.POST;
  const secretKey = "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET";
  const writeKey = "TOMVERSE_AMUX_V19_SESSION_BUDGET_UNKNOWN_WRITE";
  const readKey = "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ";
  const syncKey = "TOMVERSE_AMUX_SYNC_SECRET";
  const previous = [secretKey, writeKey, readKey, syncKey]
    .map((key) => [key, process.env[key]]);
  const headers = { authorization: `Bearer ${agentSecret}`,
    "x-amux-agent-id": "amux-intake", "content-type": "application/json" };
  const request = (value, selectedHeaders = headers) => new Request(endpoint, {
    method: "POST", headers: selectedHeaders, body: JSON.stringify(value),
  });
  try {
    process.env[secretKey] = agentSecret;
    delete process.env[writeKey];
    delete process.env[readKey];
    delete process.env[syncKey];
    assert.equal((await POST(request(body, { "content-type": "application/json" }))).status, 401);
    const dark = await POST(request(body));
    assert.equal(dark.status, 409);
    assert.match(dark.headers.get("cache-control") ?? "", /no-store/);
    process.env[writeKey] = "enabled";
    assert.equal((await POST(request(body))).status, 409);
    process.env[readKey] = "enabled";
    for (const invalid of [
      { ...body, ideaId: reservationId, outcome: "verified_success" },
      { ...body, inputTokens: 0 },
      { ...body, claimId: "wrong" },
      { ...body, extra: "raw output" },
    ]) assert.equal((await POST(request(invalid))).status, 400);
    const prismaModule = await import("../lib/prisma.ts");
    const prisma = prismaModule.prisma ?? prismaModule.default.prisma;
    const transaction = prisma.$transaction;
    let calls = 0;
    try {
      prisma.$transaction = async () => {
        calls += 1;
        return { claimId, status: "outcome_unknown",
          settledMicroUsd: null, auditId: "audit_1" };
      };
      const response = await POST(request(body));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "outcome_unknown");
      assert.equal(calls, 1);
    } finally { prisma.$transaction = transaction; }
    process.env[syncKey] = agentSecret;
    assert.equal((await POST(request(body))).status, 401);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
