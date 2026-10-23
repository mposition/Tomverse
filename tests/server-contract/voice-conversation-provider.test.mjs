import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createVoiceProviderSession, sendVoiceProviderResult } from "../../lib/voiceConversationProvider.ts";
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
test("a valid provider session id survives a malformed SDP and is hung up without creating another session", async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return Response.json(calls.length === 1 ? { session: { id: "live_known" }, transport: {} } : {}); };
  const result = await createVoiceProviderSession("fixture-offer", []);
  assert.deepEqual(result, { ok: false, rejected: false, sessionId: "live_known" });
  assert.equal(calls.length, 2); assert.match(calls[1], /live_known\/hangup$/);
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
