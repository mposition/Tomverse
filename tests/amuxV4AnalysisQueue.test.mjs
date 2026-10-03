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
