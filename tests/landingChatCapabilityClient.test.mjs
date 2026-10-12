import assert from "node:assert/strict";
import test from "node:test";
import { startLandingChatCapabilityRead } from "../lib/landingChatCapabilityClient.ts";

const nextTask = () => new Promise(resolve => setImmediate(resolve));

test("refused and cancelled reads consume the unused body without enabling Chat", async () => {
  for (const cancelled of [false, true]) {
    const response = new Response("Unavailable", { status: 503 });
    let complete;
    const values = [];
    const cancel = startLandingChatCapabilityRead({
      accountUserId: "account-a",
      fetcher: () => new Promise(resolve => { complete = resolve; }),
      onResolved: value => values.push(value),
    });
    if (cancelled) cancel();
    complete(response);
    await nextTask();
    assert.equal(response.bodyUsed, true);
    assert.deepEqual(values, cancelled ? [] : [false]);
  }
});

test("marketing never asks for a Guest Auto authority", async () => {
  let calls = 0;
  const values = [];
  const cancel = startLandingChatCapabilityRead({
    accountUserId: null,
    fetcher: async () => { calls += 1; throw new Error("unexpected fetch"); },
    onResolved: value => values.push(value),
  });
  cancel();
  await nextTask();
  assert.equal(calls, 0);
  assert.deepEqual(values, []);
});

test("only a strict authenticated offer opens Chat, using a private no-store read", async () => {
  const values = [];
  startLandingChatCapabilityRead({
    accountUserId: "account-a",
    fetcher: async (url, options) => {
      assert.equal(url, "/api/marketing/chat-entry");
      assert.equal(options.method, "GET");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ offered: true });
    },
    onResolved: value => values.push(value),
  });
  await nextTask();
  assert.deepEqual(values, [true]);
});

test("missing marketing endpoint, malformed offers and network errors keep Chat unavailable", async () => {
  for (const fetcher of [
    async () => new Response("Not found", { status: 404 }),
    async () => Response.json({ offered: "true" }),
    async () => Response.json({ offered: 1 }),
    async () => Response.json([{ offered: true }]),
    async () => Response.json({ autoSelection: { offered: true } }),
    async () => Response.json({}),
    async () => { throw new Error("network failed"); },
  ]) {
    const values = [];
    startLandingChatCapabilityRead({ accountUserId: "account-a", fetcher, onResolved: value => values.push(value) });
    await nextTask();
    assert.deepEqual(values, [false]);
  }
});

test("cancelled account reads cannot enable a later account or the same account after a return", async () => {
  const values = [];
  const responses = [];
  const signals = [];
  const begin = (id, label) => startLandingChatCapabilityRead({
    accountUserId: id,
    fetcher: async (_url, options) => {
      signals.push(options.signal);
      return new Promise(resolve => responses.push(resolve));
    },
    onResolved: value => values.push({ label, value }),
  });
  const cancelFirstA = begin("account-a", "first A");
  cancelFirstA();
  const cancelB = begin("account-b", "B");
  cancelB();
  begin("account-a", "current A");
  responses[0](Response.json({ offered: true }));
  responses[1](Response.json({ offered: true }));
  responses[2](Response.json({ offered: false }));
  await nextTask();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(values, [{ label: "current A", value: false }]);
});
