import assert from "node:assert/strict";
import test from "node:test";
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
test("guest challenges reach the existing coordinator and its token is forwarded only on retry", async () => {
  await assert.rejects(requestChatLocationIntent("Where am I?", async () => Response.json({ code: "TURNSTILE_REQUIRED" }, { status: 403 })), { code: "TURNSTILE_REQUIRED" });
  assert.equal(await requestChatLocationIntent("Where am I?", async (_path, init) => {
    assert.equal(JSON.parse(init.body).turnstileToken, "synthetic-challenge");
    return Response.json({ requiresLocation: true });
  }, { turnstileToken: "synthetic-challenge" }), true);
});
test("a stalled intent endpoint cannot hold the composer indefinitely", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = requestChatLocationIntent("Where am I?", (_path, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true });
  }));
  t.mock.timers.tick(10_000);
  assert.equal(await result, false);
});
