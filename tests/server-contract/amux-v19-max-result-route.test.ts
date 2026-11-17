import assert from "node:assert/strict";
import test from "node:test";

import { POST as postResult } from
  "../../app/api/internal/amux/v19/analysis-budget/max-result/route.ts";
import { POST as postUnknown } from
  "../../app/api/internal/amux/v19/analysis-budget/unknown/route.ts";
import { AMUX_V19_MAX_LAUNCHER_ID } from
  "../../lib/amux/ideaSessionMaxLauncherAuth.ts";

const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const keys = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET"] as const;
const ids = { claimId: "9942fb52-4b78-4af6-931a-9eec8f66d394",
  requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
  reservationId: "bf72ad14-585c-41bd-b25e-aab4c17a6d3c",
  ideaId: "53d6918e-b05d-4531-a1ab-704dd756cc40",
  invocationOrdinal: 0 };

async function withEnv(values: Record<string, string>, fn: () => Promise<void>) {
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    await fn();
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  }
}

function request(path: string, body: unknown, bearer = secret): Request {
  return new Request(`https://test.invalid${path}`, { method: "POST",
    headers: { authorization: `Bearer ${bearer}`,
      "x-amux-agent-id": AMUX_V19_MAX_LAUNCHER_ID,
      "content-type": "application/json" },
    body: JSON.stringify(body) });
}

test("Max result write requires its distinct launcher credential", async () => {
  const body = { ...ids, outcome: "verified_success",
    inputTokens: 100, outputTokens: 1 };
  const path = "/api/internal/amux/v19/analysis-budget/max-result";
  await withEnv({}, async () => {
    assert.equal((await postResult(request(path, body))).status, 401);
  });
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret,
    TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET: secret }, async () => {
    assert.equal((await postResult(request(path, body))).status, 401);
  });
});

test("Max result refuses invalid and caller-asserted settlement", async () => {
  const path = "/api/internal/amux/v19/analysis-budget/max-result";
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret },
  async () => {
    assert.equal((await postResult(request(path, { ...ids,
      outcome: "verified_success", inputTokens: -1,
      outputTokens: 0 }))).status, 400);
    // Operator, 2026-11-16: zero reported tokens is a result that settles at
    // zero, so it passes the body check and reaches the settlement.
    assert.notEqual((await postResult(request(path, { ...ids,
      outcome: "invocation_failed", inputTokens: 0,
      outputTokens: 0 }))).status, 400);
    assert.equal((await postResult(request(path, { ...ids,
      outcome: "verified_success", inputTokens: 100,
      outputTokens: 1, settledMicroUsd: "1" }))).status, 400);
  });
});

test("Max launcher can reach the unknown hold route, which records unknown outcomes only", async () => {
  const path = "/api/internal/amux/v19/analysis-budget/unknown";
  await withEnv({}, async () => {
    assert.equal((await postUnknown(request(path, { ...ids,
      outcome: "outcome_unknown", inputTokens: null,
      outputTokens: null }))).status, 401);
  });
  await withEnv({ TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET: secret }, async () => {
    // Past authentication the body check refuses anything but an unknown outcome.
    assert.equal((await postUnknown(request(path, { ...ids,
      outcome: "verified_success", inputTokens: 1,
      outputTokens: 1 }))).status, 400);
  });
});
