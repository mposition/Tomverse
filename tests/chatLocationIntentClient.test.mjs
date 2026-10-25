import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { requestChatLocationIntent } from "../packages/api-client/src/index.ts";

test("intent transport accepts only an explicit boolean and sends no device data", async () => {
  for (const value of [true, false, "true", null]) {
    const result = await requestChatLocationIntent("Where am I?", async (path, init) => {
      assert.equal(path, "/api/chat/location-intent");
      assert.deepEqual(JSON.parse(init.body), { text: "Where am I?" });
      return Response.json({ requiresLocation: value });
    });
    assert.equal(result, value === true);
  }
});
test("network and ordinary HTTP failures leave chat available", async () => {
  assert.equal(await requestChatLocationIntent("Where am I?", async () => { throw Error("offline"); }), false);
  assert.equal(await requestChatLocationIntent("Where am I?", async () => Response.json({ code: "UNAVAILABLE" }, { status: 503 })), false);
});
test("guest verification redeems the token before a separate tokenless analysis", async () => {
  await assert.rejects(requestChatLocationIntent("Where am I?", async () => Response.json({ code: "TURNSTILE_REQUIRED" }, { status: 403 })), { code: "TURNSTILE_REQUIRED" });
  const tokens = [];
  assert.equal(await requestChatLocationIntent("Where am I?", async (_path, init) => {
    const token = JSON.parse(init.body).turnstileToken;
    tokens.push(token);
    return Response.json({ requiresLocation: !token });
  }, { turnstileToken: "synthetic-challenge" }), true);
  assert.deepEqual(tokens, ["synthetic-challenge", undefined]);
});

test("slow verification and analysis have separate deadlines and never replay a token", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = [];
  const tokens = [];
  const result = requestChatLocationIntent("Where am I?", (_path, init) => new Promise((resolve, reject) => {
    tokens.push(JSON.parse(init.body).turnstileToken);
    pending.push(resolve);
    init.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true });
  }), { turnstileToken: "synthetic-challenge" });
  t.mock.timers.tick(9_000);
  pending.shift()(Response.json({ requiresLocation: false }));
  await setImmediate();
  assert.deepEqual(tokens, ["synthetic-challenge", undefined]);
  t.mock.timers.tick(9_000);
  pending.shift()(Response.json({ requiresLocation: true }));
  assert.equal(await result, true);
});

test("unknown or refused token redemption cannot fall through to chat with a spent token", async (t) => {
  let calls = 0;
  await assert.rejects(requestChatLocationIntent("Where am I?", async () => {
    calls++; throw Error("connection lost after redemption");
  }, { turnstileToken: "synthetic-challenge" }), { code: "TURNSTILE_UNAVAILABLE" });
  assert.equal(calls, 1);
  await assert.rejects(requestChatLocationIntent("Where am I?", async () => Response.json({ code: "TURNSTILE_FAILED" }, { status: 403 }), { turnstileToken: "synthetic-challenge" }), { code: "TURNSTILE_FAILED" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = requestChatLocationIntent("Where am I?", (_path, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true });
  }), { turnstileToken: "synthetic-challenge" });
  const rejected = assert.rejects(result, { code: "TURNSTILE_UNAVAILABLE" });
  t.mock.timers.tick(10_000);
  await rejected;
});
test("a stalled intent endpoint cannot hold the composer indefinitely", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = requestChatLocationIntent("Where am I?", (_path, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true });
  }));
  t.mock.timers.tick(10_000);
  assert.equal(await result, false);
});
