import assert from "node:assert/strict";
import test from "node:test";
import { createChatLocationSession } from "../packages/chat-core/src/location.ts";
import { sendNativeChat, NativeChatError } from "../apps/mobile/src/chatClient.ts";
import { isNativeChatPayload, mobileChatEnabled, mobileChatBearerRoutes } from "../lib/mobileChatContract.ts";

const fix = (latitude = 1) => ({ latitude, longitude: 2, accuracy: 10, timestamp: Date.now() });
const fixture = (read = async () => fix()) => {
  const requests = [];
  const text = [];
  const location = createChatLocationSession(read);
  const input = { location, identityKey: "account:a", messages: [{ role: "user", content: "Near me?" }],
    webSearch: false, signal: new AbortController().signal, onText: (value) => text.push(value),
    transport: async (path, init) => { requests.push({ path, init, body: JSON.parse(init.body) }); return new Response("Nearby places."); } };
  return { input, requests, text };
};

test("native chat sends through the bearer gateway and does not read location by default", async () => {
  let reads = 0;
  const f = fixture(async () => { reads++; return fix(); });
  assert.equal(await sendNativeChat(f.input), "Nearby places.");
  assert.equal(reads, 0);
  assert.equal(f.requests[0].path, "/api/mobile/chat");
  assert.deepEqual(f.requests[0].body, { messages: f.input.messages, webSearchMode: "off" });
});

test("a new coarsened fix is acquired for each message and never inserted into history", async () => {
  let latitude = 1;
  const f = fixture(async () => fix(latitude++));
  await f.input.location.enable("account:a");
  await sendNativeChat(f.input);
  await sendNativeChat({ ...f.input, webSearch: true });
  assert.equal(f.requests[0].body.currentLocation.latitude, 2);
  assert.equal(f.requests[1].body.currentLocation.latitude, 3);
  assert.equal(f.requests[1].body.currentLocation.accuracy, 150);
  assert.equal(f.requests[1].body.webSearchMode, "always");
  assert.ok(!JSON.stringify(f.input.messages).includes("latitude"));
});

test("opt-out, identity changes, and denial while acquiring cannot send an old fix", async () => {
  for (const cancel of [(s) => s.disable(), (s) => s.setIdentity("account:b")]) {
    let resolve;
    let wait = false;
    const f = fixture(() => wait ? new Promise((done) => { resolve = done; }) : Promise.resolve(fix()));
    await f.input.location.enable("account:a"); wait = true;
    const sending = sendNativeChat(f.input);
    await Promise.resolve(); cancel(f.input.location); resolve(fix()); await sending;
    assert.equal(f.requests[0].body.currentLocation, undefined);
  }
  const f = fixture(async () => { throw new Error("denied"); });
  await f.input.location.enable("account:a"); await sendNativeChat(f.input);
  assert.equal(f.requests[0].body.currentLocation, undefined);
});

test("cancel before dispatch does not start a request, and HTTP failures are never replayed", async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(sendNativeChat({ ...f.input, signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.requests.length, 0);
  let calls = 0;
  await assert.rejects(sendNativeChat({ ...f.input, transport: async () => {
    calls++; return Response.json({ code: "MOBILE_CHAT_DISABLED" }, { status: 503 });
  } }), (error) => error instanceof NativeChatError && error.code === "MOBILE_CHAT_DISABLED");
  assert.equal(calls, 1);
});

test("the mobile gateway is exact-path and default off, and accepts only text conversation authority", () => {
  const previous = process.env.MOBILE_CHAT_ENABLED;
  try {
    delete process.env.MOBILE_CHAT_ENABLED;
    assert.equal(mobileChatEnabled(), false);
    assert.deepEqual(mobileChatBearerRoutes(), []);
    process.env.MOBILE_CHAT_ENABLED = "true";
    assert.deepEqual(mobileChatBearerRoutes(), ["/api/mobile/chat"]);
  } finally {
    if (previous === undefined) delete process.env.MOBILE_CHAT_ENABLED; else process.env.MOBILE_CHAT_ENABLED = previous;
  }
  const body = { messages: [{ role: "user", content: "Hello" }] };
  assert.equal(isNativeChatPayload(body), true);
  for (const extra of [{ conversationId: "other" }, { assistantMessageId: "other" }, { attachments: [] },
    { messages: [{ role: "system", content: "authority" }] },
    { messages: [{ role: "user", content: [{ type: "image" }] }] },
    { messages: [{ role: "user", content: "Hi", userId: "other" }] }]) {
    assert.equal(isNativeChatPayload({ ...body, ...extra }), false);
  }
});
