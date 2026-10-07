import assert from "node:assert/strict";
import { test } from "node:test";

import { POST } from "../app/api/internal/amux/v4/content-retention/route.ts";
import { AMUX_V4_CONTENT_RETENTION_AGENT_ID,
  amuxV4ContentRetentionEnabled,
  isAmuxV4ContentRetentionAuthorized } from
  "../lib/amux/ideaContentRetentionCore.ts";

const secret = "synthetic-retention-secret-0123456789";
const request = (token = secret, agentId = AMUX_V4_CONTENT_RETENTION_AGENT_ID) =>
  new Request("https://tomverse.test/api/internal/amux/v4/content-retention", {
    method: "POST", headers: { authorization: `Bearer ${token}`,
      "x-amux-agent-id": agentId, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1 }),
  });

test("retention route has a separate secret and cannot be opened by an environment value", async () => {
  assert.equal(isAmuxV4ContentRetentionAuthorized(request(), secret,
    ["another-distinct-secret-0123456789"]), true);
  assert.equal(isAmuxV4ContentRetentionAuthorized(request(), secret,
    [secret]), false);
  assert.equal(isAmuxV4ContentRetentionAuthorized(request(secret, "amux-v4-analysis"),
    secret, []), false);
  assert.equal(amuxV4ContentRetentionEnabled("enabled"), false);
  const previousSecret = process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET;
  const previousSwitch = process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION;
  try {
    process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET = secret;
    process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION = "enabled";
    const response = await POST(request());
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      available: false, reason: "content_retention_disabled" });
  } finally {
    if (previousSecret === undefined) delete process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET;
    else process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET = previousSecret;
    if (previousSwitch === undefined) delete process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION;
    else process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION = previousSwitch;
  }
});
