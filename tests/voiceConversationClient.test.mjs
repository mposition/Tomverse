import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceConversationClient } from "../components/chat/voiceConversationClient.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let n = 0; n < 50; n++) { if (fn()) return; await tick(); } assert.fail("Condition did not become true."); }

function world() {
  const states = [], requests = [], backend = [];
  let output;
  let stopped = 0, peerClosed = 0;
  const track = { stop() { stopped++; }, enabled: true };
  const microphone = { getTracks: () => [track], getAudioTracks: () => [track] };
  const audio = { pause() {}, play: async () => {}, srcObject: null };
  const peer = {
    iceGatheringState: "complete", connectionState: "connected", localDescription: null,
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    async setLocalDescription(value) { this.localDescription = value; },
    async setRemoteDescription(value) { this.remote = value; },
    addTrack() {}, createDataChannel() {}, close() { peerClosed++; },
  };
  const send = value => output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  const client = createVoiceConversationClient({
    deps: {
      getMicrophone: async () => microphone, createPeer: () => peer, createAudio: () => audio,
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body); requests.push(body);
        if (body.action === "start") return new Response(new ReadableStream({ start(c) { output = c; } }));
        if (body.action === "stop") { send({ type: "closed", confirmed: true, credits: 6 }); output.close(); }
        return Response.json({ ok: true });
      },
    },
    onChange: state => states.push(state),
    onRequest: async text => { backend.push(text); return { sourceUserMessageId: "91a27fea-6ceb-4c92-92e4-4fd77ac5a901", conversationId: "chat-1" }; },
  });
  return { client, states, requests, backend, peer, send, track, counts: () => ({ stopped, peerClosed }) };
}

test("real transport protocol delegates once through ordinary Chat and sends only its saved receipt", async () => {
  const w = world(); const running = w.client.start("chat-1");
  await until(() => w.requests.length === 1);
  w.send({ type: "ready", reservationId: "voice-1", sdp: "answer" });
  w.send({ type: "started" });
  await until(() => w.states.at(-1).status === "listening");
  assert.equal(w.peer.remote.sdp, "answer");
  const event = { type: "session.input_transcript.delta", event_id: "u1", delta: "Search for this", start_ms: 0, end_ms: 800 };
  w.send({ type: "transcript", event }); w.send({ type: "transcript", event });
  w.send({ type: "delegation", delegationId: "d1", text: "Search for this" });
  w.send({ type: "delegation", delegationId: "d1", text: "Search for this" });
  await until(() => w.requests.some(r => r.action === "result"));
  assert.deepEqual(w.backend, ["Search for this"]);
  assert.equal(w.states.at(-1).captions[0].text, "Search for this");
  const result = w.requests.find(r => r.action === "result");
  assert.equal(result.conversationId, "chat-1"); assert.equal("content" in result, false);
  w.client.toggleMicrophone(); assert.equal(w.track.enabled, false);
  await w.client.stop(); await running;
  assert.equal(w.states.at(-1).status, "ended");
  assert.equal(w.states.at(-1).confirmed, true);
  assert.ok(w.counts().stopped > 0); assert.ok(w.counts().peerClosed > 0);
});

test("denied microphone access makes no paid request", async () => {
  let calls = 0; const states = [];
  const client = createVoiceConversationClient({ deps: {
    getMicrophone: async () => { throw new Error("NotAllowedError"); },
    createPeer: () => { assert.fail("Peer must not be created"); }, createAudio: () => null,
    fetch: async () => { calls++; },
  }, onChange: state => states.push(state), onRequest: async () => { assert.fail(); } });
  await client.start(null);
  assert.equal(calls, 0); assert.equal(states.at(-1).status, "error"); client.destroy();
});

test("a late microphone grant after unmount is immediately released", async () => {
  let grant, stopped = 0, calls = 0;
  const client = createVoiceConversationClient({ deps: {
    getMicrophone: () => new Promise(resolve => { grant = resolve; }), createPeer: () => null, createAudio: () => null,
    fetch: async () => { calls++; },
  }, onChange() {}, onRequest: async () => { assert.fail(); } });
  const running = client.start(null); client.destroy();
  grant({ getTracks: () => [{ stop() { stopped++; } }] }); await running;
  assert.equal(stopped, 1); assert.equal(calls, 0);
});
