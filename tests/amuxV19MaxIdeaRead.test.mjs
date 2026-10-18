import assert from "node:assert/strict";
import test from "node:test";

import { readAmuxV19MaxIdeaOnce } from
  "../lib/amux/ideaLocalMaxIdeaRead.mjs";

const origin = "https://synthetic-amux.example.test/";
const reservationId = "bf72ad14-585c-41bd-b25e-aab4c17a6d3c";
const ideaId = "53d6918e-b05d-4531-a1ab-704dd756cc40";
const claimId = "f980b3e8-8d8f-47c3-9916-b438e7e34b27";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";

async function withEnv(fn) {
  const names = ["TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN",
    "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET"];
  const old = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN = origin;
    process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
    await fn();
  } finally {
    for (const name of names) {
      if (old[name] === undefined) delete process.env[name];
      else process.env[name] = old[name];
    }
  }
}

test("Max launcher reads only its claim-bound plaintext without a v4 byte cap", async () =>
  withEnv(async () => {
    const idea = "synthetic idea " + "x".repeat(100_000);
    let calls = 0;
    const result = await readAmuxV19MaxIdeaOnce({ origin, reservationId,
      ideaId, claimId, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url,
          "https://synthetic-amux.example.test/api/internal/amux/v19/analysis-idea");
        assert.equal(options.method, "POST");
        assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
        assert.deepEqual(JSON.parse(options.body), { reservationId, ideaId,
          claimId });
        return Response.json({ idea });
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { kind: "ready", idea });
  }));

test("wrong origin refuses before network and malformed response stays unavailable", async () =>
  withEnv(async () => {
    let calls = 0;
    assert.deepEqual(await readAmuxV19MaxIdeaOnce({
      origin: "https://other.example.test/", reservationId, ideaId,
      claimId, fetchImpl: async () => { calls++; throw new Error("network"); },
    }), { kind: "refused" });
    assert.equal(calls, 0);
    assert.deepEqual(await readAmuxV19MaxIdeaOnce({ origin,
      reservationId, ideaId, claimId,
      fetchImpl: async () => Response.json({ idea: "", extra: true }),
    }), { kind: "unavailable" });
  }));
