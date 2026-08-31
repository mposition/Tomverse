import assert from "node:assert/strict";
import test from "node:test";

import {
  initialVoiceRecorderState,
  isVoiceRecorderBusy,
  voiceRecorderReducer,
} from "../lib/voiceRecorderMachine.ts";
import {
  VOICE_CLIP_MAX_SECONDS,
  VOICE_CLIP_MIN_BYTES,
} from "../lib/voiceInputFormats.ts";

/**
 * The recording state machine: docs/policy/voice-input.md §8.
 *
 * These are the orderings that cannot be provoked reliably by driving a real
 * `MediaRecorder`, which is the whole reason the decisions were pulled out of
 * the hook into a reducer:
 *
 *   * a blob arriving after the user cancelled,
 *   * a permission answer arriving after the user gave up,
 *   * the two-minute limit and a manual stop landing together,
 *   * a transcript arriving for a session that has been replaced.
 *
 * And the one invariant this feature exists under: nothing in here sends a
 * message.
 */

const CLIP_BYTES = VOICE_CLIP_MIN_BYTES + 1;

/** Drives a sequence of events from `idle`, allocating sessions as the hook does. */
const run = (events) => {
  let state = initialVoiceRecorderState;
  let session = 0;
  const effects = [];
  for (const event of events) {
    const nextSessionId = event.type === "start_requested" ? session + 1 : session;
    const transition = voiceRecorderReducer(state, event, nextSessionId);
    if (event.type === "start_requested" && transition.state !== state) {
      session = nextSessionId;
    }
    state = transition.state;
    effects.push(...transition.effects);
  }
  return { state, effects, session };
};

const recordingAt = (session = 1) => [
  { type: "start_requested" },
  { type: "permission_granted", sessionId: session },
];

test("a full pass reaches a transcript and returns to idle", () => {
  const { state, effects } = run([
    ...recordingAt(),
    { type: "tick", sessionId: 1, elapsedMs: 3000 },
    { type: "stop_requested" },
    { type: "clip_ready", sessionId: 1, byteLength: CLIP_BYTES },
    { type: "transcription_succeeded", sessionId: 1 },
  ]);

  assert.equal(state.status, "idle");
  assert.deepEqual(
    effects.map((effect) => effect.type),
    [
      "request_microphone",
      "start_capture",
      "stop_capture",
      "release_microphone",
      "upload_clip",
    ]
  );
});

test("no reachable path produces an effect that could send a message", () => {
  // The invariant, asserted structurally rather than by inspecting one flow:
  // the effect vocabulary itself has nothing that submits. A future change
  // that adds one has to change this list on purpose.
  const everyEffect = new Set();
  const sequences = [
    [...recordingAt(), { type: "stop_requested" }, { type: "clip_ready", sessionId: 1, byteLength: CLIP_BYTES }, { type: "transcription_succeeded", sessionId: 1 }],
    [...recordingAt(), { type: "cancel_requested" }],
    [{ type: "start_requested" }, { type: "permission_denied", sessionId: 1 }],
    [{ type: "start_requested" }, { type: "unsupported" }],
    [...recordingAt(), { type: "tick", sessionId: 1, elapsedMs: VOICE_CLIP_MAX_SECONDS * 1000 }],
    [...recordingAt(), { type: "stop_requested" }, { type: "clip_ready", sessionId: 1, byteLength: 10 }],
  ];
  for (const sequence of sequences) {
    for (const effect of run(sequence).effects) everyEffect.add(effect.type);
  }

  assert.deepEqual(
    [...everyEffect].sort(),
    [
      "discard_capture",
      "release_microphone",
      "request_microphone",
      "start_capture",
      "stop_capture",
      "upload_clip",
    ],
    "the machine gained an effect; if it can submit, docs/policy/voice-input.md §1 is broken"
  );
});

test("cancelling discards the capture and releases the microphone", () => {
  const { state, effects } = run([...recordingAt(), { type: "cancel_requested" }]);

  assert.equal(state.status, "idle");
  assert.deepEqual(effects.slice(-2), [
    { type: "discard_capture", sessionId: 1 },
    { type: "release_microphone", sessionId: 1 },
  ]);
});

test("a clip that arrives after a cancel cannot resurrect the flow", () => {
  // The failure this prevents: the user throws a recording away, the recorder
  // delivers its bytes a moment later, and the discarded audio is transcribed
  // into the composer anyway.
  const { state } = run([
    ...recordingAt(),
    { type: "cancel_requested" },
    { type: "clip_ready", sessionId: 1, byteLength: CLIP_BYTES },
  ]);

  assert.equal(state.status, "idle");
});

test("a transcript for a replaced session is ignored", () => {
  const { state } = run([
    ...recordingAt(1),
    { type: "cancel_requested" },
    // A second recording, now session 2.
    ...recordingAt(2),
    // The first one's server answer finally lands.
    { type: "transcription_succeeded", sessionId: 1 },
  ]);

  assert.equal(state.status, "recording", "session 1's answer must not end session 2");
  assert.equal(state.sessionId, 2);
});

test("a permission answer that arrives after the user gave up is ignored", () => {
  const { state } = run([
    { type: "start_requested" },
    { type: "cancel_requested" },
    { type: "permission_granted", sessionId: 1 },
  ]);

  assert.equal(state.status, "idle", "a stale grant must not start a recording");
});

test("the length limit stops the recording and keeps what was said", () => {
  const { state, effects } = run([
    ...recordingAt(),
    { type: "tick", sessionId: 1, elapsedMs: VOICE_CLIP_MAX_SECONDS * 1000 },
  ]);

  assert.equal(state.status, "stopping");
  assert.equal(state.stoppedByLimit, true);
  assert.deepEqual(
    effects.at(-1),
    { type: "stop_capture", sessionId: 1 },
    "the limit stops the capture; it must not discard it"
  );
});

test("a tick below the limit only advances the elapsed time", () => {
  const { state } = run([
    ...recordingAt(),
    { type: "tick", sessionId: 1, elapsedMs: (VOICE_CLIP_MAX_SECONDS - 1) * 1000 },
  ]);

  assert.equal(state.status, "recording");
  assert.equal(state.elapsedMs, (VOICE_CLIP_MAX_SECONDS - 1) * 1000);
});

test("elapsed time never runs backwards on an out-of-order tick", () => {
  const { state } = run([
    ...recordingAt(),
    { type: "tick", sessionId: 1, elapsedMs: 5000 },
    { type: "tick", sessionId: 1, elapsedMs: 4000 },
  ]);

  assert.equal(state.elapsedMs, 5000);
});

test("a clip with nothing but headers is refused before it is uploaded", () => {
  const { state, effects } = run([
    ...recordingAt(),
    { type: "stop_requested" },
    { type: "clip_ready", sessionId: 1, byteLength: VOICE_CLIP_MIN_BYTES - 1 },
  ]);

  assert.equal(state.status, "error");
  assert.equal(state.code, "VOICE_CLIP_EMPTY");
  assert.ok(
    !effects.some((effect) => effect.type === "upload_clip"),
    "an empty clip must not reach the network"
  );
});

test("a denied microphone and an unavailable device are different errors", () => {
  const denied = run([
    { type: "start_requested" },
    { type: "permission_denied", sessionId: 1 },
  ]);
  const unavailable = run([
    { type: "start_requested" },
    { type: "device_unavailable", sessionId: 1 },
  ]);

  assert.equal(denied.state.code, "VOICE_PERMISSION_DENIED");
  assert.equal(unavailable.state.code, "VOICE_DEVICE_UNAVAILABLE");
});

test("an unsupported browser is reported from idle without opening anything", () => {
  const { state, effects } = run([{ type: "unsupported" }]);

  assert.equal(state.status, "error");
  assert.equal(state.code, "VOICE_UNSUPPORTED_BROWSER");
  assert.ok(!effects.some((effect) => effect.type === "request_microphone"));
});

test("a server refusal keeps its own code beside the generic one", () => {
  const { state } = run([
    ...recordingAt(),
    { type: "stop_requested" },
    { type: "clip_ready", sessionId: 1, byteLength: CLIP_BYTES },
    {
      type: "transcription_failed",
      sessionId: 1,
      code: "VOICE_TRANSCRIPTION_FAILED",
      serverCode: "VOICE_OPERATIONAL_LIMIT_REACHED",
    },
  ]);

  assert.equal(state.status, "error");
  assert.equal(state.serverCode, "VOICE_OPERATIONAL_LIMIT_REACHED");
});

test("an error stays until it is dismissed, and pressing record does nothing else", () => {
  let state = run([
    { type: "start_requested" },
    { type: "permission_denied", sessionId: 1 },
  ]).state;

  // A press from `error` is a fresh attempt: the machine is at rest, so this
  // is allowed and starts a new session rather than being swallowed.
  const retry = voiceRecorderReducer(state, { type: "start_requested" }, 2);
  assert.equal(retry.state.status, "permission_pending");

  const dismissed = voiceRecorderReducer(state, { type: "dismiss_error" }, 2);
  assert.equal(dismissed.state.status, "idle");
  assert.deepEqual(dismissed.effects, []);
});

test("a second press while recording is ignored rather than restarting", () => {
  const { state } = run([...recordingAt(), { type: "start_requested" }]);

  assert.equal(state.status, "recording");
  assert.equal(
    state.sessionId,
    1,
    "restarting would silently throw away what has been said so far"
  );
});

test("cancel reaches the transcribing state", () => {
  const { state, effects } = run([
    ...recordingAt(),
    { type: "stop_requested" },
    { type: "clip_ready", sessionId: 1, byteLength: CLIP_BYTES },
    { type: "cancel_requested" },
  ]);

  assert.equal(state.status, "idle");
  assert.ok(effects.some((effect) => effect.type === "discard_capture"));
});

test("isVoiceRecorderBusy covers every non-resting state", () => {
  assert.equal(isVoiceRecorderBusy({ status: "idle" }), false);
  assert.equal(
    isVoiceRecorderBusy({ status: "error", code: "VOICE_CLIP_EMPTY", serverCode: null }),
    false
  );
  for (const state of [
    { status: "permission_pending", sessionId: 1 },
    { status: "recording", sessionId: 1, elapsedMs: 0, stoppedByLimit: false },
    { status: "stopping", sessionId: 1, elapsedMs: 0, stoppedByLimit: false },
    { status: "transcribing", sessionId: 1, elapsedMs: 0 },
  ]) {
    assert.equal(isVoiceRecorderBusy(state), true, state.status);
  }
});

// ---------------------------------------------------------------------------
// Stabilisation: failures that arrive *after* recording has begun
//
// The reducer accepted `unsupported` only from `idle`/`permission_pending` and
// `device_unavailable` only from `permission_pending`. Both are dispatched by
// the adapter from states those guards reject:
//
//   * `new MediaRecorder(...)` throwing dispatches `unsupported` while the
//     machine is already `recording` (permission_granted moved it there before
//     the capture was attempted);
//   * `recorder.onerror` dispatches `device_unavailable` from `recording` or
//     `stopping`.
//
// Both transitions were dropped, so the machine sat in `recording` with the
// microphone open and — in the onerror case — a tick timer still running. The
// only way out was Cancel, and nothing told the user why.
// ---------------------------------------------------------------------------

test("a recorder that cannot be constructed ends the recording it was for", () => {
  const { state, effects } = run([
    ...recordingAt(),
    { type: "unsupported", sessionId: 1 },
  ]);

  assert.equal(state.status, "error");
  assert.equal(state.code, "VOICE_UNSUPPORTED_BROWSER");
  assert.ok(
    effects.some((effect) => effect.type === "release_microphone"),
    "a failure while recording must close the microphone it opened"
  );
  assert.ok(
    effects.some((effect) => effect.type === "discard_capture"),
    "the partial capture is not a clip the user asked to send"
  );
});

test("a recorder error during recording ends the recording", () => {
  const { state, effects } = run([
    ...recordingAt(),
    { type: "device_unavailable", sessionId: 1 },
  ]);

  assert.equal(state.status, "error");
  assert.equal(state.code, "VOICE_DEVICE_UNAVAILABLE");
  assert.ok(effects.some((effect) => effect.type === "release_microphone"));
});

test("a recorder error while stopping ends the recording", () => {
  // Without this the machine waits forever for an `onstop` that a failed
  // recorder will never fire.
  const { state, effects } = run([
    ...recordingAt(),
    { type: "stop_requested" },
    { type: "device_unavailable", sessionId: 1 },
  ]);

  assert.equal(state.status, "error");
  assert.equal(state.code, "VOICE_DEVICE_UNAVAILABLE");
  assert.ok(effects.some((effect) => effect.type === "release_microphone"));
});

test("a stale failure from a finished session cannot end the current one", () => {
  // `unsupported` carried no session id, so a late one from session 1 was
  // accepted while session 2 sat in `permission_pending` — ending session 2 and
  // releasing the microphone it was about to be granted.
  const { state, effects } = run([
    ...recordingAt(1),
    { type: "cancel_requested" },
    { type: "start_requested" },
    { type: "unsupported", sessionId: 1 },
  ]);

  assert.equal(state.status, "permission_pending");
  assert.equal(state.sessionId, 2);
  assert.equal(
    effects.filter((effect) => effect.type === "release_microphone").length,
    1,
    "only the cancelled session may release a microphone"
  );
});

test("a stale device error from a finished session is dropped", () => {
  const { state } = run([
    ...recordingAt(1),
    { type: "cancel_requested" },
    ...recordingAt(2),
    { type: "device_unavailable", sessionId: 1 },
  ]);

  assert.equal(state.status, "recording");
  assert.equal(state.sessionId, 2);
});

test("a conversation switch ends the recording and says so", () => {
  // Problem B's machine half: the session belongs to the conversation it was
  // started in, so leaving that conversation ends it rather than letting the
  // transcript follow the user.
  const { state, effects } = run([
    ...recordingAt(),
    { type: "scope_changed", sessionId: 1 },
  ]);

  assert.equal(state.status, "error");
  assert.equal(state.code, "VOICE_SCOPE_CHANGED");
  assert.deepEqual(
    effects.slice(-2).map((effect) => effect.type),
    ["discard_capture", "release_microphone"],
    "a switch throws the capture away rather than uploading it"
  );
});

test("a switch ends a transcription that is already in flight", () => {
  const { state, effects } = run([
    ...recordingAt(),
    { type: "stop_requested" },
    { type: "clip_ready", sessionId: 1, byteLength: CLIP_BYTES },
    { type: "scope_changed", sessionId: 1 },
  ]);

  assert.equal(state.status, "error");
  assert.equal(state.code, "VOICE_SCOPE_CHANGED");
  assert.ok(effects.some((effect) => effect.type === "discard_capture"));
});

test("a switch reported for a session that already ended changes nothing", () => {
  const { state } = run([
    ...recordingAt(1),
    { type: "cancel_requested" },
    ...recordingAt(2),
    { type: "scope_changed", sessionId: 1 },
  ]);

  assert.equal(state.status, "recording");
  assert.equal(state.sessionId, 2);
});
