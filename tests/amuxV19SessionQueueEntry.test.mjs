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
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (new URL(url).pathname.endsWith("/reference-pin")) {
      assert.deepEqual(body, { reservationId:
        "ec61a12d-d02a-478f-a499-aea9dd752270",
      ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
      referenceOrdinal: 0 });
      return Response.json({ referenceCount: 1,
        pinnedCommitSha: "a".repeat(40) });
    }
    calls.push(body);
    if (body.after === "page-8") return Response.json({ candidates: [{
      reservationId: "ec61a12d-d02a-478f-a499-aea9dd752270",
      ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
      provider: "anthropic", modelId: "claude-opus-5-5",
      expiresAt: "2026-10-18T00:00:00.000Z",
      nextInvocationOrdinal: 0,
    }], hasMore: false, nextCursor: null });
    const page = body.after ? Number(body.after.slice(5)) + 1 : 1;
    return Response.json({ candidates: Array.from({ length: 32 }, () => ({
      reservationId: "ec61a12d-d02a-478f-a499-aea9dd752270",
      ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
      provider: "anthropic", modelId: "unsupported-model",
      expiresAt: "2026-10-18T00:00:00.000Z",
      nextInvocationOrdinal: 0,
    })), hasMore: true, nextCursor: `page-${page}` });
  };
  const input = { origin, agentSecret: "a".repeat(32),
    fetchImpl, stateDirectory };
  assert.deepEqual(await runAmuxV19SessionQueueEntryOnce(input),
    { kind: "more_unexamined" });
  assert.equal(await state.read(), "page-8");
  assert.deepEqual(await runAmuxV19SessionQueueEntryOnce(input),
    { kind: "discovered", candidate: {
      reservationId: "ec61a12d-d02a-478f-a499-aea9dd752270",
      ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
      provider: "anthropic", modelId: "claude-opus-5-5",
      expiresAt: "2026-10-18T00:00:00.000Z",
      nextInvocationOrdinal: 0,
    }, pin: { kind: "pinned", referenceCount: 1,
      commitSha: "a".repeat(40) } });
  assert.equal(await state.read(), null);
  assert.deepEqual(calls[0], {});
  assert.deepEqual(calls[8], { after: "page-8" });
  assert.equal(calls.length, 9);
});

test("queue discovery refuses a candidate without its canonical pin", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "amux-v19-queue-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const paths = [];
  const result = await runAmuxV19SessionQueueEntryOnce({
    origin, agentSecret: "a".repeat(32), stateDirectory,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/analysis-queue")) return Response.json({
        candidates: [{ reservationId: "ec61a12d-d02a-478f-a499-aea9dd752270",
          ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
          provider: "anthropic", modelId: "claude-opus-5-5",
          expiresAt: "2026-10-18T00:00:00.000Z",
          nextInvocationOrdinal: 0 }],
        hasMore: false, nextCursor: null,
      });
      return new Response(null, { status: 409 });
    },
  });
  assert.deepEqual(result, { kind: "pin_unavailable" });
  assert.deepEqual(paths, [
    "/api/internal/amux/v19/analysis-queue",
    "/api/internal/amux/v19/reference-pin",
  ]);
});

test("a zero-reference idea remains a discoverable analysis candidate", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "amux-v19-queue-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const candidate = { reservationId: "ec61a12d-d02a-478f-a499-aea9dd752270",
    ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
    provider: "anthropic", modelId: "claude-opus-5-5", expiresAt: "2026-10-18T00:00:00.000Z",
    nextInvocationOrdinal: 0 };
  const result = await runAmuxV19SessionQueueEntryOnce({
    origin, agentSecret: "a".repeat(32), stateDirectory,
    fetchImpl: async (url) => new URL(url).pathname.endsWith("/analysis-queue")
      ? Response.json({ candidates: [candidate], hasMore: false,
        nextCursor: null })
      : Response.json({ referenceCount: 0, pinnedCommitSha: null }),
  });
  assert.deepEqual(result, { kind: "discovered", candidate,
    pin: { kind: "no_references", referenceCount: 0 } });
});

test("an unavailable pin does not starve a later claimable candidate", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "amux-v19-queue-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const first = { reservationId: "ec61a12d-d02a-478f-a499-aea9dd752270",
    ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
    provider: "anthropic", modelId: "claude-opus-5-5", expiresAt: "2026-10-18T00:00:00.000Z",
    nextInvocationOrdinal: 0 };
  const second = { ...first,
    reservationId: "ec61a12d-d02a-478f-a499-aea9dd752271",
    ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b176" };
  const pins = [];
  const result = await runAmuxV19SessionQueueEntryOnce({
    origin, agentSecret: "a".repeat(32), stateDirectory,
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname.endsWith("/analysis-queue")) {
        return Response.json({ candidates: [first, second], hasMore: false,
          nextCursor: null });
      }
      const body = JSON.parse(init.body);
      pins.push(body.reservationId);
      return body.reservationId === first.reservationId
        ? new Response(null, { status: 409 })
        : Response.json({ referenceCount: 1,
          pinnedCommitSha: "a".repeat(40) });
    },
  });
  assert.deepEqual(result, { kind: "discovered", candidate: second,
    pin: { kind: "pinned", referenceCount: 1,
      commitSha: "a".repeat(40) } });
  assert.deepEqual(pins, [first.reservationId, second.reservationId]);
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
