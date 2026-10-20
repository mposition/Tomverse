import assert from "node:assert/strict";
import { after, test } from "node:test";

import { AMUX_V19_APP_READBACK_BUDGET_MS, AMUX_V19_APP_RETRY_BUDGET_MS,
  AMUX_V19_STOP_RETRY_INTERVAL_MS, AMUX_V19_STOP_UNREACHABLE,
  AMUX_V19_STOP_UNREACHABLE_LIMIT_MS, amuxV19AppRequest,
  amuxV19RequestUnsent, confirmAmuxV19Continue, createAmuxV19StopContact,
  pollAmuxV19Stop } from "../lib/amux/ideaLocalAppRequest.mjs";
import { checkAmuxV19MaxSessionAnalysisStop,
  shouldStopAmuxV19MaxSessionAnalysis } from
  "../lib/amux/ideaLocalSessionAnalysisStopPoll.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "../lib/amux/ideaLocalSessionAnalysisQueuePoll.mjs";
import { AMUX_V19_MAX_SESSION_CYCLE_ENV, runAmuxV19MaxSessionCycleOnce } from
  "../lib/amux/ideaLocalMaxSessionCycle.mjs";
import { amuxV19MaxSessionCycleStatus } from
  "../scripts/amux-v19-max-session-cycle.mjs";
import { installAmuxV19FakeAppTiming } from "./support/amuxV19FakeAppTiming.mjs";

const clock = installAmuxV19FakeAppTiming();
const url = "https://amux.example.test/api/internal/amux/v19/example";

// Node fetch reports a connection that was never made as a TypeError whose
// cause carries the system code; a lost answer has no such cause.
const unsent = (code) => Object.assign(new TypeError("fetch failed"),
  { cause: Object.assign(new Error(`synthetic ${code}`), { code }) });
const sentLost = () => Object.assign(new TypeError("fetch failed"),
  { cause: Object.assign(new Error("other side closed"),
    { code: "UND_ERR_SOCKET" }) });
const timeout = () => new DOMException("synthetic timeout", "TimeoutError");

function request(purpose, fetchImpl, extra = {}) {
  return amuxV19AppRequest({ fetchImpl, url, method: purpose === "write"
    ? "POST" : "GET", purpose, timeoutMs: 8_000, maxBytes: 1_024,
  headers: {}, ...(purpose === "write" ? { body: "{\"same\":true}" } : {}),
  ...extra });
}

test("only a connection that was never made counts as unsent", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED",
    "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.equal(amuxV19RequestUnsent(unsent(code)), true, code);
  }
  // Every address of a dual-stack connect failed before connecting.
  assert.equal(amuxV19RequestUnsent(Object.assign(new TypeError("fetch failed"),
    { cause: Object.assign(new AggregateError([
      Object.assign(new Error("v6"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("v4"), { code: "ENETUNREACH" })]),
    { code: "ECONNREFUSED" }) })), true);
  // Anything that may have reached the app is not.
  for (const error of [sentLost(), timeout(), new Error("plain"),
    unsent("ECONNRESET"), unsent("ETIMEDOUT"), unsent("EPIPE"),
    Object.assign(new TypeError("fetch failed"), { cause: new AggregateError([
      Object.assign(new Error("v6"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("v4"), { code: "ECONNRESET" })]) }),
    { code: "ENOTFOUND" }, null, undefined]) {
    assert.equal(amuxV19RequestUnsent(error), false, String(error?.cause?.code));
  }
});

test("a write that never left is sent again with the same bytes", async () => {
  const bodies = [];
  const reply = await request("write", async (_url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) throw unsent("EAI_AGAIN");
    if (bodies.length === 2) throw unsent("ECONNREFUSED");
    return Response.json({ ok: true });
  });
  assert.equal(reply.kind, "response");
  assert.equal(reply.status, 200);
  assert.deepEqual(bodies, Array(3).fill("{\"same\":true}"));
});

test("a write whose answer may have been lost is never sent again", async () => {
  for (const failure of [sentLost, timeout, () => new Error("plain")]) {
    let writes = 0;
    const reply = await request("write", async () => {
      writes += 1;
      throw failure();
    });
    assert.deepEqual(reply, { kind: "failed",
      reason: "network_sent_unconfirmed" });
    assert.equal(writes, 1);
  }
  // A drop that turns into a lost answer mid-retry also stops resending.
  let writes = 0;
  assert.deepEqual(await request("write", async () => {
    writes += 1;
    throw writes === 1 ? unsent("ENOTFOUND") : timeout();
  }), { kind: "failed", reason: "network_sent_unconfirmed" });
  assert.equal(writes, 2);
});

test("a gateway answer to a write goes to the readback, not a resend", async () => {
  let writes = 0;
  const reply = await request("write", async () => {
    writes += 1;
    return new Response(null, { status: 503 });
  });
  assert.equal(reply.kind, "response");
  assert.equal(reply.status, 503);
  assert.equal(writes, 1);
});

test("an unsent write gives up within its budget and names why", async () => {
  const start = clock.now;
  let writes = 0;
  assert.deepEqual(await request("write", async () => {
    writes += 1;
    throw unsent("ENOTFOUND");
  }), { kind: "failed", reason: "network_unsent_retry_exhausted" });
  assert.ok(writes > 1);
  assert.ok(clock.now - start <= AMUX_V19_APP_RETRY_BUDGET_MS);
});

test("a read is asked again after any lost answer or gateway reply", async () => {
  for (const failure of [() => { throw sentLost(); }, () => { throw timeout(); },
    () => { throw unsent("EAI_AGAIN"); },
    () => new Response(null, { status: 502 }),
    () => new Response(null, { status: 503 }),
    () => new Response(null, { status: 504 })]) {
    let reads = 0;
    const reply = await request("read", async () => {
      reads += 1;
      return reads < 3 ? failure() : Response.json({ ok: true });
    });
    assert.equal(reply.status, 200);
    assert.equal(reads, 3);
  }
  // An app answer that is not a gateway failure is final.
  let reads = 0;
  const refused = await request("read", async () => {
    reads += 1;
    return Response.json({ error: "disabled" }, { status: 409 });
  });
  assert.equal(refused.status, 409);
  assert.equal(reads, 1);
});

test("a body lost mid-stream is a lost answer: read again, never rewritten",
  async () => {
    const broken = () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"ok\":"));
        controller.error(new Error("connection reset"));
      } }), { headers: { "content-type": "application/json" } });
    let reads = 0;
    const read = await request("read", async () => {
      reads += 1;
      return reads === 1 ? broken() : Response.json({ ok: true });
    });
    assert.equal(read.status, 200);
    assert.equal(reads, 2);
    let writes = 0;
    assert.deepEqual(await request("write", async () => {
      writes += 1;
      return broken();
    }), { kind: "failed", reason: "network_sent_unconfirmed" });
    assert.equal(writes, 1);
  });

test("read and readback budgets bound the retry schedule", async () => {
  const run = async (purpose) => {
    const start = clock.now;
    let calls = 0;
    const reply = await request(purpose, async () => {
      calls += 1;
      throw timeout();
    });
    return { reply, calls, waited: clock.now - start };
  };
  const read = await run("read");
  const readback = await run("readback");
  assert.deepEqual(read.reply, { kind: "failed", reason: "read_unreachable" });
  assert.deepEqual(readback.reply, { kind: "failed",
    reason: "readback_unreachable" });
  assert.ok(read.waited <= AMUX_V19_APP_RETRY_BUDGET_MS);
  assert.ok(readback.waited <= AMUX_V19_APP_READBACK_BUDGET_MS);
  assert.ok(readback.calls > read.calls);
  // The budget, not the six listed delays, ends a readback: it keeps the last
  // delay until the 60 s budget is nearly spent (review r-20261020-074454-231544).
  assert.ok(readback.calls > 7, `readback made ${readback.calls} calls`);
  assert.ok(readback.waited > AMUX_V19_APP_READBACK_BUDGET_MS - 8_000,
    `readback waited ${readback.waited} ms`);
  // A single stop poll never retries: the stop rule re-asks on its own clock.
  const poll = await run("poll");
  assert.equal(poll.calls, 1);
  assert.equal(poll.waited, 0);
});

test("a redirect is an invalid answer, not a network drop", async () => {
  const moved = Response.json({ ok: true });
  Object.defineProperty(moved, "url", { value: "https://other.example.test/" });
  let calls = 0;
  assert.deepEqual(await request("read", async () => { calls += 1; return moved; }),
    { kind: "failed", reason: "response_invalid" });
  assert.equal(calls, 1);
});

test("an explicit stop answer always stops at once, even inside a drop", () => {
  const contact = createAmuxV19StopContact();
  assert.equal(contact.observe("stop"), "stop_requested");
  const dropped = createAmuxV19StopContact();
  assert.equal(dropped.observe("unreachable"), null);
  clock.now += AMUX_V19_STOP_UNREACHABLE_LIMIT_MS / 2;
  assert.equal(dropped.observe("unreachable"), null);
  assert.equal(dropped.observe("stop"), "stop_requested");
});

test("short stop-read failures keep going; the contact limit stops", () => {
  const contact = createAmuxV19StopContact();
  assert.equal(contact.observe("unreachable"), null);
  clock.now += AMUX_V19_STOP_UNREACHABLE_LIMIT_MS - 1;
  assert.equal(contact.observe("unreachable"), null);
  // Any explicit answer restarts the contact clock.
  assert.equal(contact.observe("continue"), null);
  assert.equal(contact.observe("unreachable"), null);
  clock.now += AMUX_V19_STOP_UNREACHABLE_LIMIT_MS - 1;
  assert.equal(contact.observe("unreachable"), null);
  clock.now += 1;
  assert.equal(contact.observe("unreachable"), "stop_unreachable");
});

test("while the CLI runs a dropped poll keeps it running and a stop ends it",
  async () => {
    const contact = createAmuxV19StopContact();
    const answers = [AMUX_V19_STOP_UNREACHABLE, AMUX_V19_STOP_UNREACHABLE,
      false, AMUX_V19_STOP_UNREACHABLE, true];
    const seen = [];
    for (const answer of answers) {
      seen.push(await pollAmuxV19Stop(async () => answer, contact));
      clock.now += 5_000;
    }
    assert.deepEqual(seen, [null, null, null, null, "stop_requested"]);
    // A thrown read is a dropped poll, not a stop.
    assert.equal(await pollAmuxV19Stop(async () => {
      throw new Error("lost");
    }, createAmuxV19StopContact()), null);
  });

test("before a gated step only an explicit continue passes", async () => {
  let reads = 0;
  const start = clock.now;
  assert.equal(await confirmAmuxV19Continue(async () => {
    reads += 1;
    return reads < 4 ? AMUX_V19_STOP_UNREACHABLE : false;
  }, createAmuxV19StopContact()), null);
  assert.equal(reads, 4);
  assert.equal(clock.now - start, 3 * AMUX_V19_STOP_RETRY_INTERVAL_MS);
  reads = 0;
  assert.equal(await confirmAmuxV19Continue(async () => {
    reads += 1;
    return reads < 3 ? AMUX_V19_STOP_UNREACHABLE : true;
  }, createAmuxV19StopContact()), "stop_requested");
  assert.equal(reads, 3);
  const limitStart = clock.now;
  assert.equal(await confirmAmuxV19Continue(
    async () => AMUX_V19_STOP_UNREACHABLE, createAmuxV19StopContact()),
  "stop_unreachable");
  assert.ok(clock.now - limitStart >= AMUX_V19_STOP_UNREACHABLE_LIMIT_MS);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await confirmAmuxV19Continue(async () => false,
    createAmuxV19StopContact(), aborted.signal), "stop_aborted");
});

const claimId = "9942fb52-4b78-4af6-931a-9eec8f66d394";
const reservationId = "bf72ad14-585c-41bd-b25e-aab4c17a6d3c";
const ideaId = "53d6918e-b05d-4531-a1ab-704dd756cc40";
const origin = "https://amux.example.test/";
const names = [AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV,
  "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET", AMUX_V19_MAX_SESSION_CYCLE_ENV];
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
process.env[names[0]] = origin;
process.env[names[1]] = "syntheticMaxLauncherSecret_0123456789abcdefgh";
after(() => {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

test("the Max stop read separates the app's answers from a dropped link",
  async () => {
    const check = (fetchImpl) => checkAmuxV19MaxSessionAnalysisStop({ origin,
      claimId, reservationId, ideaId, fetchImpl });
    const exact = { claimId, reservationId };
    assert.equal(await check(async () => Response.json({ ...exact,
      stop: false })), false);
    // Every answer the app gives other than the exact continue is a stop.
    for (const answer of [Response.json({ ...exact, stop: true }),
      Response.json({ error: "Unauthorized" }, { status: 401 }),
      Response.json({ error: "not_found" }, { status: 404 }),
      Response.json({ error: "session_analysis_stop_poll_disabled" },
        { status: 409 }),
      Response.json({ ...exact, stop: false, extra: 1 }),
      new Response(null, { status: 302,
        headers: { location: "https://other.example.test/" } })]) {
      assert.equal(await check(async () => answer), true);
    }
    for (const lost of [async () => { throw timeout(); },
      async () => { throw unsent("EAI_AGAIN"); },
      async () => new Response(null, { status: 503 }),
      async () => new Response(null, { status: 502 })]) {
      assert.equal(await check(lost), AMUX_V19_STOP_UNREACHABLE);
    }
    // The boolean form still treats any uncertainty as a stop.
    assert.equal(await shouldStopAmuxV19MaxSessionAnalysis({ origin, claimId,
      reservationId, ideaId,
      fetchImpl: async () => { throw timeout(); } }), true);
  });

test("every stop prints its fixed reason on the cycle status line", async () => {
  process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV] = "enabled";
  const identity = { claimId, requestId: "44c72436-c011-4cfc-b52f-e3345c22fc80",
    reservationId, ideaId, invocationOrdinal: 0, provider: "anthropic",
    modelId: "claude-opus-5-5", reasoningEffort: "high" };
  const claim = { kind: "claimed", recovered: false, retryWrite: false,
    claimId, requestId: identity.requestId, reservationId };
  const claimed = async () => ({ kind: "claimed", identity, claim,
    retryWrite: false });
  const run = (steps) => runAmuxV19MaxSessionCycleOnce({ origin,
    stateDirectory: "/state" }, { claim: claimed,
    readIdea: async () => ({ kind: "unavailable" }),
    haltFile: () => ({ release: async () => {} }), ...steps });

  const unreachableQueue = await runAmuxV19MaxSessionCycleOnce({ origin }, {
    claim: async () => ({ kind: "unavailable", reason: "read_unreachable" }) });
  assert.equal(amuxV19MaxSessionCycleStatus(unreachableQueue).line,
    "AMUX_V19_MAX_SESSION_CYCLE_unavailable stage=claim reason=read_unreachable\n");

  const unsentClaim = await runAmuxV19MaxSessionCycleOnce({ origin }, {
    claim: async () => ({ kind: "outcome_unknown", retryWrite: false,
      reason: "network_unsent_retry_exhausted" }) });
  assert.equal(amuxV19MaxSessionCycleStatus(unsentClaim).line,
    "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=claim " +
    "reason=network_unsent_retry_exhausted\n");

  const idea = await run({ readIdea: async () => ({ kind: "unavailable",
    reason: "read_unreachable" }) });
  assert.equal(amuxV19MaxSessionCycleStatus(idea).line,
    "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=idea_read " +
    "reason=read_unreachable\n");

  // The staging failure of 2026-10-20, now with its reasons: the stop read
  // and the unknown report both lost the link.
  const analysis = await run({
    readIdea: async () => ({ kind: "ready", prompt: "unused" }),
    analyse: async () => ({ kind: "outcome_unknown", cliStarted: false,
      reason: "stop_unreachable" }),
    reportUnknown: async () => ({ kind: "outcome_unknown",
      receiptStatus: null, retryWrite: false,
      reason: "readback_unreachable" }) });
  assert.equal(amuxV19MaxSessionCycleStatus(analysis).line,
    "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=analysis " +
    "reason=stop_unreachable cliStarted=false beforeCli=false " +
    "unknownReport=unconfirmed reportReason=readback_unreachable\n");

  const result = await run({
    readIdea: async () => ({ kind: "ready", prompt: "unused" }),
    analyse: async () => ({ kind: "verified_success", cliStarted: true,
      preparedReferences: [] }),
    finalize: async () => ({ kind: "outcome_unknown", retryWrite: false,
      reason: "stop_requested" }) });
  assert.equal(amuxV19MaxSessionCycleStatus(result).line,
    "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=result " +
    "reason=stop_requested\n");

  // A step without its own reason still names where it stopped.
  const bare = await run({});
  assert.equal(bare.reason, "idea_read_unavailable");
  // A reason that is not a fixed word is never printed.
  assert.equal(amuxV19MaxSessionCycleStatus({ kind: "outcome_unknown",
    stage: "result", reason: "Bearer x-1" }).line,
  "AMUX_V19_MAX_SESSION_CYCLE_outcome_unknown stage=result\n");
});
