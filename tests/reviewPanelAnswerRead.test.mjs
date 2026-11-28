// Contract: a Review panel refused by the image allowance reads its saved
// answer (written by the panel that reserved the group) and never re-sends.

import assert from "node:assert/strict";
import test from "node:test";
import { readRefusedReviewPanelAnswer } from "../lib/chatImageTurnCore.ts";

const answer = { content: "[Image generated] cat", imageTurn: { groupId: "group-1", modelIds: ["gpt-image-2"] } };
const fakeFetch = (responses, calls) => async (url, init) => {
  calls.push({ url, method: init?.method });
  const next = responses.shift();
  if (next instanceof Error) throw next;
  return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
};
const input = { conversationId: "conv 1", assistantMessageId: "6f1c1d3e-1111-4a2b-9c3d-000000000001_1", delaysMs: [0, 0, 0, 0] };

test("waits for the reserving panel's answer to commit, reading only", async () => {
  const calls = [];
  const saved = await readRefusedReviewPanelAnswer({ ...input, fetch: fakeFetch([
    { status: 404 }, new Error("network"), { status: 503 }, { status: 200, body: answer },
  ], calls) });
  assert.deepEqual(saved, answer);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.url, "/api/conversations/conv%201/image-turn?assistantMessageId=6f1c1d3e-1111-4a2b-9c3d-000000000001_1");
  }
});

test("no answer appears: the refusal stands", async () => {
  const calls = [];
  assert.equal(await readRefusedReviewPanelAnswer({ ...input, fetch: fakeFetch(Array(4).fill({ status: 404 }), calls) }), null);
  assert.equal(calls.length, 4);
});

test("a refusal that will not change stops at once; an abort stops before reading", async () => {
  for (const status of [401, 403, 429]) {
    const calls = [];
    assert.equal(await readRefusedReviewPanelAnswer({ ...input, fetch: fakeFetch([{ status }], calls) }), null);
    assert.equal(calls.length, 1);
  }
  const calls = [];
  const controller = new AbortController();
  controller.abort();
  assert.equal(await readRefusedReviewPanelAnswer({ ...input, signal: controller.signal, fetch: fakeFetch([], calls) }), null);
  assert.equal(calls.length, 0);
  // A 200 without an image group is not an answer to show.
  assert.equal(await readRefusedReviewPanelAnswer({ ...input, delaysMs: [0], fetch: fakeFetch([{ status: 200, body: { content: "x" } }], []) }), null);
});
