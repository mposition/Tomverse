import assert from "node:assert/strict";
import test from "node:test";

import { GET, POST, DELETE } from
  "../app/api/internal/amux/cli-usage/route.ts";
import { makeAmuxCliUsageReceipt } from
  "../lib/amux/cliUsageLedgerCore.ts";

const syncSecret = "synthetic-sync-secret-0123456789abcdef";
const agentSecret = "synthetic-agent-secret-0123456789abcdef";
const endpoint = "https://tomverse.test/api/internal/amux/cli-usage";
const request = (method, secret, agentId, body) => new Request(endpoint, {
  method, headers: { authorization: `Bearer ${secret}`,
    ...(agentId ? { "x-amux-agent-id": agentId } : {}),
    "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test("usage writes reject invalid receipts and wrong bindings", async () => {
  const beforeSync = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const beforeAgent = process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET;
  try {
    process.env.TOMVERSE_AMUX_SYNC_SECRET = syncSecret;
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET = agentSecret;
    const unauthorized = await POST(request("POST", "wrong-secret"));
    assert.equal(unauthorized.status, 401);
    const invalid = await POST(request("POST", syncSecret, undefined,
      { prompt: "private" }));
    assert.equal(invalid.status, 400);
    const receipt = makeAmuxCliUsageReceipt({
      invocationId: "synthetic-invocation", worker: "amux-intake",
      binding: { kind: "task_attempt", attemptId: "synthetic-invocation" },
      selectedModelId: "claude-opus-5-5", cliVersion: null,
      authentication: "unknown", status: "succeeded",
      startedAt: "2026-10-06T00:00:00.000Z",
      endedAt: "2026-10-06T00:00:01.000Z",
      observation: { version: 1, cli: "claude",
        completeness: "reported_complete", completedTurns: 1,
        observed: { inputTokens: 2, outputTokens: 7,
          cacheReadInputTokens: 3, cacheCreationInputTokens: 4,
          reasoningOutputTokens: null },
        inputTokensIncludeCacheRead: false,
        inputTokensIncludeCacheWrite: false,
        reasoningOutputIncludedInOutput: null,
        models: [{ modelId: "claude-opus-5-5", observed: {
          inputTokens: 2, outputTokens: 7, cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4, reasoningOutputTokens: null } }],
      },
    });
    const nativeApiReceipt = { ...receipt, cli: "anthropic_api",
      source: "anthropic_messages_api", authentication: "api_key",
      cliVersion: null };
    const nativeViaCliRoute = await POST(request("POST", syncSecret,
      undefined, nativeApiReceipt));
    assert.equal(nativeViaCliRoute.status, 400);
    assert.equal((await POST(request("POST", agentSecret,
      "amux-intake", receipt))).status, 401);
    assert.equal((await POST(request("POST", syncSecret, undefined,
      { ...receipt, binding: { kind: "idea_analysis", holdId: "hold-1" } }))).status, 401);
    const retention = await DELETE(request("DELETE", agentSecret, "amux-intake"));
    assert.equal(retention.status, 401);
    const malformed = await GET(new Request(`${endpoint}?invocationId=x&extra=y`, {
      headers: { authorization: `Bearer ${agentSecret}`,
        "x-amux-agent-id": "amux-intake" },
    }));
    assert.equal(malformed.status, 400);
  } finally {
    for (const [name, value] of [
      ["TOMVERSE_AMUX_SYNC_SECRET", beforeSync],
      ["TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET", beforeAgent],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
