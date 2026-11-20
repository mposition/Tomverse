import assert from "node:assert/strict";
import test from "node:test";
import { createChatLocationSession } from "@tomverse/chat-core";
import { chatLocationSession, prepareFreshChatLocationIntent } from "../lib/chatLocationClient";

test("stopping a saved-turn reader preserves its in-flight decision for a reconnect", async t => {
  const scope = "account:reconnect";
  const text = "Where am I?";
  const response = Promise.withResolvers<Response>();
  const reading = Promise.withResolvers<void>();
  const request = t.mock.method(globalThis, "fetch", async () => response.promise);
  chatLocationSession.setIdentity(scope);
  const reader = prepareFreshChatLocationIntent(scope, "reconnect", text).handoff();
  let deviceReads = 0;
  const turns = createChatLocationSession(async () => {
    deviceReads++;
    return { latitude: -27.47, longitude: 153.03, accuracy: 100, timestamp: Date.now() };
  });
  turns.setIdentity(scope);
  const first = new AbortController();
  const stopped = turns.readForTurn(scope, first.signal, {
    turnId: "saved",
    requiresLocation: async () => {
      reading.resolve();
      return (await reader.readForSavedTurn(scope, text, first.signal, () => {
        assert.fail("a stopped reader must not record overlap");
      })) === true;
    },
  });
  await reading.promise;
  first.abort();
  await assert.rejects(stopped, { name: "AbortError" });
  const reconnected = turns.readForTurn(scope, new AbortController().signal, {
    turnId: "saved",
    requiresLocation: () => assert.fail("the saved decision is shared by turn id"),
  });
  assert.equal(deviceReads, 0);
  response.resolve(Response.json({ preparationOutcome: "classified", requiresLocation: true }));
  const fix = await reconnected;
  assert.ok(fix && turns.canShare(fix, scope));
  assert.equal(deviceReads, 1);
  assert.equal(request.mock.callCount(), 1);
});

test("only a different authored question on the same account can fall back after an uncertain call", async t => {
  const scope = "account:fallback";
  const request = t.mock.method(globalThis, "fetch", async () => {
    throw Error("transport outcome unknown");
  });
  chatLocationSession.setIdentity(scope);
  const reader = prepareFreshChatLocationIntent(scope, "fallback", "first question").handoff();
  const read = (owner: string, text: string) => reader.readForSavedTurn(owner, text,
    new AbortController().signal, (_duration, overlap) => assert.equal(overlap, undefined));
  assert.equal(await read(scope, "first question"), false);
  assert.equal(await read(scope, "different saved text"), null);
  chatLocationSession.setIdentity("account:other");
  assert.equal(await read("account:other", "different saved text"), false);
  assert.equal(await read(scope, "first question"), false);
  assert.equal(await read(scope, "different saved text"), false);
  assert.equal(request.mock.callCount(), 1);
});
