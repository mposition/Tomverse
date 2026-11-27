import assert from "node:assert/strict";
import test from "node:test";
import { voiceBody, voiceRequestInput, type VoiceBody, type VoiceStreamEvent } from "../src/voice-contract";
import { createVoiceHost } from "../src/host/voice-host";

const start = (id = crypto.randomUUID()) => ({ id, body: { action: "start", requestId: crypto.randomUUID(), conversationId: null, sdp: "v=0" } as const });

function harness(options: { allowed?: boolean; reply?: (body: VoiceBody, signal: AbortSignal) => Promise<Response> | Response } = {}) {
  const state = { allowed: options.allowed ?? true, now: 1_000, stops: 0 };
  const sent: VoiceBody[] = [];
  const events: VoiceStreamEvent[] = [];
  const host = createVoiceHost({
    allowed: () => state.allowed,
    send: async (body, signal) => { sent.push(body); return (options.reply ?? (() => Response.json({ ok: true })))(body, signal); },
    emit: (event) => events.push(event),
    notifyStop: () => { state.stops += 1; },
    now: () => state.now,
  });
  return { host, state, sent, events };
}

/** A session's reply: an event stream the test feeds and ends. */
function session() {
  let feed!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { feed = controller; } });
  const encoder = new TextEncoder();
  return { response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    push: (text: string) => feed.enqueue(encoder.encode(text)), end: () => feed.close(), fail: () => feed.error(new Error("lost")) };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("the window may ask for the server's five voice actions and nothing else", () => {
  assert.equal(voiceBody.safeParse({ action: "stop", reservationId: "r1" }).success, true);
  assert.equal(voiceBody.safeParse({ action: "status", requestId: crypto.randomUUID() }).success, true);
  assert.equal(voiceBody.safeParse({ action: "status" }).success, false);
  assert.equal(voiceBody.safeParse({ action: "history", conversationId: "c1" }).success, true);
  assert.equal(voiceBody.safeParse({ action: "result", reservationId: "r1", delegationId: "d1", conversationId: "c1", sourceUserMessageId: "m1" }).success, true);
  for (const refused of [{ action: "result", reservationId: "r1", delegationId: "d1", conversationId: "c1", sourceUserMessageId: "m1", answer: "words from the window" },
    { action: "start", requestId: crypto.randomUUID(), conversationId: null, sdp: "v=0", model: "another" },
    { action: "settle", reservationId: "r1" }, { action: "start", requestId: "not-a-uuid", conversationId: null, sdp: "v=0" },
    { action: "start", requestId: crypto.randomUUID(), conversationId: null, sdp: "x".repeat(64_001) }]) {
    assert.equal(voiceBody.safeParse(refused).success, false, JSON.stringify(refused).slice(0, 80));
  }
  assert.equal(voiceRequestInput.safeParse({ id: "1", body: { action: "stop", reservationId: "r1" } }).success, false);
  assert.equal(voiceRequestInput.safeParse({ ...start(), path: "/api/chat" }).success, false);
});

test("the microphone opens once per press of Start, within a few seconds, and only where the conversation is offered", () => {
  const { host, state } = harness();
  assert.equal(host.mayOpenMicrophone(), false, "nothing was pressed");
  assert.equal(host.arm(), true);
  assert.equal(host.mayOpenMicrophone(), true);
  host.microphoneOpened();
  assert.equal(host.mayOpenMicrophone(), false, "one press, one microphone");
  assert.equal(host.arm(), true);
  state.now += 15_001;
  assert.equal(host.mayOpenMicrophone(), false, "the press has expired");
  state.allowed = false;
  assert.equal(host.arm(), false);
  assert.equal(host.mayOpenMicrophone(), false);
});

test("a session starts only behind the microphone that was opened for it, one at a time, and its events are passed on in order", async () => {
  const stream = session();
  const { host, events, sent } = harness({ reply: (body) => body.action === "start" ? stream.response : Response.json({ ok: true }) });
  assert.equal((await host.request(start())).status, 403, "no microphone was opened");
  assert.equal(sent.length, 0);
  host.arm();
  assert.equal((await host.request(start())).status, 403, "armed, but the microphone was never opened");
  host.microphoneOpened();
  const first = start();
  assert.deepEqual(await host.request(first), { status: 200, stream: true });
  assert.equal(host.active(), true);
  assert.equal(host.arm(), false, "a second session cannot be armed while one is open");
  assert.equal((await host.request(start())).status, 403);
  stream.push("data: {\"type\":\"ready\"}\n\n");
  stream.push("data: {\"type\":\"started\"}\n\n");
  await settle();
  assert.deepEqual(events, [{ id: first.id, chunk: "data: {\"type\":\"ready\"}\n\n" }, { id: first.id, chunk: "data: {\"type\":\"started\"}\n\n" }]);
  // The other actions go through while the session is open.
  const receipt = { id: crypto.randomUUID(), body: { action: "result", reservationId: "r1", delegationId: "d1", conversationId: "c1", sourceUserMessageId: "m1" } as const };
  assert.deepEqual(await host.request(receipt), { status: 200, body: "{\"ok\":true}" });
  stream.end();
  await settle();
  assert.deepEqual(events.at(-1), { id: first.id, end: "done" });
  assert.equal(host.active(), false);
  assert.equal(host.arm(), true, "the next session can be started");
});

test("a lost stream is reported as lost, and a request that never reached the server has no status", async () => {
  const stream = session();
  const { host, events } = harness({ reply: (body) => { if (body.action === "start") return stream.response; throw new Error("offline"); } });
  host.arm(); host.microphoneOpened();
  const first = start();
  await host.request(first);
  stream.fail();
  await settle();
  assert.deepEqual(events.at(-1), { id: first.id, end: "error" });
  assert.equal(host.active(), false);
  assert.deepEqual(await host.request({ id: crypto.randomUUID(), body: { action: "stop", reservationId: "r1" } }), { status: 0 });
});

test("a refusal that is not an event stream is handed back whole and leaves no session", async () => {
  const { host } = harness({ reply: () => Response.json({ code: "VOICE_PROVIDER_UNAVAILABLE", reservationId: "r9" }, { status: 502 }) });
  host.arm(); host.microphoneOpened();
  const reply = await host.request(start());
  assert.equal(reply.status, 502);
  assert.deepEqual(JSON.parse(reply.body!), { code: "VOICE_PROVIDER_UNAVAILABLE", reservationId: "r9" });
  assert.equal(host.active(), false);
});

test("once the conversation is withdrawn nothing new starts, but a session can still be ended and its cost read", async () => {
  const { host, state, sent } = harness();
  state.allowed = false;
  assert.equal((await host.request({ id: crypto.randomUUID(), body: { action: "history", conversationId: "c1" } })).status, 503);
  assert.equal((await host.request({ id: crypto.randomUUID(), body: { action: "result", reservationId: "r1", delegationId: "d1", conversationId: "c1", sourceUserMessageId: "m1" } })).status, 503);
  assert.equal(sent.length, 0);
  assert.equal((await host.request({ id: crypto.randomUUID(), body: { action: "stop", reservationId: "r1" } })).status, 200);
  assert.equal((await host.request({ id: crypto.randomUUID(), body: { action: "status", reservationId: "r1" } })).status, 200);
  assert.deepEqual(sent.map(({ action }) => action), ["stop", "status"]);
});

test("ending the account's sessions tells the window once, and cuts the open requests only when the account is gone", async () => {
  const stream = session();
  let aborted = false;
  const { host, state, events } = harness({ reply: (body, signal) => {
    if (body.action !== "start") return Response.json({ ok: true });
    signal.addEventListener("abort", () => { aborted = true; stream.fail(); });
    return stream.response;
  } });
  host.stop(true);
  assert.equal(state.stops, 0, "nothing was open");
  host.arm(); host.microphoneOpened();
  const first = start();
  await host.request(first);
  host.stop(false);
  assert.equal(state.stops, 1);
  assert.equal(aborted, false, "asleep or withdrawn: the window ends its own session, which also ends it on the server");
  host.stop(true);
  await settle();
  assert.equal(aborted, true);
  assert.deepEqual(events.at(-1), { id: first.id, end: "error" });
  host.abort(crypto.randomUUID());
});
