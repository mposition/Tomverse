import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_CLIENT_FIRST_RESPONSE_GRACE_MS,
  CHAT_LIVENESS_BUDGETS,
  CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS,
  CHAT_STREAM_KEEPALIVE_INTERVAL_MS,
  classifyChatAbort,
  createChatAbortHandle,
  createChatLivenessWatchdog,
  isChatTimeoutErrorCode,
} from "../lib/chatStreamLiveness.ts";

/*
  The staged liveness policy that replaced one 90s timer.

  The reported failure: a `claude-fable-5` turn with a PowerPoint attached.
  The server read and extracted the deck, then the provider ran adaptive
  thinking at `effort: "high"`, and the single timer -- armed before `fetch`
  and reset only by the response headers -- expired while the model was still
  working. It aborted through the same `AbortController` the stop button uses,
  so the panel showed "Response generation was stopped."

  Every duration here is injected. Nothing in this file waits.
*/

/** A clock and a scheduler the test drives by hand. */
const fakeTimers = () => {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    timers: {
      setTimeout: (handler, ms) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { at: now + ms, handler });
        return id;
      },
      clearTimeout: (id) => {
        pending.delete(id);
      },
      now: () => now,
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of pending) {
          if (timer.at <= target && (due === null || timer.at < due[1].at)) {
            due = [id, timer];
          }
        }
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].handler();
      }
      now = target;
    },
    pendingCount: () => pending.size,
  };
};

const watch = (budgets) => {
  const clock = fakeTimers();
  const expiries = [];
  const watchdog = createChatLivenessWatchdog({
    budgets: budgets ?? { firstResponseMs: 600_000, idleMs: 90_000 },
    timers: clock.timers,
    onExpire: (expiry) => expiries.push(expiry),
  });
  return { ...clock, watchdog, expiries };
};

/* ------------------------------------------------------- the budgets ----- */

test("the client budget sits behind the server's own first-token deadline", () => {
  // The server ends a stall itself -- cancelling the provider reader,
  // settling, releasing the lease, discarding artifacts -- and announces the
  // outcome in the stream. If the client gave up first, that classified
  // answer would never arrive and the turn would be reported as a bare abort.
  assert.equal(
    CHAT_LIVENESS_BUDGETS.firstResponseMs,
    CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS + CHAT_CLIENT_FIRST_RESPONSE_GRACE_MS
  );
  assert.ok(
    CHAT_LIVENESS_BUDGETS.firstResponseMs > CHAT_SERVER_FIRST_TOKEN_DEADLINE_MS
  );
});

test("the first-response budget clears the ten-minute answer the server allows", () => {
  // app/api/chat/route.ts renews its concurrency lease on a heartbeat so that
  // "a legit ten-minute answer is as safe as a ten-second one". A client bound
  // under that would contradict the lifetime the lease exists to permit.
  assert.ok(CHAT_LIVENESS_BUDGETS.firstResponseMs >= 600_000);
});

test("the keepalive interval and the idle budget both clear the proxy read timeout", () => {
  // docs/policy/image-generation.md section 7: roughly 125 seconds. The
  // keepalive has to be well inside it, and a mid-stream stall has to be
  // ended by this app -- with its own copy and its own trace -- rather than
  // by an edge that can only produce a broken connection.
  assert.ok(CHAT_STREAM_KEEPALIVE_INTERVAL_MS < 125_000 / 4);
  assert.ok(CHAT_LIVENESS_BUDGETS.idleMs < 125_000);
});

/* ------------------------------------------------- the first response ---- */

test("a first token later than the old 90s but inside the budget is not touched", () => {
  const { watchdog, advance, expiries } = watch();

  advance(1_500);
  watchdog.noteHeaders();
  // Two minutes of adaptive thinking. The old timer aborted at 90s.
  advance(120_000);
  assert.deepEqual(expiries, []);
  assert.equal(watchdog.snapshot().phase, "first_response");

  watchdog.noteVisibleChunk();
  assert.equal(watchdog.snapshot().phase, "mid_stream");
  assert.deepEqual(expiries, []);
});

test("a request whose server-side work outlasts 90s before the headers survives", () => {
  // The attachment case. A deck is read and extracted before the provider is
  // called at all, so the whole extraction lands in `pre_headers` -- which
  // the old single timer counted against the same 90s.
  const { watchdog, advance, expiries } = watch();

  advance(150_000);
  assert.deepEqual(expiries, []);
  assert.equal(watchdog.snapshot().phase, "pre_headers");

  watchdog.noteHeaders();
  advance(200_000);
  watchdog.noteVisibleChunk();
  assert.deepEqual(expiries, []);
});

test("headers move the phase and do not extend the deadline", () => {
  const { watchdog, advance, expiries } = watch();

  advance(599_000);
  watchdog.noteHeaders();
  // If headers re-armed a full budget, nothing would fire for another ten
  // minutes and the two waits would silently compound.
  advance(1_001);
  assert.equal(expiries.length, 1);
  assert.equal(expiries[0].cause, "first_response_timeout");
  assert.equal(expiries[0].phase, "first_response");
});

test("a first-response timeout reports elapsed time and the phase, and fires once", () => {
  const { advance, expiries } = watch();

  advance(600_001);
  assert.equal(expiries.length, 1);
  assert.equal(expiries[0].cause, "first_response_timeout");
  assert.equal(expiries[0].phase, "pre_headers");
  assert.ok(expiries[0].elapsedMs >= 600_000);
  // Nothing visible has happened, so "idle" and "elapsed" are the same wait.
  assert.equal(expiries[0].idleMs, expiries[0].elapsedMs);

  advance(600_000);
  assert.equal(expiries.length, 1);
});

/* --------------------------------------------------- the keepalives ------ */

test("keepalives keep the transport legible without extending the deadline", () => {
  const { watchdog, advance, expiries } = watch();
  watchdog.noteHeaders();

  // Thirty keepalives at the server's interval: ten minutes of a provider
  // that never produced a token. A watchdog that let these reset the clock
  // would hide it forever, which is the one thing a keepalive must not buy.
  for (let index = 0; index < 30; index += 1) {
    advance(CHAT_STREAM_KEEPALIVE_INTERVAL_MS);
    watchdog.noteKeepalive();
  }

  assert.equal(expiries.length, 1);
  assert.equal(expiries[0].cause, "first_response_timeout");
  assert.equal(watchdog.snapshot().keepalives > 0, true);
});

/* ----------------------------------------------------- the idle watch ---- */

test("silence after the first token is an idle timeout, not a first-response one", () => {
  const { watchdog, advance, expiries } = watch();

  watchdog.noteHeaders();
  advance(5_000);
  watchdog.noteVisibleChunk();
  advance(90_001);

  assert.equal(expiries.length, 1);
  assert.equal(expiries[0].cause, "stream_idle_timeout");
  assert.equal(expiries[0].phase, "mid_stream");
  assert.ok(expiries[0].idleMs >= 90_000);
  // Elapsed is the whole request; idle is only since the last visible chunk.
  assert.ok(expiries[0].elapsedMs > expiries[0].idleMs);
});

test("every visible chunk re-arms the idle watchdog", () => {
  const { watchdog, advance, expiries } = watch();

  watchdog.noteHeaders();
  watchdog.noteVisibleChunk();
  for (let index = 0; index < 20; index += 1) {
    advance(80_000);
    watchdog.noteVisibleChunk();
  }
  // Twenty-six minutes of a healthy long answer, none of it idle for 90s.
  assert.deepEqual(expiries, []);
});

test("the first-response budget stops applying once the answer is flowing", () => {
  // Twenty minutes of steady output -- twice the first-response budget. Once
  // a visible token has arrived the only rule left is the inter-chunk one, so
  // a genuinely long answer cannot be ended by a budget about starting.
  const { watchdog, advance, expiries } = watch();

  watchdog.noteHeaders();
  advance(30_000);
  watchdog.noteVisibleChunk();
  for (let index = 0; index < 240; index += 1) {
    advance(5_000);
    watchdog.noteVisibleChunk();
  }

  assert.deepEqual(expiries, []);
  assert.ok(watchdog.snapshot().elapsedMs > 1_200_000);
});

/* ------------------------------------------------------------- stop ----- */

test("stop() cancels the pending timer and nothing can fire afterwards", () => {
  const { watchdog, advance, expiries, pendingCount } = watch();

  watchdog.noteHeaders();
  watchdog.stop();
  assert.equal(pendingCount(), 0);

  advance(3_600_000);
  assert.deepEqual(expiries, []);
  assert.equal(watchdog.snapshot().stopped, true);
});

test("a watchdog that already expired leaves no timer behind", () => {
  const { advance, expiries, pendingCount } = watch();

  advance(600_001);
  assert.equal(expiries.length, 1);
  assert.equal(pendingCount(), 0);
});

/* ------------------------------------------------- the abort handle ----- */

test("a stop is a stop and a timeout is a timeout", () => {
  assert.deepEqual(classifyChatAbort("user_stop"), { kind: "cancelled" });
  assert.deepEqual(classifyChatAbort("user_stop_all"), { kind: "cancelled" });
  assert.deepEqual(classifyChatAbort("component_unmounted"), {
    kind: "cancelled",
  });
  assert.deepEqual(classifyChatAbort("first_response_timeout"), {
    kind: "timeout",
    errorCode: "CHAT_FIRST_RESPONSE_TIMEOUT",
  });
  assert.deepEqual(classifyChatAbort("stream_idle_timeout"), {
    kind: "timeout",
    errorCode: "CHAT_STREAM_IDLE_TIMEOUT",
  });
});

test("an abort with no recorded cause classifies as a stop", () => {
  // A navigation, or a browser tearing the fetch down. Reporting it as a
  // timeout would put a diagnosable-looking code on something nothing here
  // diagnosed.
  assert.deepEqual(classifyChatAbort(null), { kind: "cancelled" });
  assert.deepEqual(classifyChatAbort(undefined), { kind: "cancelled" });
});

test("the handle records the first cause and keeps it", () => {
  const handle = createChatAbortHandle();
  assert.equal(handle.cause, null);
  assert.equal(handle.aborted, false);

  handle.abort("user_stop");
  assert.equal(handle.aborted, true);
  assert.equal(handle.cause, "user_stop");

  // The stop button and the watchdog can race. Whichever ended the request is
  // what happened; a later abort must not rewrite it into a timeout.
  handle.abort("stream_idle_timeout");
  assert.equal(handle.cause, "user_stop");
  assert.deepEqual(classifyChatAbort(handle.cause), { kind: "cancelled" });
});

test("a watchdog expiry and a stop cannot be mistaken for one another", () => {
  const stopped = createChatAbortHandle();
  const timedOut = createChatAbortHandle();
  stopped.abort("user_stop_all");
  timedOut.abort("first_response_timeout");

  // The bug this replaces: one shared `AbortController` and no cause, so both
  // of these arrived at the catch block as the same `AbortError`.
  assert.deepEqual(classifyChatAbort(stopped.cause), { kind: "cancelled" });
  assert.deepEqual(classifyChatAbort(timedOut.cause), {
    kind: "timeout",
    errorCode: "CHAT_FIRST_RESPONSE_TIMEOUT",
  });
});

test("two panels' handles never share a cause", () => {
  const panelA = createChatAbortHandle();
  const panelB = createChatAbortHandle();

  panelA.abort("stream_idle_timeout");
  assert.equal(panelB.cause, null);
  assert.equal(panelB.aborted, false);

  panelB.abort("user_stop");
  assert.equal(panelA.cause, "stream_idle_timeout");
  assert.equal(panelB.cause, "user_stop");
});

test("the timeout codes are recognised and nothing else is", () => {
  assert.equal(isChatTimeoutErrorCode("CHAT_FIRST_RESPONSE_TIMEOUT"), true);
  assert.equal(isChatTimeoutErrorCode("CHAT_STREAM_IDLE_TIMEOUT"), true);
  assert.equal(isChatTimeoutErrorCode("EMPTY_RESPONSE"), false);
  assert.equal(isChatTimeoutErrorCode("AI_PROVIDER_ERROR"), false);
});
