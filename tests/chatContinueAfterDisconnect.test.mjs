import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  CHAT_CONTINUE_AFTER_DISCONNECT_HEADER,
  DETACHED_CHAT_TURN_DEFAULTS,
  chatContinueAfterDisconnectEnabled,
  isStoppedChatAttempt,
  resolveDetachedChatTurnPlan,
} from "../lib/chatContinueAfterDisconnect.ts";
import { CHAT_LIVENESS_BUDGETS } from "../lib/chatStreamLiveness.ts";
import { requestChatAttemptStop } from "../lib/chatStreamReattach.ts";

/*
  The switch that lets a durable Chat turn outlive its connection, and the
  bounds a detached turn keeps. Off unless it is exactly "on".
*/

test("the switch is off unless it is exactly on", () => {
  assert.equal(chatContinueAfterDisconnectEnabled({}), false);
  for (const value of ["", "true", "1", "ON", "yes", "off"]) {
    assert.equal(chatContinueAfterDisconnectEnabled({ CHAT_CONTINUE_AFTER_DISCONNECT: value }), false, value);
  }
  assert.equal(chatContinueAfterDisconnectEnabled({ CHAT_CONTINUE_AFTER_DISCONNECT: "on" }), true);
});

test("a detached turn is given no longer than a connected one would have been", () => {
  assert.equal(DETACHED_CHAT_TURN_DEFAULTS.providerIdleMs, CHAT_LIVENESS_BUDGETS.idleMs);
  assert.deepEqual(resolveDetachedChatTurnPlan({}), DETACHED_CHAT_TURN_DEFAULTS);
});

test("operator overrides may only shorten the detached bounds", () => {
  const plan = resolveDetachedChatTurnPlan({
    CHAT_DETACHED_STOP_GRACE_MS: "50",
    CHAT_DETACHED_STOP_POLL_MS: "999999",
    CHAT_DETACHED_PROVIDER_IDLE_MS: "-1",
  });
  assert.equal(plan.stopGraceMs, 50);
  assert.equal(plan.stopPollMs, DETACHED_CHAT_TURN_DEFAULTS.stopPollMs);
  assert.equal(plan.providerIdleMs, DETACHED_CHAT_TURN_DEFAULTS.providerIdleMs);
});

test("only a cancelled row with the cancelled finish reason is a stop", () => {
  assert.equal(isStoppedChatAttempt({ status: "cancelled", finishReason: "cancelled" }), true);
  assert.equal(isStoppedChatAttempt({ status: "streaming", finishReason: null }), false);
  assert.equal(isStoppedChatAttempt({ status: "failed", finishReason: "error" }), false);
  assert.equal(isStoppedChatAttempt({ status: "completed", finishReason: "stop" }), false);
  assert.equal(isStoppedChatAttempt(null), false);
});

test("the browser's stop names the attempt, says nothing else, and survives the tab closing", async () => {
  const calls = [];
  const ok = await requestChatAttemptStop("assistant/1", async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ stopped: true }), { status: 200 });
  });
  assert.equal(ok, true);
  assert.equal(calls[0].url, "/api/products/chat/attempts/assistant%2F1");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify({ action: "stop" }));
  assert.equal(calls[0].init.keepalive, true);
});

test("a stop that cannot be delivered is reported, never thrown", async () => {
  assert.equal(await requestChatAttemptStop("a", async () => { throw new TypeError("offline"); }), false);
  assert.equal(await requestChatAttemptStop("a", async () => new Response(null, { status: 429 })), false);
});

/* ------------------------------------------------------------- wiring ---- */

const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../components/chat/ChatApp.tsx", import.meta.url), "utf8");

test("with the switch off the route's signals are the request's own", () => {
  assert.match(
    route,
    /const clientSignal: AbortSignal = continueAfterDisconnect\s*\?\s*turnAbortController\.signal\s*:\s*req\.signal;/
  );
  // The decision is made once per turn and requires an attempt row.
  assert.match(route, /const continueAfterDisconnect =\s*Boolean\(durableAttempt\) &&\s*!isResearchPreview &&\s*!mcpConnector &&\s*!projectTools &&\s*chatContinueAfterDisconnectEnabled\(\);/);
  // Every disconnect path asks first, and falls back to cancelling.
  assert.match(route, /if \(detachFromClient\(req\.signal\.reason \?\? "request aborted"\)\) return;\s*const cancellation = cancelTurnSafely\(/);
  assert.match(route, /async cancel\(reason\) \{\s*if \(detachFromClient\(reason\)\) return;\s*await cancelTurnSafely\(reason\);/);
  const detach = route.slice(route.indexOf("const detachFromClient = (reason: unknown) => {"), route.indexOf("const onRequestAbort = () => {"));
  assert.match(detach, /!continueAfterDisconnect \|\|/);
});

test("the header that asks the browser to say a stop out loud is sent only when detaching is possible", () => {
  assert.match(route, /\.\.\.\(continueAfterDisconnect && durableAttempt\s*\? \{ \[CHAT_CONTINUE_AFTER_DISCONNECT_HEADER\]: "on" \}/);
  assert.equal(CHAT_CONTINUE_AFTER_DISCONNECT_HEADER, "X-Chat-Continue-After-Disconnect");
});

test("the panel sends the stop only for a stop, and also while it reads attempts", () => {
  const stopOnServer = panel.slice(panel.indexOf("const stopOnServer = () => {"), panel.indexOf("controller.signal.addEventListener(\"abort\", stopOnServer"));
  assert.match(stopOnServer, /cause === "user_stop" \|\| cause === "user_stop_all"/);
  assert.match(panel, /response\.headers\.get\(CHAT_CONTINUE_AFTER_DISCONNECT_HEADER\) === "on"/);
  assert.match(panel, /const stopThisPanel = useCallback\(\(\) => \{\s*abortChatRuntime\(runtimeKeyRef\.current, "user_stop"\);\s*stopPolledAttempts\(\);/);
});
