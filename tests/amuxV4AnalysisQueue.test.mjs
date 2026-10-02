import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AMUX_V4_ANALYSIS_AGENT_ID,
  AMUX_V4_ANALYSIS_QUEUE_CODE_LATCH,
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
