import assert from "node:assert/strict";
import test from "node:test";

import { readAmuxV19MaxPriceSelection } from
  "../lib/amux/ideaLocalMaxPriceSelectionRead.mjs";

const origin = "https://synthetic-amux.example.test/";
const reservationId = "bf72ad14-585c-41bd-b25e-aab4c17a6d3c";
const ideaId = "53d6918e-b05d-4531-a1ab-704dd756cc40";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";

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

test("read-only Max price hint binds exact reservation and dedicated launcher", async () =>
  withEnv(async () => {
    let calls = 0;
    const result = await readAmuxV19MaxPriceSelection({ origin,
      reservationId, ideaId, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(options.method, "GET");
        assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
        assert.equal(new URL(url).searchParams.get("reservationId"), reservationId);
        assert.equal(new URL(url).searchParams.get("ideaId"), ideaId);
        return Response.json({ kind: "ready", priceVersionId: "approved-max-v1",
          provider: "anthropic", modelId: "claude-opus-5-5", reasoningEffort: "high" });
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { kind: "ready",
      priceVersionId: "approved-max-v1", provider: "anthropic",
      modelId: "claude-opus-5-5", reasoningEffort: "high" });
  }));

test("the price hint names its CLI channel or stays unavailable", async () =>
  withEnv(async () => {
    const answer = (body) => readAmuxV19MaxPriceSelection({ origin, reservationId,
      ideaId, fetchImpl: async () => Response.json(body) });
    const ready = { kind: "ready", priceVersionId: "approved-cursor-v1",
      provider: "cursor", modelId: "gpt-5.6-sol-high", reasoningEffort: "high" };
    assert.deepEqual(await answer(ready), ready);
    const withoutProvider = { ...ready };
    delete withoutProvider.provider;
    for (const body of [withoutProvider, { ...ready, provider: "gemini" },
      { ...ready, extra: 1 }]) {
      assert.deepEqual(await answer(body), { kind: "unavailable",
        reason: "response_invalid" });
    }
  }));

test("unbound origin refuses before network and malformed price stays unavailable", async () =>
  withEnv(async () => {
    let calls = 0;
    assert.deepEqual(await readAmuxV19MaxPriceSelection({
      origin: "https://other.example.test/", reservationId, ideaId,
      fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); },
    }), { kind: "refused" });
    assert.equal(calls, 0);
    assert.deepEqual(await readAmuxV19MaxPriceSelection({ origin,
      reservationId, ideaId, fetchImpl: async () => Response.json({
        kind: "ready", priceVersionId: "bad price", provider: "anthropic",
        modelId: "claude-opus-5-5", reasoningEffort: "high",
      }),
    }), { kind: "unavailable", reason: "response_invalid" });
  }));
