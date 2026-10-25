import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceConversationClient } from "../components/chat/voiceConversationClient.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let n = 0; n < 50; n++) { if (fn()) return; await tick(); } assert.fail("Condition did not become true."); }

function world() {
  const states = [], requests = [], backend = [];
  const behavior = { closeOnStop: true, status: { settled: false } };
  let output, startSignal;
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
        if (body.action === "start") { startSignal = init.signal; return new Response(new ReadableStream({ start(c) { output = c; } })); }
        if (body.action === "stop" && behavior.closeOnStop) { send({ type: "closed", confirmed: true, credits: 6 }); output.close(); }
        if (body.action === "status") return Response.json(behavior.status);
        return Response.json({ ok: true });
      },
    },
    onChange: state => states.push(state),
    onRequest: async text => { backend.push(text); return { sourceUserMessageId: "91a27fea-6ceb-4c92-92e4-4fd77ac5a901", conversationId: "chat-1" }; },
  });
  return { client, states, requests, backend, peer, audio, send, track, behavior, startSignal: () => startSignal, loseStream: () => output.error(new Error("Connection lost")), endStream: () => output.close(), counts: () => ({ stopped, peerClosed }) };
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

test("continuous funding preserves one connection beyond 900 seconds and drains a limit without reconnecting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const w = world(); const running = w.client.start("chat-1");
  await until(() => w.requests.length === 1);
  w.send({ type: "ready", reservationId: "voice-1", sdp: "answer", continuous: true, maxSeconds: null, closeAfterSeconds: 30 });
  w.send({ type: "started" }); await until(() => w.states.at(-1).status === "listening");
  for (let n = 0; n < 32; n++) {
    w.send({ type: "funding", closeAfterSeconds: 45 });
    w.send({ type: "heartbeat" }); await tick();
    t.mock.timers.tick(30_000); await tick();
  }
  assert.equal(w.states.at(-1).status, "listening");
  assert.equal(w.requests.filter(r => r.action === "start").length, 1);
  assert.equal(w.requests.filter(r => r.action === "stop").length, 0);
  w.send({ type: "limit", code: "PLAN_DAILY_CREDIT_LIMIT_REACHED" }); await tick();
  assert.equal(w.states.at(-1).status, "listening");
  assert.equal(w.states.at(-1).error, "PLAN_DAILY_CREDIT_LIMIT_REACHED");
  w.send({ type: "closed", confirmed: true, settled: true, seconds: 960, credits: 576 }); w.endStream(); await running;
  assert.equal(w.states.at(-1).credits, 576); assert.equal(w.states.at(-1).status, "ended");
  assert.equal(w.requests.filter(r => r.action === "start").length, 1);
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

for (const ending of ["loseStream", "endStream"]) {
  test(`${ending} retains a silent primary through worker takeover and trusts only saved billing`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
    const w = world(); w.behavior.closeOnStop = false;
    const running = w.client.start("chat-1");
    await until(() => w.requests.length === 1);
    w.send({ type: "ready", reservationId: "voice-1", sdp: "answer", maxSeconds: 300 });
    w.send({ type: "started" });
    await until(() => w.states.at(-1).status === "listening");
    w[ending](); await running;
    assert.equal(w.states.at(-1).status, "closing");
    assert.equal(w.states.at(-1).billingPending, true);
    assert.ok(w.counts().stopped > 0); assert.equal(w.audio.muted, true);
    assert.equal(w.counts().peerClosed, 0);
    t.mock.timers.tick(31_000); await tick();
    assert.equal(w.counts().peerClosed, 0);
    assert.equal(w.requests.filter(r => r.action === "start").length, 1);
    assert.equal(w.requests.filter(r => r.action === "stop").length, 1);
    assert.deepEqual(w.backend, []);
    assert.equal(w.states.at(-1).confirmed, false);
    w.behavior.status = { settled: true, confirmed: true, credits: 24, seconds: 40 };
    t.mock.timers.tick(15_000);
    await until(() => w.states.at(-1).status === "ended");
    assert.equal(w.states.at(-1).billingPending, false);
    assert.equal(w.states.at(-1).confirmed, true);
    assert.equal(w.states.at(-1).error, null);
    assert.equal(w.states.at(-1).credits, 24);
    assert.equal(w.counts().peerClosed, 1);
    w.client.destroy();
  });
}

test("disconnect cleanup keeps its deadline and later trusted settlement clears the warning", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const w = world(); w.behavior.closeOnStop = false;
  const running = w.client.start("chat-1");
  await until(() => w.requests.length === 1);
  w.send({ type: "ready", reservationId: "voice-1", sdp: "answer", maxSeconds: 15 });
  w.send({ type: "started" });
  await until(() => w.states.at(-1).status === "listening");
  t.mock.timers.tick(14_000);
  w.loseStream(); await running;
  t.mock.timers.tick(30_000); await tick();
  assert.equal(w.counts().peerClosed, 0);
  t.mock.timers.tick(1_000); await tick();
  assert.equal(w.counts().peerClosed, 1);
  assert.equal(w.states.at(-1).status, "ended");
  assert.equal(w.states.at(-1).confirmed, false);
  assert.equal(w.states.at(-1).billingPending, true);
  assert.equal(w.states.at(-1).error, "VOICE_CONNECTION_LOST");
  w.behavior.status = { settled: true, confirmed: true, seconds: 40, credits: 24 };
  t.mock.timers.tick(15_000);
  await until(() => w.states.at(-1).confirmed);
  assert.equal(w.states.at(-1).error, null);
  assert.equal(w.states.at(-1).billingPending, false);
  assert.equal(w.states.at(-1).credits, 24);
  assert.equal(w.counts().peerClosed, 1);
  w.client.destroy();
});

test("unmount releases a disconnected primary immediately and never dispatches another session", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const w = world(); w.behavior.closeOnStop = false;
  const running = w.client.start("chat-1");
  await until(() => w.requests.length === 1);
  w.send({ type: "ready", reservationId: "voice-1", sdp: "answer", maxSeconds: 300 });
  w.send({ type: "started" });
  await until(() => w.states.at(-1).status === "listening");
  w.loseStream(); await running;
  w.client.destroy();
  assert.equal(w.counts().peerClosed, 1);
  const previousStates = w.states.length;
  t.mock.timers.tick(90_000); await tick();
  assert.equal(w.states.length, previousStates);
  assert.equal(w.requests.filter(r => r.action === "start").length, 1);
});

test("late start and delegation events cannot reopen a user-stopped call", async t => {
  const w = world(); w.behavior.closeOnStop = false; t.after(() => w.client.destroy());
  const running = w.client.start("chat-1");
  await until(() => w.requests.length === 1);
  w.send({ type: "ready", reservationId: "voice-1", sdp: "answer", maxSeconds: 300 });
  w.send({ type: "started" });
  await until(() => w.states.at(-1).status === "listening");
  await w.client.stop();
  w.send({ type: "started" });
  w.send({ type: "delegation", delegationId: "late-task", text: "Do not dispatch after Stop" });
  await tick();
  assert.equal(w.states.at(-1).status, "closing");
  assert.deepEqual(w.backend, []);
  w.send({ type: "closed", confirmed: true, settled: true, credits: 6 }); w.endStream();
  await running;
});

test("heartbeat recovery aborts the server stream and cannot be reopened by late events", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const w = world(); w.behavior.closeOnStop = false; t.after(() => w.client.destroy());
  const running = w.client.start("chat-1");
  await until(() => w.requests.length === 1);
  w.send({ type: "ready", reservationId: "voice-1", sdp: "answer", maxSeconds: 300 });
  w.send({ type: "started" });
  await until(() => w.states.at(-1).status === "listening");
  t.mock.timers.tick(40_000); await tick();
  assert.equal(w.startSignal().aborted, true);
  assert.equal(w.states.at(-1).status, "closing");
  assert.equal(w.counts().peerClosed, 0);
  w.send({ type: "started" });
  w.send({ type: "delegation", delegationId: "late-task", text: "Do not dispatch during recovery" });
  await tick();
  assert.equal(w.states.at(-1).status, "closing");
  assert.deepEqual(w.backend, []);
  w.send({ type: "closed", confirmed: true, settled: true, seconds: 40, credits: 24 }); w.endStream();
  await running;
  assert.equal(w.states.at(-1).error, null);
  assert.equal(w.states.at(-1).confirmed, true);
  assert.equal(w.counts().peerClosed, 1);
});

test("a stopped call that loses its stream keeps takeover grace inside the original deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const w = world(); w.behavior.closeOnStop = false; t.after(() => w.client.destroy());
  const running = w.client.start("chat-1");
  await until(() => w.requests.length === 1);
  w.send({ type: "ready", reservationId: "voice-1", sdp: "answer", maxSeconds: 15 });
  w.send({ type: "started" });
  await until(() => w.states.at(-1).status === "listening");
  t.mock.timers.tick(14_000); await w.client.stop();
  w.endStream(); await running;
  t.mock.timers.tick(20_000); await tick();
  assert.equal(w.states.at(-1).status, "closing");
  assert.equal(w.counts().peerClosed, 0);
  assert.ok(w.counts().stopped > 0); assert.equal(w.audio.muted, true);
  assert.equal(w.requests.filter(r => r.action === "start").length, 1);
  assert.equal(w.requests.filter(r => r.action === "stop").length, 2);
  t.mock.timers.tick(11_000); await tick();
  assert.equal(w.counts().peerClosed, 1);
  assert.equal(w.states.at(-1).status, "ended");
  assert.equal(w.states.at(-1).billingPending, true);
});
