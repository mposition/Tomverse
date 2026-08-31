import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceCaptureAdapter } from "../lib/voiceCaptureAdapter.ts";

/**
 * The adapter that owns the microphone: docs/policy/voice-input.md §8.5.
 *
 * A reducer test proves the machine *names* the right effect. It cannot prove
 * that a track was stopped, that a timer was cleared, or that a cleanup step
 * which threw did not abandon the steps behind it — the reducer performs no
 * effects at all. These are those claims, executed.
 *
 * Every dependency is a fake that records what it was asked to do, and several
 * of them are fakes that *throw*, because "cleanup survives a browser that
 * throws on teardown" is only a claim until something throws.
 */

const makeTrack = (log, name, options = {}) => ({
  stopped: 0,
  stop() {
    this.stopped++;
    log.push(`track:${name}:stop`);
    if (options.throwOnStop) throw new Error("track stop failed");
  },
});

const makeStream = (log, tracks) => ({
  getTracks: () => tracks,
});

const makeRecorder = (log, options = {}) => {
  const recorder = {
    state: "inactive",
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start() {
      log.push("recorder:start");
      if (options.throwOnStart) {
        const error = new Error("start failed");
        error.name = options.startErrorName ?? "InvalidStateError";
        throw error;
      }
      recorder.state = "recording";
    },
    stop() {
      log.push("recorder:stop");
      if (options.throwOnStop) throw new Error("stop failed");
      recorder.state = "inactive";
      recorder.onstop?.();
    },
  };
  return recorder;
};

/** A world with sane defaults; each test overrides only what it is about. */
const makeWorld = (overrides = {}) => {
  const log = [];
  const dispatched = [];
  const transcripts = [];
  const elapsed = [];
  const tracks = overrides.tracks ?? [makeTrack(log, "a")];
  const stream = makeStream(log, tracks);
  const recorder = overrides.recorder ?? makeRecorder(log);
  let timers = 0;

  const deps = {
    getUserMedia:
      overrides.getUserMedia ??
      (async () => {
        log.push("getUserMedia");
        return stream;
      }),
    createRecorder:
      overrides.createRecorder ??
      (() => {
        log.push("createRecorder");
        return recorder;
      }),
    createClip:
      overrides.createClip ??
      ((parts) => ({ size: overrides.clipSize ?? 4096, parts })),
    fetchImpl:
      overrides.fetchImpl ??
      (async () =>
        new Response(JSON.stringify({ transcript: "hello" }), { status: 200 })),
    now: () => 1_000,
    setInterval: () => {
      timers++;
      log.push("setInterval");
      return { id: timers };
    },
    clearInterval: () => {
      timers--;
      log.push("clearInterval");
      if (overrides.throwOnClearInterval) throw new Error("clearInterval failed");
    },
  };

  const adapter = createVoiceCaptureAdapter({
    deps,
    mimeType: "audio/webm;codecs=opus",
    uploadMediaType: "audio/webm",
    endpoint: "/api/chat/voice-transcription",
    dispatch: (event) => dispatched.push(event),
    onTranscript: (transcript, sessionId) =>
      transcripts.push({ transcript, sessionId }),
    onElapsed: (ms) => elapsed.push(ms),
  });

  return {
    adapter,
    log,
    dispatched,
    transcripts,
    elapsed,
    tracks,
    recorder,
    liveTimers: () => timers,
  };
};

/** Drives a session up to the point where the recorder is running. */
const recordSession = async (world, sessionId = 1) => {
  await world.adapter.requestMicrophone(sessionId);
  world.adapter.startCapture(sessionId);
};

const typesOf = (dispatched) => dispatched.map((event) => event.type);

// ---------------------------------------------------------------------------
// The happy path, so the failures below mean something
// ---------------------------------------------------------------------------

test("a normal session opens, records, stops and yields a clip", async () => {
  const world = makeWorld();
  await recordSession(world);

  assert.deepEqual(typesOf(world.dispatched), ["permission_granted"]);
  assert.equal(world.adapter.inspect().hasStream, true);
  assert.equal(world.adapter.inspect().hasTimer, true);

  world.adapter.stopCapture(1);
  assert.deepEqual(typesOf(world.dispatched), ["permission_granted", "clip_ready"]);
  assert.equal(world.adapter.inspect().hasClip, true);
});

// ---------------------------------------------------------------------------
// Failure paths: every one of them must close what it opened
// ---------------------------------------------------------------------------

test("a recorder that cannot be constructed reports it and frees the microphone", async () => {
  const world = makeWorld({
    createRecorder: () => {
      throw new Error("unsupported mime");
    },
  });
  await world.adapter.requestMicrophone(1);
  world.adapter.startCapture(1);

  assert.deepEqual(typesOf(world.dispatched), ["permission_granted", "unsupported"]);
  // The machine answers that dispatch with discard + release; the adapter must
  // then have nothing left open.
  world.adapter.discardCapture(1);
  world.adapter.releaseMicrophone(1);
  assert.equal(world.tracks[0].stopped, 1, "the granted stream must be closed");
  assert.deepEqual(world.adapter.inspect(), {
    hasStream: false,
    hasRecorder: false,
    hasTimer: false,
    hasClip: false,
    activeSessionId: null,
    destroyed: false,
  });
});

test("recorder.start() throwing is reported and classified", async () => {
  const world = makeWorld({
    recorder: makeRecorder([], { throwOnStart: true, startErrorName: "InvalidStateError" }),
  });
  await recordSession(world);

  assert.deepEqual(typesOf(world.dispatched), ["permission_granted", "device_unavailable"]);
  assert.equal(
    world.adapter.inspect().hasTimer,
    false,
    "a recorder that never started must not leave a tick timer behind"
  );
});

test("a NotSupportedError from start() is an unsupported browser, not a broken device", async () => {
  const world = makeWorld({
    recorder: makeRecorder([], {
      throwOnStart: true,
      startErrorName: "NotSupportedError",
    }),
  });
  await recordSession(world);

  assert.deepEqual(typesOf(world.dispatched), ["permission_granted", "unsupported"]);
});

test("recorder.stop() throwing still ends the session instead of waiting forever", async () => {
  const world = makeWorld({ recorder: makeRecorder([], { throwOnStop: true }) });
  await recordSession(world);
  world.adapter.stopCapture(1);

  assert.deepEqual(
    typesOf(world.dispatched),
    ["permission_granted", "device_unavailable"],
    "no onstop is coming, so the machine has to be told"
  );
});

test("stopping a recorder that already died is reported, not ignored", async () => {
  const world = makeWorld();
  await recordSession(world);
  // A recorder that errored out is inactive without having fired `onstop`.
  world.recorder.state = "inactive";
  world.adapter.stopCapture(1);

  assert.deepEqual(typesOf(world.dispatched), ["permission_granted", "device_unavailable"]);
});

test("a recorder error mid-recording is reported once", async () => {
  const world = makeWorld();
  await recordSession(world);
  world.recorder.onerror?.();

  assert.deepEqual(typesOf(world.dispatched), ["permission_granted", "device_unavailable"]);
});

test("a device failure leaves a retryable adapter", async () => {
  const world = makeWorld();
  await recordSession(world);
  world.recorder.onerror?.();
  world.adapter.discardCapture(1);
  world.adapter.releaseMicrophone(1);

  assert.equal(world.tracks[0].stopped, 1);

  // The adapter is left ready for another attempt rather than wedged.
  assert.equal(world.adapter.inspect().activeSessionId, null);
  assert.equal(world.adapter.inspect().hasRecorder, false);
  await world.adapter.requestMicrophone(2);
  assert.equal(world.adapter.inspect().activeSessionId, 2);
  assert.equal(world.adapter.inspect().hasStream, true);
});

// ---------------------------------------------------------------------------
// Cleanup: idempotent, and never stopped by a throwing step
// ---------------------------------------------------------------------------

test("cleanup is idempotent", async () => {
  const world = makeWorld();
  await recordSession(world);

  world.adapter.releaseMicrophone(1);
  world.adapter.releaseMicrophone(1);
  world.adapter.releaseMicrophone(null);
  world.adapter.discardCapture(1);
  world.adapter.discardCapture(1);
  world.adapter.destroy();
  world.adapter.destroy();

  assert.equal(
    world.tracks[0].stopped,
    1,
    "a track is stopped once however many times cleanup runs"
  );
  assert.equal(world.liveTimers(), 0);
});

test("a track that throws on stop does not strand the tracks behind it", async () => {
  const log = [];
  const first = makeTrack(log, "first", { throwOnStop: true });
  const second = makeTrack(log, "second");
  const world = makeWorld({ tracks: [first, second] });
  await recordSession(world);

  world.adapter.releaseMicrophone(1);

  assert.equal(first.stopped, 1);
  assert.equal(
    second.stopped,
    1,
    "one track throwing must not leave the microphone open on another"
  );
});

test("a recorder that throws on teardown does not skip the tracks", async () => {
  const world = makeWorld({ recorder: makeRecorder([], { throwOnStop: true }) });
  await recordSession(world);

  world.adapter.releaseMicrophone(1);

  assert.equal(
    world.tracks[0].stopped,
    1,
    "the stream is released even when the recorder refuses to stop"
  );
  assert.equal(world.adapter.inspect().hasStream, false);
});

test("a clearInterval that throws does not skip the stream release", async () => {
  const world = makeWorld({ throwOnClearInterval: true });
  await recordSession(world);

  world.adapter.releaseMicrophone(1);

  assert.equal(world.tracks[0].stopped, 1);
  assert.equal(world.adapter.inspect().hasStream, false);
});

test("destroy() closes everything and silences later callbacks", async () => {
  const world = makeWorld();
  await recordSession(world);
  const before = world.dispatched.length;

  world.adapter.destroy();

  assert.equal(world.tracks[0].stopped, 1);
  assert.equal(world.liveTimers(), 0);
  assert.equal(world.adapter.inspect().destroyed, true);

  // A recorder callback that fires after unmount must reach nothing.
  world.recorder.onerror?.();
  assert.equal(world.dispatched.length, before, "a callback after destroy is dropped");
});

// ---------------------------------------------------------------------------
// Sessions: a late callback may never touch a newer session
// ---------------------------------------------------------------------------

test("a release naming an old session cannot close the new session's microphone", async () => {
  const log = [];
  const firstTracks = [makeTrack(log, "first")];
  const world = makeWorld({ tracks: firstTracks });
  await recordSession(world, 1);
  world.adapter.discardCapture(1);
  world.adapter.releaseMicrophone(1);
  assert.equal(firstTracks[0].stopped, 1);

  // Session 2 opens its own microphone on the same adapter.
  await world.adapter.requestMicrophone(2);
  assert.equal(world.adapter.inspect().activeSessionId, 2);
  assert.equal(world.adapter.inspect().hasStream, true);

  // A late release effect from session 1 arrives.
  world.adapter.releaseMicrophone(1);

  assert.equal(
    world.adapter.inspect().hasStream,
    true,
    "session 1's release must not close session 2's microphone"
  );
  assert.equal(world.adapter.inspect().activeSessionId, 2);
});

test("a capture start for an abandoned session does nothing", async () => {
  const world = makeWorld();
  await world.adapter.requestMicrophone(1);
  world.adapter.discardCapture(1);
  world.dispatched.length = 0;

  world.adapter.startCapture(1);

  assert.deepEqual(world.dispatched, []);
  assert.equal(world.adapter.inspect().hasRecorder, false);
});

test("a permission grant that resolves after a cancel releases its own stream", async () => {
  const log = [];
  const late = [makeTrack(log, "late")];
  let release;
  const world = makeWorld({
    tracks: late,
    getUserMedia: () =>
      new Promise((resolve) => {
        release = () => resolve(makeStream(log, late));
      }),
  });

  const pending = world.adapter.requestMicrophone(1);
  world.adapter.discardCapture(1);
  release();
  await pending;

  assert.equal(
    late[0].stopped,
    1,
    "a grant nobody is waiting for is closed rather than left open"
  );
  assert.equal(world.adapter.inspect().hasStream, false);
  assert.deepEqual(typesOf(world.dispatched), []);
});

test("an abandoned session's onstop assembles nothing", async () => {
  const world = makeWorld();
  await recordSession(world, 1);
  world.adapter.discardCapture(1);
  world.dispatched.length = 0;

  // The recorder delivers its final blob after the user gave up.
  world.recorder.onstop?.();

  assert.deepEqual(world.dispatched, []);
  assert.equal(world.adapter.inspect().hasClip, false);
});

// ---------------------------------------------------------------------------
// Upload: the transcript reaches the right session, or nobody
// ---------------------------------------------------------------------------

test("a transcript is handed back with the session it belongs to", async () => {
  const world = makeWorld();
  await recordSession(world, 3);
  world.adapter.stopCapture(3);
  await world.adapter.uploadClip(3);

  assert.deepEqual(world.transcripts, [{ transcript: "hello", sessionId: 3 }]);
  assert.ok(typesOf(world.dispatched).includes("transcription_succeeded"));
});

test("a transcript for a cancelled session reaches no draft at all", async () => {
  let respond;
  const world = makeWorld({
    fetchImpl: () =>
      new Promise((resolve) => {
        respond = () =>
          resolve(new Response(JSON.stringify({ transcript: "late" }), { status: 200 }));
      }),
  });
  await recordSession(world, 1);
  world.adapter.stopCapture(1);
  const pending = world.adapter.uploadClip(1);

  // The user gives up while the server is working.
  world.adapter.discardCapture(1);
  respond();
  await pending;

  assert.deepEqual(
    world.transcripts,
    [],
    "a cancelled recording's words must not reach any conversation"
  );
});

test("a server refusal carries its own code through", async () => {
  const world = makeWorld({
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: "VOICE_OPERATIONAL_LIMIT_REACHED" }), {
        status: 429,
      }),
  });
  await recordSession(world, 1);
  world.adapter.stopCapture(1);
  await world.adapter.uploadClip(1);

  const failure = world.dispatched.at(-1);
  assert.equal(failure.type, "transcription_failed");
  assert.equal(failure.serverCode, "VOICE_OPERATIONAL_LIMIT_REACHED");
});

test("a network failure is reported as one", async () => {
  const world = makeWorld({
    fetchImpl: async () => {
      throw new Error("connection reset");
    },
  });
  await recordSession(world, 1);
  world.adapter.stopCapture(1);
  await world.adapter.uploadClip(1);

  assert.equal(world.dispatched.at(-1).code, "VOICE_NETWORK_ERROR");
});

test("an aborted upload reports nothing", async () => {
  const world = makeWorld({
    fetchImpl: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  await recordSession(world, 1);
  world.adapter.stopCapture(1);
  world.dispatched.length = 0;
  await world.adapter.uploadClip(1);

  assert.deepEqual(
    world.dispatched,
    [],
    "the user already knows they cancelled; an abort is not an error to report"
  );
});
