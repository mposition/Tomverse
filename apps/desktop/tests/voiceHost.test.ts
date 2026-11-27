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
  // That attempt spent the press.
  host.microphoneOpened();
  assert.equal((await host.request(start())).status, 403);
  host.arm();
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

test("a withdrawn feature only tells the window; ending from here closes the open requests", async () => {
  const stream = session();
  let aborted = false;
  const { host, state, events } = harness({ reply: (body, signal) => {
    if (body.action !== "start") return Response.json({ ok: true });
    signal.addEventListener("abort", () => { aborted = true; stream.fail(); });
    return stream.response;
  } });
  await host.end();
  assert.equal(state.stops, 0, "nothing was open");
  host.arm(); host.microphoneOpened();
  const first = start();
  await host.request(first);
  host.withdraw();
  assert.equal(state.stops, 1);
  assert.equal(aborted, false, "withdrawn by the server: the window ends its own session in the ordinary way");
  await host.end();
  await settle();
  assert.equal(aborted, true);
  assert.deepEqual(events.at(-1), { id: first.id, end: "error" });
  host.abort(crypto.randomUUID());
});

test("a press of Start is spent by time, by a start, by a failed start and by closing the conversation", async () => {
  const { host, state, sent } = harness({ reply: () => Response.json({ code: "VOICE_PROVIDER_UNAVAILABLE" }, { status: 502 }) });
  // Too late: the microphone was opened, but the start comes after the press has run out.
  host.arm(); host.microphoneOpened();
  state.now += 15_001;
  assert.equal((await host.request(start())).status, 403);
  assert.equal(sent.length, 0);
  // Opening the microphone gives the start its own few seconds, counted from then.
  host.arm();
  state.now += 14_000;
  host.microphoneOpened();
  state.now += 14_000;
  assert.equal((await host.request(start())).status, 502, "sent in time; the server refused it");
  // That start failed, and the press went with it: nothing starts later without a new one.
  assert.equal((await host.request(start())).status, 403);
  assert.equal(sent.length, 1);
  // The window closed the conversation (or it ended in an error) before any start.
  host.arm(); host.microphoneOpened();
  host.disarm();
  assert.equal((await host.request(start())).status, 403);
  assert.equal(host.mayOpenMicrophone(), false);
  assert.equal(sent.length, 1);
});

test("on sleep, a closing window, a quit or a lost account this process ends the session itself and waits for the server to be told", async () => {
  const stream = session();
  let aborted = false;
  const { host, sent, events } = harness({ reply: (body, signal) => {
    if (body.action !== "start") return Response.json({ ok: true });
    signal.addEventListener("abort", () => { aborted = true; stream.fail(); });
    return stream.response;
  } });
  host.arm(); host.microphoneOpened();
  const first = start();
  await host.request(first);
  // The session's name arrives in its first event, split across two pieces here.
  stream.push("data: {\"type\":\"ready\",\"reservationId\":\"voice-");
  stream.push("r7\",\"sdp\":\"v=0\"}\n\n");
  await settle();
  // The caller can hold a quit or a sign-out on this: it resolves once the server has answered the stop.
  let answered = false;
  const ending = host.end(async (body) => { sent.push(body); await settle(); answered = true; return Response.json({ ok: true }); });
  assert.equal(host.active(), false, "the session is over here at once");
  assert.equal(aborted, true, "and its stream is closed at once");
  assert.equal(answered, false);
  await ending;
  assert.equal(answered, true);
  assert.deepEqual(sent.at(-1), { action: "stop", reservationId: "voice-r7" });
  await settle();
  assert.deepEqual(events.at(-1), { id: first.id, end: "error" });
  // Nothing is left to end, so nothing more is sent; a server that cannot be reached does not hold the caller.
  const count = sent.length;
  await host.end(async () => { throw new Error("offline"); });
  assert.equal(sent.length, count);
});

test("a sign-out ends the session with the token it still has, and an unreachable server holds it for a moment only", async () => {
  const stream = session();
  const { host, sent } = harness({ reply: (body) => {
    if (body.action === "start") return stream.response;
    throw new Error("the account is signing out");
  } });
  host.arm(); host.microphoneOpened();
  await host.request(start());
  stream.push("data: {\"type\":\"ready\",\"reservationId\":\"voice-r8\"}\n\n");
  await settle();
  const direct: unknown[] = [];
  await host.end(async (body, signal) => { direct.push(body); assert.equal(signal.aborted, false); throw new Error("offline"); });
  assert.deepEqual(direct, [{ action: "stop", reservationId: "voice-r8" }]);
  assert.equal(sent.filter(({ action }) => action === "stop").length, 0, "the ordinary sender, which refuses during a sign-out, was not used");
});
