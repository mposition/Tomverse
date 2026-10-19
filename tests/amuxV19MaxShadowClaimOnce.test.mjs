import assert from "node:assert/strict";
import test from "node:test";

import { claimAmuxV19MaxShadowBudgetOnce } from
  "../lib/amux/ideaLocalMaxShadowClaimOnce.mjs";
import { verifyAmuxV19MaxClaimAttestation } from
  "../lib/amux/ideaSessionMaxLauncherAttestation.mjs";

const origin = "https://synthetic-amux.example.test/";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const identity = {
  claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0, priceVersionId: "approved-price",
  modelId: "claude-opus-5-5", reasoningEffort: "high",
};

async function withLauncherEnv(check) {
  const names = ["TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
    "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
    "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI"];
  const previous = Object.fromEntries(names.map((name) =>
    [name, process.env[name]]));
  try {
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = origin;
    process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
    process.env.TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI = "enabled";
    await check();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("unconfigured origin cannot cause a claim write", async () => {
  let calls = 0;
  const old = process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN;
  try {
    delete process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN;
    assert.deepEqual(await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
      fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); },
    }), { kind: "refused" });
    assert.equal(calls, 0);
  } finally {
    if (old === undefined)
      delete process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN;
    else process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = old;
  }
});

test("Ubuntu launcher verifies OAuth metadata and signs one exact claim", {
  skip: process.env.AMUX_V19_RUNNER_AUTH_METADATA_TEST !== "1",
}, async () => withLauncherEnv(async () => {
  let postCount = 0;
  const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "POST");
      assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
      const body = JSON.parse(options.body);
      assert.match(verifyAmuxV19MaxClaimAttestation(secret, body,
        body.authVerifiedAt, body.authProof), /^[a-f0-9]{64}$/);
      postCount++;
      return Response.json({ claimId: identity.claimId,
        requestId: identity.requestId, reservationId: identity.reservationId,
        invocationOrdinal: 0, reservedMicroUsd: "1000000",
        auditId: "synthetic-audit" });
    },
  });
  assert.equal(postCount, 1);
  assert.deepEqual(result, { kind: "claimed", claimId: identity.claimId,
    reservationId: identity.reservationId, requestId: identity.requestId,
    reservedMicroUsd: "1000000", recovered: false, retryWrite: false });
}));

test("lost POST response reads exact receipt once and never replays write", {
  skip: process.env.AMUX_V19_RUNNER_AUTH_METADATA_TEST !== "1",
}, async () => withLauncherEnv(async () => {
  let writes = 0;
  let reads = 0;
  const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        writes++;
        throw new Error("synthetic lost response");
      }
      reads++;
      assert.equal(options.method, "GET");
      assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
      return Response.json({ status: "committed", claimId: identity.claimId,
        claimStatus: "in_flight" });
    },
  });
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.deepEqual(result, { kind: "claimed", claimId: identity.claimId,
    reservationId: identity.reservationId, requestId: identity.requestId,
    reservedMicroUsd: null, recovered: true, retryWrite: false });
}));

test("absent readback after lost POST remains outcome unknown", {
  skip: process.env.AMUX_V19_RUNNER_AUTH_METADATA_TEST !== "1",
}, async () => withLauncherEnv(async () => {
  let writes = 0;
  let reads = 0;
  const result = await claimAmuxV19MaxShadowBudgetOnce({ origin, identity,
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {
        writes++;
        throw new Error("synthetic lost response");
      }
      reads++;
      return Response.json({ status: "absent" });
    },
  });
  assert.deepEqual(result, { kind: "outcome_unknown",
    receiptStatus: "absent", retryWrite: false });
  assert.equal(writes, 1);
  assert.equal(reads, 1);
}));
