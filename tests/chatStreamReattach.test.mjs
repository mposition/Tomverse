import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  CHAT_DURABLE_STREAM_RESPONSE_MODE,
  decideChatStreamReattach,
  handOffInterruptedChatAttempt,
  isDurableChatStreamResponse,
  isInterruptedChatAttempt,
  pendingInterruptedChatAttempts,
  recoveredPartialText,
  resetInterruptedChatAttempts,
  settleInterruptedChatAttempt,
  shouldApplyPolledPartial,
  watchInterruptedChatAttempts,
} from "../lib/chatStreamReattach.ts";

/*
  When a broken Chat stream is read from its durable attempt instead of
  ending as an error. The panel itself cannot be mounted in this lane, so the
  decision lives in a pure module and the wiring is pinned against the
  component's source below.
*/

const durable = {
  responseMode: CHAT_DURABLE_STREAM_RESPONSE_MODE,
  transcriptScope: "conversation",
  isGuest: false,
  isReviewProjection: false,
  conversationId: "conversation-1",
};

test("only an account Chat stream with an attempt row is durable", () => {
  assert.equal(isDurableChatStreamResponse(durable), true);
  // The server sets the header only when it claimed an attempt.
  assert.equal(isDurableChatStreamResponse({ ...durable, responseMode: null }), false);
  assert.equal(isDurableChatStreamResponse({ ...durable, responseMode: "durable-attempt" }), false);
  // Review panels and guests are out of scope and keep their behaviour.
  assert.equal(isDurableChatStreamResponse({ ...durable, transcriptScope: "model" }), false);
  assert.equal(isDurableChatStreamResponse({ ...durable, isGuest: true }), false);
  assert.equal(isDurableChatStreamResponse({ ...durable, isReviewProjection: true }), false);
  assert.equal(isDurableChatStreamResponse({ ...durable, conversationId: "" }), false);
});

const broken = {
  durableStream: true,
  aborted: false,
  abortCause: null,
  streamReadFailed: false,
  serverReportedFailure: false,
};

test("a client timeout on a durable stream is reattached with its own code", () => {
  assert.deepEqual(
    decideChatStreamReattach({ ...broken, aborted: true, abortCause: "stream_idle_timeout", streamReadFailed: true }),
    { kind: "timeout", errorCode: "CHAT_STREAM_IDLE_TIMEOUT" }
  );
  assert.deepEqual(
    decideChatStreamReattach({ ...broken, aborted: true, abortCause: "first_response_timeout" }),
    { kind: "timeout", errorCode: "CHAT_FIRST_RESPONSE_TIMEOUT" }
  );
});

test("a dropped connection on a durable stream is reattached", () => {
  assert.deepEqual(
    decideChatStreamReattach({ ...broken, streamReadFailed: true }),
    { kind: "transport" }
  );
});

test("a stop is never reattached, whichever stop it was", () => {
  for (const abortCause of ["user_stop", "user_stop_all", "identity_released", null]) {
    assert.equal(
      decideChatStreamReattach({ ...broken, aborted: true, abortCause, streamReadFailed: true }),
      null,
      String(abortCause)
    );
  }
});

test("a failure the server reported in the trailer keeps its signed report", () => {
  assert.equal(
    decideChatStreamReattach({ ...broken, streamReadFailed: true, serverReportedFailure: true }),
    null
  );
});

test("nothing is reattached on a stream that is not durable, or that did not break", () => {
  assert.equal(
    decideChatStreamReattach({ ...broken, durableStream: false, streamReadFailed: true }),
    null
  );
  assert.equal(
    decideChatStreamReattach({ ...broken, durableStream: false, aborted: true, abortCause: "stream_idle_timeout" }),
    null
  );
  // An error thrown after the stream ended normally is not a broken stream.
  assert.equal(decideChatStreamReattach(broken), null);
});

test("an ended turn keeps the longer partial and never less than was shown", () => {
  assert.equal(recoveredPartialText("Shown so far", "Shown so far, and more"), "Shown so far, and more");
  // The last second of text was shown but not yet checkpointed.
  assert.equal(recoveredPartialText("Shown so far", "Shown so"), "Shown so far");
  assert.equal(recoveredPartialText("Shown", null), "Shown");
  assert.equal(recoveredPartialText("", ""), "");
});

test("an active poll never rolls the answer backwards", () => {
  assert.equal(shouldApplyPolledPartial("Shown so far", "Shown so"), false);
  assert.equal(shouldApplyPolledPartial("Shown so far", "Shown so far"), true);
  assert.equal(shouldApplyPolledPartial("Shown", "Shown, and more"), true);
});

/* ----------------------------------------------------- the hand-off ----- */

const KEY = "account:user-1|conversation-1|gpt-6-luna|conversation";
const record = (id, finished) => ({
  assistantMessageId: id,
  conversationId: "conversation-1",
  sourceUserMessageId: "source-1",
  analyticsPromptId: null,
  finish: (checkpointed) => finished.push([id, checkpointed]),
});
const tick = () => new Promise((settle) => setTimeout(settle, 0));

test("a hand-off with no panel polling the key is refused, so the turn ends as before", () => {
  resetInterruptedChatAttempts();
  const finished = [];
  assert.equal(handOffInterruptedChatAttempt(KEY, record("a", finished)), false);
  assert.deepEqual(pendingInterruptedChatAttempts(KEY), []);
  assert.deepEqual(finished, []);
});

test("a watching panel is told, and settling removes the record exactly once", () => {
  resetInterruptedChatAttempts();
  const finished = [];
  let told = 0;
  const unwatch = watchInterruptedChatAttempts(KEY, () => { told += 1; });
  assert.equal(handOffInterruptedChatAttempt(KEY, record("a", finished)), true);
  assert.equal(told, 1);
  assert.equal(isInterruptedChatAttempt(KEY, "a"), true);
  assert.equal(isInterruptedChatAttempt("another|key", "a"), false);
  settleInterruptedChatAttempt(KEY, "a").finish("server partial");
  assert.equal(settleInterruptedChatAttempt(KEY, "a"), null);
  assert.deepEqual(finished, [["a", "server partial"]]);
  unwatch();
});

test("a panel that remounts on the same key keeps the hand-off", async () => {
  // The first message of a new conversation: the panel that started the
  // stream is replaced by one mounted on the same key in the same commit.
  resetInterruptedChatAttempts();
  const finished = [];
  const first = watchInterruptedChatAttempts(KEY, () => {});
  handOffInterruptedChatAttempt(KEY, record("a", finished));
  first();
  const second = watchInterruptedChatAttempts(KEY, () => {});
  await tick();
  assert.deepEqual(finished, []);
  assert.equal(pendingInterruptedChatAttempts(KEY).length, 1);
  second();
});

test("when the last panel leaves, whatever was pending ends as it did before", async () => {
  resetInterruptedChatAttempts();
  const finished = [];
  const unwatch = watchInterruptedChatAttempts(KEY, () => {});
  handOffInterruptedChatAttempt(KEY, record("a", finished));
  handOffInterruptedChatAttempt(KEY, record("b", finished));
  unwatch();
  await tick();
  assert.deepEqual(finished, [["a", null], ["b", null]]);
  assert.deepEqual(pendingInterruptedChatAttempts(KEY), []);
});

/* ------------------------------------------------ the panel's wiring ----- */

const source = readFileSync(new URL("../components/chat/ChatApp.tsx", import.meta.url), "utf8");

test("the panel decides before any other catch branch, and only with a watcher", () => {
  const catchStart = source.indexOf("} catch (error: unknown) {\n      // A durable stream that broke");
  assert.ok(catchStart > 0, "the reattach decision must open the send's catch block");
  const decision = source.slice(catchStart, source.indexOf("const requestError =", catchStart));
  assert.match(decision, /decideChatStreamReattach\(/);
  assert.match(decision, /handOffInterruptedStream\(interruption, targetChatId\)\s*\)\s*\{\s*return;/);
  const handOff = source.slice(source.indexOf("const handOffInterruptedStream"), catchStart);
  assert.match(handOff, /handOffInterruptedChatAttempt\(runKey,/);
  assert.match(handOff, /if \(!handedOff\) return false;/);
});

test("a reattached attempt that ends without an answer takes the old error path", () => {
  const poll = source.slice(source.indexOf("const pollOne = async"), source.indexOf("const loop = async"));
  assert.match(poll, /settleInterruptedChatAttempt\(key, assistantMessageId\)\?\.finish\(\s*attempt\.partialContent\s*\)/);
  assert.match(poll, /shouldApplyPolledPartial\(shown, attempt\.partialContent\)/);
  const terminal = source.slice(source.indexOf("const makeTerminalRecovery"), source.indexOf("const retryAfterMs"));
  assert.match(terminal, /interrupted\.finish\(null\)/);
  // Only an account Chat panel watches for hand-offs.
  const watch = source.slice(source.indexOf("Streams that broke on this key"), source.indexOf("const isMobileShell"));
  assert.match(watch, /if \(isGuestMode \|\| transcriptScope !== "conversation"\) return;/);
  assert.match(watch, /watchInterruptedChatAttempts\(runtimeKey, adopt\)/);
});

test("the page coming back re-checks a durable stream's liveness", () => {
  assert.match(source, /document\.addEventListener\("visibilitychange", recheckLiveness\)/);
  assert.match(source, /window\.addEventListener\("online", recheckLiveness\)/);
  assert.match(source, /detachPageLivenessListeners\(\);/);
});
