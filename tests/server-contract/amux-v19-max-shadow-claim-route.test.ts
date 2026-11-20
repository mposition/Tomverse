import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GET, POST } from "../../app/api/internal/amux/v19/analysis-budget/claim/route.ts";
import { AMUX_V19_MAX_LAUNCHER_ID } from
  "../../lib/amux/ideaSessionMaxLauncherAuth.ts";
import { AMUX_V19_MAX_CLAIM_RUNNER_MARKER, signAmuxV19MaxClaimAttestation,
  verifyAmuxV19MaxClaimAttestation } from
  "../../lib/amux/ideaSessionMaxLauncherAttestation.mjs";

const secret = "v19MaxLauncherSecret_0123456789abcdefgh";
const keys = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET", "TOMVERSE_AMUX_SYNC_SECRET"] as const;

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
      // Past authentication an empty body is refused by the strict schema.
      assert.equal((await POST(request({}))).status, 400);
    });
});

test("claim body cannot supply its own Max authentication assertion", async () => {
  await withEnvironment({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret },
  async () => {
    const identity = { claimId: "06b23730-7a7f-488c-a879-145d540d8794",
      requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
      reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
      ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
      invocationOrdinal: 0, provider: "anthropic", modelId: "claude-opus-5-5",
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
    const oversized = { ...identity, invocationOrdinal: 2_147_483_648 };
    assert.equal((await POST(request({ ...oversized, authVerifiedAt,
      authProof: signAmuxV19MaxClaimAttestation(secret, oversized,
        authVerifiedAt) }))).status, 400);
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    assert.equal(verifyAmuxV19MaxClaimAttestation(secret, identity, stale,
      signAmuxV19MaxClaimAttestation(secret, identity, stale)), null);
    // The channel is part of the signed proof and must be a known channel.
    const withoutProvider: Partial<typeof identity> = { ...identity };
    delete withoutProvider.provider;
    assert.equal((await POST(request({ ...withoutProvider, authVerifiedAt,
      authProof }))).status, 400);
    assert.equal((await POST(request({ ...identity, provider: "cursor",
      authVerifiedAt, authProof }))).status, 400);
    const gemini = { ...identity, provider: "gemini" };
    assert.equal((await POST(request({ ...gemini, authVerifiedAt,
      authProof: signAmuxV19MaxClaimAttestation(secret, gemini,
        authVerifiedAt) }))).status, 400);
  });
});

test("claim body takes the fixed runner mark or none, and nothing else", async () => {
  await withEnvironment({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret },
  async () => {
    const identity = { claimId: "06b23730-7a7f-488c-a879-145d540d8794",
      requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
      reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
      ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
      invocationOrdinal: 0, provider: "anthropic", modelId: "claude-opus-5-5",
      reasoningEffort: "high", priceVersionId: "approved-price" };
    const authVerifiedAt = new Date().toISOString();
    const authProof = signAmuxV19MaxClaimAttestation(secret, identity,
      authVerifiedAt);
    // Any other value is refused before authentication evidence or the database.
    for (const runnerMarker of ["other", "", "Claim_named", true, 1, null,
      ["claim_named"], { claim: "named" }]) {
      assert.equal((await POST(request({ ...identity, authVerifiedAt, authProof,
        runnerMarker }))).status, 400, JSON.stringify(runnerMarker));
    }
    assert.equal(AMUX_V19_MAX_CLAIM_RUNNER_MARKER, "claim_named");
    // A runner from before the mark sends none and is still accepted, so the
    // field is optional and the one literal (the claim itself then needs the
    // database, which the integration suite covers).
    const source = await readFile(new URL(
      "../../app/api/internal/amux/v19/analysis-budget/claim/route.ts",
      import.meta.url), "utf8");
    assert.ok(source.includes(
      "runnerMarker: z.literal(AMUX_V19_MAX_CLAIM_RUNNER_MARKER).optional()"));
    // The mark is not part of the signed proof.
    assert.equal(signAmuxV19MaxClaimAttestation(secret,
      { ...identity, runnerMarker: "claim_named" }, authVerifiedAt), authProof);
  });
});

test("dedicated Max credential reaches the claim readback", async () => {
  await withEnvironment({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret },
    async () => {
      const response = await GET(new Request(
        "https://test.invalid/api/internal/amux/v19/analysis-budget/claim", {
          headers: { authorization: `Bearer ${secret}`,
            "x-amux-agent-id": AMUX_V19_MAX_LAUNCHER_ID },
        }));
      // Past authentication the readback needs its exact identity query.
      assert.equal(response.status, 400);
    });
});
