import assert from "node:assert/strict";
import test from "node:test";

import { consumeChatStream } from "../lib/chatStreamConsumer.ts";
import {
  buildStreamKeepaliveChunk,
  STREAM_KEEPALIVE_MARKER,
} from "../lib/chatStreamKeepalive.ts";
import {
  classifyChatAbort,
  createChatLivenessWatchdog,
} from "../lib/chatStreamLiveness.ts";
import {
  abortChatRuntimeRun,
  beginChatRuntimeRun,
  getChatRuntimeAbortCause,
  resetChatStreamRuntime,
} from "../lib/chatStreamRuntime.ts";
import { buildRoutingRetryChunk } from "../lib/routingRetrySignal.ts";
import {
  buildChatStreamTrailerChunk,
  parseChatStreamTrailer,
} from "../lib/webSearchStreamTrailer.ts";

/*
  The read loop `components/chat/ChatApp.tsx` runs, driven against the real
  liveness watchdog on an injected clock.

  Between them these two modules are the whole of the reported failure: a
  `claude-fable-5` turn with a deck attached, aborted at 90s while the model
  was still thinking, and reported as "Response generation was stopped."
  Every case below is the panel's own sequence -- read, strip, render, decide
  -- with only the clock and the socket replaced.

  Nothing here waits. The longest wall-clock scenario is twenty minutes.
*/

/* ------------------------------------------------------------ harness ---- */

resetChatStreamRuntime();

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
      clearTimeout: (id) => pending.delete(id),
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

/**
 * The socket, as the panel sees it.
 *
 * `fail()` is how an abort actually reaches this loop: the panel does not
 * check a flag, it is holding `reader.read()` and the fetch rejects it with
 * an `AbortError`. Whether that abort was a stop or a deadline is exactly
 * what the exception cannot say -- which is why the handle carries the cause.
 */
const scriptedStream = () => {
  const encoder = new TextEncoder();
  const queue = [];
  let waiting = null;
  let failure = null;
  const settle = () => {
    if (!waiting) return;
    if (failure) {
      const pending = waiting;
      waiting = null;
      pending.reject(failure);
      return;
    }
    if (queue.length > 0) {
      const pending = waiting;
      waiting = null;
      pending.resolve(queue.shift());
    }
  };
  return {
    reader: {
      read: () =>
        new Promise((resolve, reject) => {
          waiting = { resolve, reject };
          settle();
        }),
      cancel: async () => undefined,
    },
    push(text) {
      queue.push({ done: false, value: encoder.encode(text) });
      settle();
    },
    close() {
      queue.push({ done: true, value: undefined });
      settle();
    },
    fail(error) {
      failure = error;
      settle();
    },
  };
};

const abortError = () =>
  Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
  });

/** Lets the loop's pending microtasks run after a push or an expiry. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * One panel: an abort handle, a watchdog wired to abort it, the read loop,
 * and the rendered text as `setAssistantMessage` would have received it.
 */
let nextRunIndex = 0;

const panel = () => {
  const clock = fakeTimers();
  const stream = scriptedStream();
  // A real runtime key and a real run, so the cause travels the way it does
  // in the app: beside the controller, in lib/chatStreamRuntime.ts.
  nextRunIndex += 1;
  const runtimeKey = `guest|conversation-${nextRunIndex}|gpt-5-6-luna`;
  const controller = beginChatRuntimeRun(runtimeKey);
  const handle = {
    get cause() {
      return getChatRuntimeAbortCause(runtimeKey, controller);
    },
    get aborted() {
      return controller.signal.aborted;
    },
    abort: (cause) => abortChatRuntimeRun(runtimeKey, controller, cause),
  };
  const rendered = [];
  const expiries = [];

  const liveness = createChatLivenessWatchdog({
    budgets: { firstResponseMs: 600_000, idleMs: 90_000 },
    timers: clock.timers,
    onExpire: (expiry) => {
      expiries.push(expiry);
      handle.abort(expiry.cause);
      // What the browser does to a fetch whose signal was aborted.
      stream.fail(abortError());
    },
  });

  /*
    The panel keeps the newest rendered text in a closure precisely so a
    request that ends badly can still show what had arrived. This mirrors
    `assistantText` in ChatApp.
  */
  let assistantText = "";
  const settled = consumeChatStream({
    reader: stream.reader,
    liveness,
    onProgress: (progress) => {
      assistantText = progress.displayText;
      rendered.push(progress.displayText);
    },
  });
  // The rejection is awaited by the caller in every test that causes one.
  settled.catch(() => {});

  return {
    ...clock,
    stream,
    handle,
    liveness,
    expiries,
    rendered,
    settled,
    partialText: () => assistantText,
  };
};

/* ------------------------------------------------- the reported failure --- */

test("a first token past 90 seconds arrives and the answer is rendered", async () => {
  const p = panel();
  p.liveness.noteHeaders();

  // Six keepalives: two minutes of adaptive thinking at high effort, which is
  // what the old single 90s timer aborted through the stop button's path.
  for (let index = 0; index < 6; index += 1) {
    p.advance(20_000);
    p.stream.push(
      buildStreamKeepaliveChunk({
        state: "awaiting_first_token",
        elapsedMs: (index + 1) * 20_000,
      })
    );
    await flush();
  }
  assert.deepEqual(p.expiries, []);

  p.stream.push("첨부하신 자료를 정리하면 다음과 같습니다.");
  await flush();
  p.stream.close();

  const result = await p.settled;
  assert.equal(result.displayText, "첨부하신 자료를 정리하면 다음과 같습니다.");
  assert.equal(result.serverStallCode, null);
  assert.deepEqual(p.expiries, []);
  assert.equal(p.handle.aborted, false);
});

test("a request whose server-side extraction runs long still succeeds", async () => {
  // The attachment case. Nothing arrives at all until the headers do, because
  // the deck is read and extracted before the provider is called -- so this
  // whole stretch used to count against the same 90 seconds.
  const p = panel();

  p.advance(150_000);
  p.liveness.noteHeaders();
  for (let index = 0; index < 5; index += 1) {
    p.advance(20_000);
    p.stream.push(
      buildStreamKeepaliveChunk({
        state: "awaiting_first_token",
        elapsedMs: 20_000 * (index + 1),
      })
    );
    await flush();
  }

  p.stream.push("The deck covers three things.");
  await flush();
  p.stream.close();

  const result = await p.settled;
  assert.equal(result.displayText, "The deck covers three things.");
  assert.deepEqual(p.expiries, []);
});

/* ------------------------------------------------------ the timeouts ----- */

test("the first-response deadline ends the turn as a timeout, not a cancellation", async () => {
  const p = panel();
  p.liveness.noteHeaders();

  p.advance(600_001);
  await assert.rejects(p.settled, { name: "AbortError" });

  assert.equal(p.expiries.length, 1);
  assert.equal(p.expiries[0].cause, "first_response_timeout");
  assert.deepEqual(classifyChatAbort(p.handle.cause), {
    kind: "timeout",
    errorCode: "CHAT_FIRST_RESPONSE_TIMEOUT",
  });
  // Nothing had streamed, so there is nothing to keep.
  assert.equal(p.partialText(), "");
});

test("an inter-chunk stall keeps the partial answer and ends as a timeout", async () => {
  const p = panel();
  p.liveness.noteHeaders();

  p.advance(4_000);
  p.stream.push("첫 번째 문단입니다.\n\n");
  await flush();
  p.stream.push("두 번째 문단입니다.");
  await flush();

  p.advance(90_001);
  await assert.rejects(p.settled, { name: "AbortError" });

  assert.equal(p.expiries.length, 1);
  assert.equal(p.expiries[0].cause, "stream_idle_timeout");
  assert.equal(p.expiries[0].phase, "mid_stream");
  assert.deepEqual(classifyChatAbort(p.handle.cause), {
    kind: "timeout",
    errorCode: "CHAT_STREAM_IDLE_TIMEOUT",
  });
  // The whole point of keeping it: two paragraphs beat one sentence about
  // having been stopped.
  assert.equal(p.partialText(), "첫 번째 문단입니다.\n\n두 번째 문단입니다.");
});

test("keepalives do not buy a stalled provider more time", async () => {
  const p = panel();
  p.liveness.noteHeaders();

  // Half an hour's worth of keepalives, if the deadline let them count.
  for (let index = 0; index < 90; index += 1) {
    if (p.handle.aborted) break;
    p.advance(20_000);
    p.stream.push(
      buildStreamKeepaliveChunk({
        state: "awaiting_first_token",
        elapsedMs: 20_000 * (index + 1),
      })
    );
    await flush();
  }

  await assert.rejects(p.settled, { name: "AbortError" });
  assert.equal(p.expiries[0].cause, "first_response_timeout");
  assert.ok(p.expiries[0].elapsedMs <= 620_000);
});

/* -------------------------------------------------------- a user stop ---- */

test("stopping this response keeps the cancelled state", async () => {
  const p = panel();
  p.liveness.noteHeaders();
  p.advance(3_000);
  p.stream.push("Partial answer");
  await flush();

  p.handle.abort("user_stop");
  p.stream.fail(abortError());

  await assert.rejects(p.settled, { name: "AbortError" });
  assert.deepEqual(classifyChatAbort(p.handle.cause), { kind: "cancelled" });
  assert.deepEqual(p.expiries, []);
  assert.equal(p.partialText(), "Partial answer");
});

test("stopping all responses keeps the cancelled state", async () => {
  const p = panel();
  p.liveness.noteHeaders();
  p.handle.abort("user_stop_all");
  p.stream.fail(abortError());

  await assert.rejects(p.settled, { name: "AbortError" });
  assert.deepEqual(classifyChatAbort(p.handle.cause), { kind: "cancelled" });
});

test("a stop that beats the watchdog is still reported as a stop", async () => {
  const p = panel();
  p.liveness.noteHeaders();
  p.advance(599_999);

  p.handle.abort("user_stop");
  p.stream.fail(abortError());
  await assert.rejects(p.settled, { name: "AbortError" });

  // The deadline lands a millisecond later. It must not rewrite what happened.
  p.advance(10_000);
  assert.deepEqual(classifyChatAbort(p.handle.cause), { kind: "cancelled" });
});

/* ------------------------------------------- the states that must not move */

test("a normal stream still yields its text and its trailer", async () => {
  const p = panel();
  p.liveness.noteHeaders();
  p.stream.push("Here is ");
  await flush();
  p.stream.push("the answer.");
  await flush();
  p.stream.push(
    buildChatStreamTrailerChunk({
      searchMetadata: null,
      completion: { status: "normal" },
    })
  );
  await flush();
  p.stream.close();

  const result = await p.settled;
  assert.equal(result.displayText, "Here is the answer.");
  assert.equal(parseChatStreamTrailer(result.searchMetadataJson).completion.status, "normal");
  assert.equal(result.serverStallCode, null);
  assert.deepEqual(p.expiries, []);
});

test("an empty response is still an empty response, not a timeout", async () => {
  const p = panel();
  p.liveness.noteHeaders();
  p.stream.close();

  const result = await p.settled;
  assert.equal(result.displayText, "");
  assert.equal(result.serverStallCode, null);
  assert.deepEqual(p.expiries, []);
});

test("a provider error still rejects the read, untouched by the watchdog", async () => {
  const p = panel();
  p.liveness.noteHeaders();
  p.stream.fail(new TypeError("network error"));

  await assert.rejects(p.settled, { name: "TypeError" });
  assert.deepEqual(p.expiries, []);
  assert.equal(p.handle.aborted, false);
});

test("a length finish still arrives as incomplete and not as a timeout", async () => {
  const p = panel();
  p.liveness.noteHeaders();
  p.stream.push("This answer ran out of room");
  await flush();
  p.stream.push(
    buildChatStreamTrailerChunk({
      searchMetadata: null,
      completion: { status: "incomplete", incompleteReason: "length" },
    })
  );
  await flush();
  p.stream.close();

  const result = await p.settled;
  const trailer = parseChatStreamTrailer(result.searchMetadataJson);
  assert.equal(trailer.completion.status, "incomplete");
  assert.equal(trailer.completion.incompleteReason, "length");
  // An output ceiling is the provider finishing. It is not this app closing a
  // connection, and the two must never share a state.
  assert.equal(result.serverStallCode, null);
  assert.deepEqual(p.expiries, []);
});

test("a fallback announcement still names the model that answered", async () => {
  const p = panel();
  p.liveness.noteHeaders();
  p.stream.push(buildRoutingRetryChunk("claude-opus-4-8"));
  await flush();
  p.stream.push("Answering instead.");
  await flush();
  p.stream.close();

  const result = await p.settled;
  assert.equal(result.retryingWithModelId, "claude-opus-4-8");
  assert.equal(result.displayText, "Answering instead.");
});

/* ---------------------------------------------- the server's own verdict -- */

test("the server's stall notice is reported and never rendered", async () => {
  const p = panel();
  p.liveness.noteHeaders();
  p.advance(120_000);
  p.stream.push(
    buildStreamKeepaliveChunk({ state: "awaiting_first_token", elapsedMs: 120_000 })
  );
  await flush();
  p.stream.push(
    buildStreamKeepaliveChunk({
      state: "stalled",
      elapsedMs: 540_000,
      code: "CHAT_FIRST_RESPONSE_TIMEOUT",
    })
  );
  await flush();
  p.stream.close();

  const result = await p.settled;
  assert.equal(result.serverStallCode, "CHAT_FIRST_RESPONSE_TIMEOUT");
  assert.equal(result.displayText, "");
  // The client's own deadline never had to fire: the server got there first,
  // which is what the one-minute grace between the two budgets is for.
  assert.deepEqual(p.expiries, []);
});

/* -------------------------------------------------------- no leakage ----- */

test("a keepalive torn across single-character reads never reaches the screen", async () => {
  const p = panel();
  p.liveness.noteHeaders();

  const wire =
    buildStreamKeepaliveChunk({ state: "awaiting_first_token", elapsedMs: 20_000 }) +
    "Answer." +
    buildChatStreamTrailerChunk({
      searchMetadata: null,
      completion: { status: "normal" },
    });

  for (const character of wire) {
    p.stream.push(character);
    await flush();
  }
  p.stream.close();

  const result = await p.settled;
  for (const frame of p.rendered) {
    assert.equal(
      frame.includes("TOMVERSE_STREAM_KEEPALIVE"),
      false,
      `the marker was rendered in a frame: ${JSON.stringify(frame)}`
    );
    assert.equal(
      frame.includes(String.fromCharCode(0)),
      false,
      `a NUL was rendered in a frame: ${JSON.stringify(frame)}`
    );
    assert.equal(frame.includes("elapsedMs"), false);
  }
  assert.equal(result.displayText, "Answer.");
  // The trailer is the metadata channel; a keepalive must not have leaked
  // into the JSON the panel is about to parse either.
  assert.equal(result.searchMetadataJson.includes("awaiting_first_token"), false);
  assert.equal(
    parseChatStreamTrailer(result.searchMetadataJson).completion.status,
    "normal"
  );
});

test("a stream that ends mid-marker shows the answer and drops the fragment", async () => {
  // The server was killed after writing the marker's first bytes. There is no
  // read coming that completes it, and a fragment is not answer text.
  const p = panel();
  p.liveness.noteHeaders();
  p.stream.push("All of the answer.");
  await flush();
  p.stream.push(STREAM_KEEPALIVE_MARKER.slice(0, 8));
  await flush();
  p.stream.close();

  const result = await p.settled;
  assert.equal(result.displayText, "All of the answer.");
  assert.equal(result.displayText.includes(String.fromCharCode(0)), false);
});

/* ------------------------------------------------------------- cleanup --- */

test("a settled turn leaves no timer armed, on every path", async () => {
  const completed = panel();
  completed.liveness.noteHeaders();
  completed.stream.push("done");
  await flush();
  completed.stream.close();
  await completed.settled;
  completed.liveness.stop();
  assert.equal(completed.pendingCount(), 0);

  const failed = panel();
  failed.liveness.noteHeaders();
  failed.stream.fail(new TypeError("network error"));
  await assert.rejects(failed.settled);
  failed.liveness.stop();
  assert.equal(failed.pendingCount(), 0);

  const stopped = panel();
  stopped.liveness.noteHeaders();
  stopped.handle.abort("user_stop");
  stopped.stream.fail(abortError());
  await assert.rejects(stopped.settled);
  stopped.liveness.stop();
  assert.equal(stopped.pendingCount(), 0);

  const timedOut = panel();
  timedOut.liveness.noteHeaders();
  timedOut.advance(600_001);
  await assert.rejects(timedOut.settled);
  // The watchdog disarms itself when it expires; `stop()` in the panel's
  // `finally` is then a no-op rather than the thing that saves it.
  assert.equal(timedOut.pendingCount(), 0);
});
