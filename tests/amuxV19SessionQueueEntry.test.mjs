import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runAmuxV19SessionQueueEntryOnce } from
  "../lib/amux/ideaLocalSessionQueueEntry.mjs";
import { amuxV19QueueCursorState } from
  "../lib/amux/ideaLocalSessionQueueCursorState.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";

const origin = "https://tomverse.test";
const previousOrigin = process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = origin;
after(() => {
  if (previousOrigin === undefined)
    delete process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV];
  else process.env[AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] = previousOrigin;
});

test("a later queue page is reached across process-style ticks", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "amux-v19-queue-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = amuxV19QueueCursorState(stateDirectory);
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.after === "page-8") return Response.json({ candidates: [{
      reservationId: "ec61a12d-d02a-478f-a499-aea9dd752270",
      ideaId: "idea:session-123", modelId: "claude-opus-5-5",
      expiresAt: "2026-10-18T00:00:00.000Z",
    }], hasMore: false, nextCursor: null });
    const page = body.after ? Number(body.after.slice(5)) + 1 : 1;
    return Response.json({ candidates: Array.from({ length: 32 }, () => ({
      reservationId: "ec61a12d-d02a-478f-a499-aea9dd752270",
      ideaId: "idea:session-123", modelId: "unsupported-model",
      expiresAt: "2026-10-18T00:00:00.000Z",
    })), hasMore: true, nextCursor: `page-${page}` });
  };
  const input = { origin, agentSecret: "a".repeat(32),
    fetchImpl, stateDirectory };
  assert.deepEqual(await runAmuxV19SessionQueueEntryOnce(input),
    { kind: "more_unexamined" });
  assert.equal(await state.read(), "page-8");
  assert.deepEqual(await runAmuxV19SessionQueueEntryOnce(input),
    { kind: "discovered" });
  assert.equal(await state.read(), null);
  assert.deepEqual(calls[0], {});
  assert.deepEqual(calls[8], { after: "page-8" });
  assert.equal(calls.length, 9);
});

test("a stale server cursor and a corrupt local hint recover without a claim", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "amux-v19-queue-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = amuxV19QueueCursorState(stateDirectory);
  await state.save("stale-cursor");
  const input = { origin, agentSecret: "a".repeat(32), stateDirectory,
    fetchImpl: async () => new Response(null, { status: 400 }) };
  assert.deepEqual(await runAmuxV19SessionQueueEntryOnce(input),
    { kind: "unavailable" });
  assert.equal(await state.read(), null);
  await writeFile(join(stateDirectory, "queue-cursor"), "bad cursor\n",
    { mode: 0o600 });
  assert.deepEqual(await runAmuxV19SessionQueueEntryOnce(input),
    { kind: "unavailable" });
  assert.equal(await state.read(), null);
});

test("a transient queue failure keeps the continuation for the next tick", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "amux-v19-queue-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = amuxV19QueueCursorState(stateDirectory);
  await state.save("page-8");
  const result = await runAmuxV19SessionQueueEntryOnce({
    origin, agentSecret: "a".repeat(32), stateDirectory,
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  assert.deepEqual(result, { kind: "unavailable" });
  assert.equal(await state.read(), "page-8");
});

test("an over-permissive local hint is discarded before queue access",
  { skip: process.platform !== "linux" }, async (t) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "amux-v19-queue-test-"));
    t.after(() => rm(stateDirectory, { recursive: true, force: true }));
    const state = amuxV19QueueCursorState(stateDirectory);
    await state.save("page-8");
    await chmod(join(stateDirectory, "queue-cursor"), 0o644);
    let calls = 0;
    const result = await runAmuxV19SessionQueueEntryOnce({
      origin, agentSecret: "a".repeat(32), stateDirectory,
      fetchImpl: async () => { calls += 1; throw new Error("no queue read"); },
    });
    assert.deepEqual(result, { kind: "unavailable" });
    assert.equal(await state.read(), null);
    assert.equal(calls, 0);
  });

test("a resumed empty tail is not reported as an empty queue", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "amux-v19-queue-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = amuxV19QueueCursorState(stateDirectory);
  await state.save("page-8");
  const result = await runAmuxV19SessionQueueEntryOnce({
    origin, agentSecret: "a".repeat(32), stateDirectory,
    fetchImpl: async () => Response.json({ candidates: [],
      hasMore: false, nextCursor: null }),
  });
  assert.deepEqual(result, { kind: "catalog_unapproved" });
  assert.equal(await state.read(), null);
});
