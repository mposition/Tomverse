import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { POST } from "../app/api/internal/amux/v4/content-retention/route.ts";
import { AMUX_V4_CONTENT_RETENTION_AGENT_ID,
  amuxV4ContentRetentionEnabled,
  amuxV22TaskResultRetentionEnabled,
  isAmuxV4ContentRetentionAuthorized } from
  "../lib/amux/ideaContentRetentionCore.ts";

const secret = "synthetic-retention-secret-0123456789";
const request = (token = secret, agentId = AMUX_V4_CONTENT_RETENTION_AGENT_ID) =>
  new Request("https://tomverse.test/api/internal/amux/v4/content-retention", {
    method: "POST", headers: { authorization: `Bearer ${token}`,
      "x-amux-agent-id": agentId, "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1 }),
  });

test("retention route has a separate secret and stays closed without its environment switch", async () => {
  assert.equal(isAmuxV4ContentRetentionAuthorized(request(), secret,
    ["another-distinct-secret-0123456789"]), true);
  assert.equal(isAmuxV4ContentRetentionAuthorized(request(), secret,
    [secret]), false);
  assert.equal(isAmuxV4ContentRetentionAuthorized(request(secret, "amux-v4-analysis"),
    secret, []), false);
  assert.equal(amuxV4ContentRetentionEnabled("enabled"), true);
  assert.equal(amuxV4ContentRetentionEnabled("disabled"), false);
  assert.equal(amuxV4ContentRetentionEnabled(undefined), false);
  const previousSecret = process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET;
  const previousSwitch = process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION;
  try {
    process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION_SECRET = secret;
    delete process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION;
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

test("v15 does not activate v22 task result or patch retention", () => {
  assert.equal(amuxV22TaskResultRetentionEnabled(undefined), false);
  assert.equal(amuxV22TaskResultRetentionEnabled("disabled"), false);
  assert.equal(amuxV22TaskResultRetentionEnabled("enabled"), false);
  const route = readFileSync(new URL(
    "../app/api/internal/amux/v4/content-retention/route.ts", import.meta.url), "utf8");
  assert.match(route, /amuxV22TaskResultRetentionEnabled\(\s*process\.env\[AMUX_V22_TASK_RESULT_RETENTION_ENV\]\)/);
  assert.match(route, /\? await purgeDueAmuxV22TaskResults\(\)/);
});
