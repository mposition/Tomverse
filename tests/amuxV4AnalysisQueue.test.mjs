import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AMUX_V4_ANALYSIS_AGENT_ID,
  AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  AMUX_V4_ANALYSIS_QUEUE_CODE_LATCH,
  AMUX_V4_ANALYSIS_QUEUE_READ_ENV,
  amuxV4AnalysisQueueReadEnabled,
  isAmuxV4AnalysisAgentAuthorized,
} from "../lib/amux/ideaAnalysisQueueCore.ts";
import { AMUX_V4_IDEA_AGENT_ID } from "../lib/amux/ideaIdentityCore.ts";
import {
  encodeAmuxV4AnalysisQueueCursor,
  parseAmuxV4AnalysisQueueCursor,
} from "../lib/amux/ideaAnalysisQueueCursorCore.ts";
import { buildAmuxV4AnalysisCandidateWhere } from "../lib/amux/ideaAnalysisQueueWhereCore.ts";

const secret = "v4_intake_only_012345678901234567890123456789";
const request = (token, agentId = AMUX_V4_ANALYSIS_AGENT_ID) => new Request(
  "https://tomverse.example/api/internal/amux/v4/analysis-queue", {
    method: "POST", headers: { authorization: `Bearer ${token}`,
      "x-amux-agent-id": agentId },
  });

test("AMUX v4 analysis queue uses a dedicated identity and stays dark", () => {
  assert.equal(AMUX_V4_ANALYSIS_AGENT_ID, AMUX_V4_IDEA_AGENT_ID);
  assert.equal(AMUX_V4_ANALYSIS_QUEUE_CODE_LATCH, false);
  assert.equal(amuxV4AnalysisQueueReadEnabled("enabled"), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret), secret), true);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret), secret, secret), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret, "amux-orchestrator"), secret), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request("wrong_".repeat(7)), secret), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret), undefined), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret), "short"), false);
});

test("AMUX v4 queue route refuses unauthenticated and dark-latch requests before DB", async () => {
  const imported = await import("../app/api/internal/amux/v4/analysis-queue/route.ts");
  const POST = imported.POST ?? imported.default.POST;
  const originalSecret = process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
  const originalRead = process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV];
  const originalSyncSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  try {
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = secret;
    process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV] = "enabled";
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const denied = await POST(new Request("https://tomverse.example/api/internal/amux/v4/analysis-queue",
      { method: "POST" }));
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
    assert.equal((await POST(request(secret, "amux-orchestrator"))).status, 401);
    process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
    assert.equal((await POST(request(secret))).status, 401);
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const dark = await POST(request(secret));
    assert.equal(dark.status, 409);
    assert.deepEqual(await dark.json(), { available: false, reason: "analysis_queue_disabled" });
  } finally {
    if (originalSecret === undefined) delete process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
    else process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = originalSecret;
    if (originalRead === undefined) delete process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV];
    else process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV] = originalRead;
    if (originalSyncSecret === undefined) delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = originalSyncSecret;
  }
});

test("AMUX v4 claim route stays dark even with its dedicated secret and write env", async () => {
  const imported = await import("../app/api/internal/amux/v4/analysis-claim/route.ts");
  const POST = imported.POST ?? imported.default.POST;
  const previousSecret = process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
  const previousWrite = process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE;
  const previousSync = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  try {
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = secret;
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE = "enabled";
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const endpoint = "https://tomverse.example/api/internal/amux/v4/analysis-claim";
    const body = JSON.stringify({ previewId: "preview_1" });
    const headers = { authorization: `Bearer ${secret}`,
      "x-amux-agent-id": AMUX_V4_ANALYSIS_AGENT_ID,
      "content-type": "application/json" };
    assert.equal((await POST(new Request(endpoint,
      { method: "POST", body }))).status, 401);
    const disabled = await POST(new Request(endpoint,
      { method: "POST", headers, body }));
    assert.equal(disabled.status, 409);
    assert.match(disabled.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(await disabled.json(),
      { available: false, reason: "analysis_claim_disabled" });
  } finally {
    if (previousSecret === undefined) delete process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
    else process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = previousSecret;
    if (previousWrite === undefined) delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE;
    else process.env.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_WRITE = previousWrite;
    if (previousSync === undefined) delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSync;
  }
});

test("AMUX v4 result write and read-back routes stay dark with the agent secret", async () => {
  const imported = await import("../app/api/internal/amux/v4/analysis-result/route.ts");
  const POST = imported.POST ?? imported.default.POST;
  const GET = imported.GET ?? imported.default.GET;
  const oldSecret = process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
  const oldWrite = process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE;
  const oldSync = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  try {
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = secret;
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE = "enabled";
    delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    const endpoint = "https://tomverse.example/api/internal/amux/v4/analysis-result";
    const headers = { authorization: `Bearer ${secret}`,
      "x-amux-agent-id": AMUX_V4_ANALYSIS_AGENT_ID,
      "content-type": "application/json" };
    assert.equal((await POST(new Request(endpoint, { method: "POST" }))).status, 401);
    const blockedWrite = await POST(new Request(endpoint,
      { method: "POST", headers, body: "{}" }));
    assert.equal(blockedWrite.status, 409);
    assert.deepEqual(await blockedWrite.json(),
      { available: false, reason: "analysis_result_disabled" });
    const blockedRead = await GET(new Request(`${endpoint}?requestId=r1&previewId=p1`,
      { headers }));
    assert.equal(blockedRead.status, 409);
    assert.match(blockedRead.headers.get("cache-control") ?? "", /no-store/);
  } finally {
    if (oldSecret === undefined) delete process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
    else process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = oldSecret;
    if (oldWrite === undefined) delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE;
    else process.env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE = oldWrite;
    if (oldSync === undefined) delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
    else process.env.TOMVERSE_AMUX_SYNC_SECRET = oldSync;
  }
});

test("AMUX v4 analysis queue returns candidate IDs, never transfer text", async () => {
  const service = await readFile(new URL("../lib/amux/ideaAnalysisQueueService.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/internal/amux/v4/analysis-queue/route.ts", import.meta.url), "utf8");
  assert.match(service, /take: PAGE_SIZE \+ 1/);
  assert.match(service, /nextCursor:/);
  assert.match(service, /buildAmuxV4AnalysisCandidateWhere/);
  assert.doesNotMatch(service, /payloadCiphertext: true|rawCiphertext: true|openAmuxContent/);
  assert.doesNotMatch(service, /\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
  assert.match(route, /isAmuxV4AnalysisAgentAuthorized/);
  assert.match(route, /amuxV4AnalysisQueueReadEnabled/);
  assert.doesNotMatch(route, /codex|claude|spawn\(/);
});

test("AMUX v4 queue candidate filter requires confirmation and current analysis", () => {
  const now = new Date("2026-10-03T00:00:00.000Z");
  const cursor = { confirmedAt: new Date("2026-10-02T00:00:00.000Z"),
    previewId: "preview_123" };
  const where = buildAmuxV4AnalysisCandidateWhere(now, cursor);
  assert.equal(where.state, "confirmed");
  assert.deepEqual(where.confirmedByUserId, { not: null });
  assert.deepEqual(where.confirmationAuditLogId, { not: null });
  assert.deepEqual(where.confirmExpiresAt, { gt: now });
  assert.deepEqual(where.idea, { state: "submitted", analysisDeadlineAt: { gt: now },
    currentSourcePlan: { is: { state: "active" } } });
  assert.deepEqual(where.sourcePlanRevision, { is: { state: "active" } });
  assert.deepEqual(where.planBoundCurrentForChunk, { is: { state: "awaiting_preview" } });
  assert.deepEqual(where.OR, [
    { confirmedAt: { gt: cursor.confirmedAt } },
    { confirmedAt: cursor.confirmedAt, id: { gt: cursor.previewId } },
  ]);
  assert.equal(buildAmuxV4AnalysisCandidateWhere(now, null).OR, undefined);
});

test("AMUX v4 analysis queue cursor round-trips a stable page position", () => {
  const position = { confirmedAt: new Date("2026-10-03T00:00:00.123Z"), previewId: "preview_123" };
  assert.deepEqual(parseAmuxV4AnalysisQueueCursor(
    encodeAmuxV4AnalysisQueueCursor(position)), position);
  for (const invalid of ["", "!", "abc", "e30", "a".repeat(513),
    Buffer.from(JSON.stringify(["2026-10-03T00:00:00.123Z", "bad/id"])).toString("base64url")]) {
    assert.equal(parseAmuxV4AnalysisQueueCursor(invalid), null);
  }
});
