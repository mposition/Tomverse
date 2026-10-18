import assert from "node:assert/strict";
import test from "node:test";

import { GET, POST } from "../../app/api/internal/amux/v19/analysis-budget/claim/route.ts";
import { AMUX_V19_MAX_LAUNCHER_ID } from
  "../../lib/amux/ideaSessionMaxLauncherAuth.ts";
import { signAmuxV19MaxClaimAttestation,
  verifyAmuxV19MaxClaimAttestation } from
  "../../lib/amux/ideaSessionMaxLauncherAttestation.mjs";

const secret = "v19MaxLauncherSecret_0123456789abcdefgh";
const keys = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET", "TOMVERSE_AMUX_SYNC_SECRET",
  "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE",
  "TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ"] as const;

async function withEnvironment(values: Record<string, string>,
  check: () => Promise<void>) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    await check();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function request(body: unknown, bearer = secret): Request {
  return new Request("https://test.invalid/api/internal/amux/v19/analysis-budget/claim", {
    method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
      "x-amux-agent-id": AMUX_V19_MAX_LAUNCHER_ID },
    body: JSON.stringify(body),
  });
}

test("only a distinct fixed Max launcher credential reaches claim admission", async () => {
  await withEnvironment({}, async () => {
    assert.equal((await POST(request({}))).status, 401);
  });
  await withEnvironment({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret,
    TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET: secret }, async () => {
    assert.equal((await POST(request({}))).status, 401);
  });
  await withEnvironment({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret },
    async () => {
      const response = await POST(request({}));
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { available: false,
        reason: "session_budget_claim_disabled" });
    });
});

test("claim body cannot supply its own Max authentication assertion", async () => {
  await withEnvironment({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret,
    TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_WRITE: "enabled",
    TOMVERSE_AMUX_V19_SESSION_BUDGET_CLAIM_READ: "enabled",
    TOMVERSE_AMUX_V19_SESSION_ANALYSIS_STOP_POLL_READ: "enabled" },
  async () => {
    const identity = { claimId: "06b23730-7a7f-488c-a879-145d540d8794",
      requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
      reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
      ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
      invocationOrdinal: 0, modelId: "claude-opus-5-5",
      reasoningEffort: "high", priceVersionId: "approved-price" };
    const authVerifiedAt = new Date().toISOString();
    const authProof = signAmuxV19MaxClaimAttestation(secret, identity,
      authVerifiedAt);
    assert.match(verifyAmuxV19MaxClaimAttestation(secret, identity,
      authVerifiedAt, authProof)!, /^[a-f0-9]{64}$/);
    assert.equal((await POST(request({ ...identity, authVerifiedAt,
      authProof, maxSubscriptionAuthenticated: true }))).status, 400);
    assert.equal((await POST(request({ ...identity, authVerifiedAt,
      authProof, ideaId: "2d5580cf-19c8-4e9a-9ee4-159dd2799980" }))).status,
    400);
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    assert.equal(verifyAmuxV19MaxClaimAttestation(secret, identity, stale,
      signAmuxV19MaxClaimAttestation(secret, identity, stale)), null);
  });
});

test("dedicated Max credential reaches the independently gated readback", async () => {
  await withEnvironment({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret },
    async () => {
      const response = await GET(new Request(
        "https://test.invalid/api/internal/amux/v19/analysis-budget/claim", {
          headers: { authorization: `Bearer ${secret}`,
            "x-amux-agent-id": AMUX_V19_MAX_LAUNCHER_ID },
        }));
      assert.equal(response.status, 409);
      assert.equal((await response.json()).reason,
        "session_budget_claim_read_disabled");
    });
});
