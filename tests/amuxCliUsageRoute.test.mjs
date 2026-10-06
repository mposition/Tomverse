import assert from "node:assert/strict";
import test from "node:test";

import { GET, POST, DELETE } from
  "../app/api/internal/amux/cli-usage/route.ts";

const syncSecret = "synthetic-sync-secret-0123456789abcdef";
const agentSecret = "synthetic-agent-secret-0123456789abcdef";
const endpoint = "https://tomverse.test/api/internal/amux/cli-usage";
const request = (method, secret, agentId, body) => new Request(endpoint, {
  method, headers: { authorization: `Bearer ${secret}`,
    ...(agentId ? { "x-amux-agent-id": agentId } : {}),
    "content-type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test("usage writes remain code-closed for both credentials", async () => {
  const beforeSync = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const beforeAgent = process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET;
  const beforeSwitch = process.env.TOMVERSE_AMUX_CLI_USAGE_WRITE;
  try {
    process.env.TOMVERSE_AMUX_SYNC_SECRET = syncSecret;
    process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET = agentSecret;
    process.env.TOMVERSE_AMUX_CLI_USAGE_WRITE = "enabled";
    const unauthorized = await POST(request("POST", "wrong-secret"));
    assert.equal(unauthorized.status, 401);
    for (const [secret, id] of [[syncSecret, undefined],
      [agentSecret, "amux-intake"]]) {
      const response = await POST(request("POST", secret, id, { prompt: "private" }));
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { available: false,
        reason: "cli_usage_write_disabled" });
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
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
      ["TOMVERSE_AMUX_CLI_USAGE_WRITE", beforeSwitch],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
