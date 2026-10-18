import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "../../app/api/internal/amux/v19/analysis-idea/route.ts";
import { AMUX_V19_MAX_LAUNCHER_ID } from
  "../../lib/amux/ideaSessionMaxLauncherAuth.ts";

const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const endpoint = "https://test.invalid/api/internal/amux/v19/analysis-idea";
const names = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V19_SESSION_MAX_IDEA_READ",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_QUEUE_READ",
  "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ",
  "TOMVERSE_AMUX_SESSION_INTAKE",
  "TOMVERSE_AMUX_V4_ANALYSIS_QUEUE_READ"] as const;

async function withEnv(values: Record<string, string>, fn: () => Promise<void>) {
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    await fn();
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

function request(body: unknown, credential = secret): Request {
  return new Request(endpoint, { method: "POST",
    headers: { authorization: `Bearer ${credential}`,
      "x-amux-agent-id": AMUX_V19_MAX_LAUNCHER_ID,
      "content-type": "application/json" },
    body: JSON.stringify(body) });
}

const valid = { reservationId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  claimId: "f980b3e8-8d8f-47c3-9916-b438e7e34b27" };

test("idea read requires dedicated Max credential and remains default off", async () => {
  await withEnv({}, async () => {
    assert.equal((await POST(request(valid))).status, 401);
  });
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret },
    async () => {
      const response = await POST(request(valid));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).reason,
        "session_max_idea_read_disabled");
    });
});

test("enabled idea read rejects extra and malformed identity before key access", async () => {
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret,
    TOMVERSE_AMUX_V19_SESSION_MAX_IDEA_READ: "enabled",
    TOMVERSE_AMUX_V19_SESSION_ANALYSIS_QUEUE_READ: "enabled",
    TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ: "enabled",
    TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ: "enabled",
    TOMVERSE_AMUX_SESSION_INTAKE: "enabled",
    TOMVERSE_AMUX_V4_ANALYSIS_QUEUE_READ: "enabled" }, async () => {
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ = "disabled";
    assert.equal((await POST(request(valid))).status, 409);
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ = "enabled";
    assert.equal((await POST(request({ ...valid, extra: true }))).status, 400);
    assert.equal((await POST(request({ ...valid,
      claimId: "wrong" }))).status, 400);
    assert.equal((await POST(request(valid,
      "syntheticOtherCredential_0123456789abcdefgh"))).status, 401);
  });
});
