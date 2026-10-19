import assert from "node:assert/strict";
import test from "node:test";

import { settleAmuxV19MaxShadowResultOnce } from
  "../lib/amux/ideaLocalMaxShadowResultOnce.mjs";

const origin = "https://synthetic-amux.example.test/";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const ids = {
  claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0,
};

async function withEnv(fn) {
  const keys = ["TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
    "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET"];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = origin;
    process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
    await fn();
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

test("measured Max result records once with its exact claim and no model call", async () =>
  withEnv(async () => {
    const input = { ...ids, outcome: "verified_success",
      inputTokens: 1001, outputTokens: 1 };
    let writes = 0;
    const result = await settleAmuxV19MaxShadowResultOnce({ origin, input,
      fetchImpl: async (url, options) => {
        assert.match(url, /\/max-result$/);
        assert.equal(options.method, "POST");
        assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
        assert.deepEqual(JSON.parse(options.body), input);
        writes++;
        return Response.json({ claimId: ids.claimId, status: "succeeded",
          settledMicroUsd: "1002000", auditId: "synthetic-audit" });
      },
    });
    assert.equal(writes, 1);
    assert.deepEqual(result, { kind: "recorded", status: "succeeded",
      settledMicroUsd: "1002000", recovered: false, retryWrite: false });
  }));

test("lost Max settlement response reads once and never replays write", async () =>
  withEnv(async () => {
    const input = { ...ids, outcome: "verified_success",
      inputTokens: 1001, outputTokens: 1 };
    let writes = 0;
    let reads = 0;
    const result = await settleAmuxV19MaxShadowResultOnce({ origin, input,
      fetchImpl: async (_url, options) => {
        if (options.method === "POST") {
          writes++;
          throw new Error("synthetic lost response");
        }
        reads++;
        return Response.json({ status: "committed", claimId: ids.claimId,
          claimStatus: "succeeded" });
      },
    });
    assert.equal(writes, 1);
    assert.equal(reads, 1);
    assert.deepEqual(result, { kind: "recorded", status: "succeeded",
      settledMicroUsd: null, recovered: true, retryWrite: false });
  }));

test("unknown Max usage holds through dedicated endpoint and absent readback stops", async () =>
  withEnv(async () => {
    const input = { ...ids, outcome: "outcome_unknown",
      inputTokens: null, outputTokens: null };
    let writes = 0;
    let reads = 0;
    const result = await settleAmuxV19MaxShadowResultOnce({ origin, input,
      fetchImpl: async (url, options) => {
        if (options.method === "POST") {
          assert.match(url, /\/unknown$/);
          writes++;
          throw new Error("synthetic lost response");
        }
        reads++;
        return Response.json({ status: "absent" });
      },
    });
    assert.equal(writes, 1);
    assert.equal(reads, 1);
    assert.deepEqual(result, { kind: "outcome_unknown",
      receiptStatus: "absent", retryWrite: false });
  }));

test("missing measured usage cannot be submitted as a known result", async () =>
  withEnv(async () => {
    let calls = 0;
    const result = await settleAmuxV19MaxShadowResultOnce({ origin,
      input: { ...ids, outcome: "verified_success", inputTokens: null,
        outputTokens: null },
      fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); },
    });
    assert.deepEqual(result, { kind: "refused" });
    assert.equal(calls, 0);
  }));
