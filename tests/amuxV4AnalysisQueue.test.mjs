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

const secret = "v4_intake_only_012345678901234567890123456789";
const request = (token, agentId = AMUX_V4_ANALYSIS_AGENT_ID) => new Request(
  "https://tomverse.example/api/internal/amux/v4/analysis-queue", {
    method: "POST", headers: { authorization: `Bearer ${token}`,
      "x-amux-agent-id": agentId },
  });

test("AMUX v4 analysis queue uses a dedicated identity and stays dark", () => {
  assert.equal(AMUX_V4_ANALYSIS_QUEUE_CODE_LATCH, false);
  assert.equal(amuxV4AnalysisQueueReadEnabled("enabled"), false);
  assert.equal(isAmuxV4AnalysisAgentAuthorized(request(secret), secret), true);
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
  try {
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = secret;
    process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV] = "enabled";
    const denied = await POST(new Request("https://tomverse.example/api/internal/amux/v4/analysis-queue",
      { method: "POST" }));
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("cache-control") ?? "", /no-store/);
    const dark = await POST(request(secret));
    assert.equal(dark.status, 409);
    assert.deepEqual(await dark.json(), { available: false, reason: "analysis_queue_disabled" });
  } finally {
    if (originalSecret === undefined) delete process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV];
    else process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV] = originalSecret;
    if (originalRead === undefined) delete process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV];
    else process.env[AMUX_V4_ANALYSIS_QUEUE_READ_ENV] = originalRead;
  }
});

test("AMUX v4 analysis queue returns candidate IDs, never transfer text", async () => {
  const service = await readFile(new URL("../lib/amux/ideaAnalysisQueueService.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/internal/amux/v4/analysis-queue/route.ts", import.meta.url), "utf8");
  assert.match(service, /state: "confirmed", consumedAt: null/);
  assert.match(service, /currentForChunk: \{ is: \{ state: "awaiting_preview" \} \}/);
  assert.match(service, /take: PAGE_SIZE \+ 1/);
  assert.doesNotMatch(service, /payloadCiphertext: true|rawCiphertext: true|openAmuxContent/);
  assert.doesNotMatch(service, /\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
  assert.match(route, /isAmuxV4AnalysisAgentAuthorized/);
  assert.match(route, /amuxV4AnalysisQueueReadEnabled/);
  assert.doesNotMatch(route, /codex|claude|spawn\(/);
});
