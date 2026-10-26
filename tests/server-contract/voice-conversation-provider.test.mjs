import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createVoiceProviderSession, sendVoiceProviderResult } from "../../lib/voiceConversationProvider.ts";
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test("provider creation obeys the remaining funding deadline and refuses invalid bounds before dispatch", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    await new Promise((resolve, reject) => {
      const keepalive = setTimeout(resolve, 1_000);
      init.signal.addEventListener("abort", () => { clearTimeout(keepalive); reject(init.signal.reason); }, { once: true });
    });
    assert.fail("A slow provider must be aborted at the funded startup deadline");
  };
  for (const value of [0, -1, 15_001, NaN]) await assert.rejects(createVoiceProviderSession("fixture", [], value), /Invalid voice startup deadline/);
  assert.equal(calls, 0);
  await assert.rejects(createVoiceProviderSession("fixture", [], 20), error => error.name === "TimeoutError");
  assert.equal(calls, 1);
});

test("WebRTC creation uses the documented session-scoped frontend permissions and event selectors", async () => {
  // https://developers.openai.com/api/reference/resources/live/methods/create
  let submitted;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/live/sessions");
    assert.equal(init.method, "POST"); submitted = JSON.parse(init.body);
    // The API rejects a top-level client field or string server selectors.
    assert.deepEqual(Object.keys(submitted).sort(), ["session", "transport"]);
    assert.deepEqual(submitted.session.client.data_channel, {
      allowed_client_events: [],
      allowed_server_events: [{ type: "session.started" }, { type: "session.closed" }],
    });
    return Response.json({ session: { id: "live_created" }, transport: { type: "webrtc", sdp: "fixture-answer" } }, { status: 201 });
  };
  assert.deepEqual(await createVoiceProviderSession("fixture-offer", [
    { role: "user", content: "Our code name is Cedar." },
    { role: "assistant", content: "Cedar." },
  ]), { ok: true, sessionId: "live_created", sdp: "fixture-answer" });
  assert.equal(submitted.session.store, false);
  assert.deepEqual(submitted.session.delegation, { type: "client" });
  assert.deepEqual(submitted.transport, { type: "webrtc", sdp: "fixture-offer" });
  assert.deepEqual(submitted.session.input.map(message => [message.role, message.content[0].type]), [["user", "input_text"], ["assistant", "output_text"]]);
});
test("a malformed SDP returns its session identity for durable closing before any further provider command", async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return Response.json(calls.length === 1 ? { session: { id: "live_known" }, transport: {} } : {}); };
  const result = await createVoiceProviderSession("fixture-offer", []);
  assert.deepEqual(result, { ok: false, rejected: false, sessionId: "live_known" });
  assert.equal(calls.length, 1);
});
test("answer chunks use the existing sideband, preserve UTF8 limits and never close its metering receiver", async () => {
  const socket = new EventEmitter(); socket.OPEN = 1; socket.readyState = 1; const commands = [];
  socket.close = () => assert.fail("The command sender must not close the shared receiver");
  socket.send = value => { const event = JSON.parse(value); commands.push(event); queueMicrotask(() => socket.emit("message", JSON.stringify({ type: "session.commentary.appended", client_event_id: event.event_id }))); };
  const answer = "안녕하세요, Tomverse. ".repeat(100);
  await sendVoiceProviderResult(socket, "delegation-1", answer);
  assert.equal(commands.map(c => c.content).join(""), answer);
  assert.ok(commands.length > 1); assert.ok(commands.every(c => Buffer.byteLength(c.content, "utf8") <= 480));
});
