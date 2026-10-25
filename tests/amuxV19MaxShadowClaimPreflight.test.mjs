import assert from "node:assert/strict";
import test from "node:test";

import { inspectAmuxV19MaxShadowClaimIdentity,
  prepareAmuxV19MaxShadowClaim } from
  "../lib/amux/ideaLocalMaxShadowClaimPreflight.mjs";
import { signAmuxV19MaxClaimAttestation,
  verifyAmuxV19MaxClaimAttestation } from
  "../lib/amux/ideaSessionMaxLauncherAttestation.mjs";

const identity = (change = {}) => ({
  claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0, priceVersionId: "approved-price", provider: "anthropic",
  modelId: "claude-opus-5-5", reasoningEffort: "high", ...change,
});

test("only the exact approved Anthropic tuple passes Max claim preflight", () => {
  assert.equal(inspectAmuxV19MaxShadowClaimIdentity(identity())?.claimId,
    identity().claimId);
  for (const change of [{ claimId: "bad" }, { invocationOrdinal: -1 },
    { priceVersionId: "bad price" }, { modelId: "gpt-5.6-sol" },
    { reasoningEffort: "low" }, { provider: undefined }]) {
    assert.equal(inspectAmuxV19MaxShadowClaimIdentity(identity(change)), null);
  }
});

test("another launchable channel passes with a model its CLI names and a supported effort", () => {
  const copilot = inspectAmuxV19MaxShadowClaimIdentity(identity({
    provider: "github-copilot", modelId: "gpt-5-mini", reasoningEffort: "low" }));
  assert.equal(copilot?.provider, "github-copilot");
  assert.equal(copilot.modelId, "gpt-5-mini");
  assert.equal(inspectAmuxV19MaxShadowClaimIdentity(identity({ provider: "cursor",
    modelId: "auto", reasoningEffort: "ultra" }))?.provider, "cursor");
  for (const change of [
    // Copilot has no "ultra" effort; Codex stays closed until the owner decides.
    { provider: "github-copilot", modelId: "gpt-5-mini", reasoningEffort: "ultra" },
    { provider: "openai", modelId: "gpt-6-luna", reasoningEffort: "low" },
    { provider: "gemini", modelId: "gemini-3", reasoningEffort: "high" },
    { provider: "cursor", modelId: "-flag", reasoningEffort: "high" },
  ]) {
    assert.equal(inspectAmuxV19MaxShadowClaimIdentity(identity(change)), null);
  }
});

test("the signed claim proof binds the CLI channel", () => {
  const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
  const at = new Date().toISOString();
  const proof = signAmuxV19MaxClaimAttestation(secret, identity(), at);
  assert.match(verifyAmuxV19MaxClaimAttestation(secret, identity(), at, proof),
    /^[a-f0-9]{64}$/);
  assert.equal(verifyAmuxV19MaxClaimAttestation(secret,
    identity({ provider: "cursor" }), at, proof), null);
  assert.equal(verifyAmuxV19MaxClaimAttestation(secret,
    identity({ provider: undefined }), at, proof), null);
});

test("closed switch never attests Max authentication", async () => {
  const old = process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI;
  try {
    delete process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI;
    assert.deepEqual(await prepareAmuxV19MaxShadowClaim(identity()),
      { kind: "refused" });
  } finally {
    if (old === undefined) delete process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI;
    else process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI = old;
  }
});

test("Ubuntu launcher signs exact IDs only after Max OAuth metadata check", {
  skip: process.env.AMUX_V19_RUNNER_AUTH_METADATA_TEST !== "1",
}, async () => {
  const oldSwitch = process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI;
  const oldSecret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
  try {
    process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI = "enabled";
    process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
    const result = await prepareAmuxV19MaxShadowClaim(identity());
    assert.equal(result.kind, "ready");
    assert.match(verifyAmuxV19MaxClaimAttestation(secret, result.identity,
      result.authVerifiedAt, result.authProof), /^[a-f0-9]{64}$/);
  } finally {
    if (oldSwitch === undefined) delete process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI;
    else process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI = oldSwitch;
    if (oldSecret === undefined) delete process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
    else process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = oldSecret;
  }
});
