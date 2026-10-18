import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runAmuxV19MaxSessionQueueEntryOnce } from
  "../lib/amux/ideaLocalMaxSessionQueueEntry.mjs";
import { amuxV19QueueCursorState } from
  "../lib/amux/ideaLocalSessionQueueCursorState.mjs";

const origin = "https://synthetic-amux.example.test/";
const secret = "syntheticMaxLauncherSecret_0123456789abcdefgh";
const candidate = (ordinal) => ({
  reservationId: `ec61a12d-d02a-478f-a499-${String(ordinal).padStart(12, "0")}`,
  ideaId: `ea86a25b-919f-4714-a3d8-${String(ordinal).padStart(12, "0")}`,
  modelId: "claude-opus-5-5",
  expiresAt: "2026-10-19T00:00:00.000Z",
});
const price = { kind: "ready", priceVersionId: "approved-price",
  modelId: "claude-opus-5-5", reasoningEffort: "high" };

async function withState(t, run) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "amux-max-queue-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const originKey = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN";
  const secretKey = "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET";
  const priorOrigin = process.env[originKey];
  const priorSecret = process.env[secretKey];
  try {
    process.env[originKey] = origin;
    process.env[secretKey] = secret;
    await run(stateDirectory);
  } finally {
    if (priorOrigin === undefined) delete process.env[originKey];
    else process.env[originKey] = priorOrigin;
    if (priorSecret === undefined) delete process.env[secretKey];
    else process.env[secretKey] = priorSecret;
  }
}

test("Max queue entry selects only an exact approved price without a claim", async (t) =>
  withState(t, async (stateDirectory) => {
    const calls = [];
    const result = await runAmuxV19MaxSessionQueueEntryOnce({ origin,
      stateDirectory, fetchImpl: async (url, options) => {
        const target = new URL(url);
        calls.push(target.pathname);
        assert.equal(options.headers.authorization,
          ["Bearer", secret].join(" "));
        assert.equal(options.headers["x-amux-agent-id"], "amux-intake-max");
        if (target.pathname.endsWith("/analysis-queue")) {
          return Response.json({ candidates: [candidate(1), candidate(2)],
            hasMore: false, nextCursor: null });
        }
        assert.equal(target.pathname,
          "/api/internal/amux/v19/analysis-price");
        return Response.json(target.searchParams.get("reservationId") ===
          candidate(1).reservationId ? { ...price, modelId: "wrong-model" }
          : price);
      },
    });
    assert.deepEqual(result, { kind: "discovered", candidate: candidate(2),
      price });
    assert.deepEqual(calls, ["/api/internal/amux/v19/analysis-queue",
      "/api/internal/amux/v19/analysis-price",
      "/api/internal/amux/v19/analysis-price"]);
    assert.equal(await amuxV19QueueCursorState(stateDirectory).read(), null);
  }));

test("Max queue entry preserves a read-only pagination hint across ticks", async (t) =>
  withState(t, async (stateDirectory) => {
    const state = amuxV19QueueCursorState(stateDirectory);
    let pages = 0;
    const fetchImpl = async (url, options) => {
      assert.equal(new URL(url).pathname,
        "/api/internal/amux/v19/analysis-queue");
      const request = JSON.parse(options.body);
      if (request.after === "page-8") return Response.json({
        candidates: [candidate(1)], hasMore: false, nextCursor: null });
      pages += 1;
      return Response.json({ candidates: Array.from({ length: 32 },
        () => ({ ...candidate(1), modelId: "unapproved-model" })),
        hasMore: true, nextCursor: `page-${pages}` });
    };
    assert.deepEqual(await runAmuxV19MaxSessionQueueEntryOnce({ origin,
      stateDirectory, fetchImpl }), { kind: "more_unexamined" });
    assert.equal(await state.read(), "page-8");
    assert.deepEqual(await runAmuxV19MaxSessionQueueEntryOnce({ origin,
      stateDirectory, fetchImpl: async (url, options) =>
        new URL(url).pathname.endsWith("/analysis-price")
          ? Response.json(price) : fetchImpl(url, options),
    }), { kind: "discovered", candidate: candidate(1), price });
    assert.equal(await state.read(), null);
  }));

test("Max queue entry refuses missing launcher secret before network", async (t) =>
  withState(t, async (stateDirectory) => {
    delete process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
    let calls = 0;
    assert.deepEqual(await runAmuxV19MaxSessionQueueEntryOnce({ origin,
      stateDirectory, fetchImpl: async () => { calls++; return Response.json({}); },
    }), { kind: "refused" });
    assert.equal(calls, 0);
  }));
