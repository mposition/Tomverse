/**
 * The recording state machine.
 *
 * Contract: docs/policy/voice-input.md §8.
 *
 * A pure reducer, with no `MediaRecorder`, no `fetch`, no timers and no React:
 * `components/chat/useVoiceRecorder.ts` is the adapter that owns those. The
 * split is what makes the awkward orderings testable at all — a late blob
 * arriving after a cancel, a permission answer arriving after the user gave
 * up, a limit reached in the same tick as a stop — none of which can be
 * provoked reliably by driving a real recorder.
 *
 * ## Sessions, and why the machine counts them
 *
 * `MediaRecorder` is asynchronous in a direction the UI is not: `stop()`
 * returns immediately and the final `dataavailable` arrives afterwards. So a
 * user who cancels a recording and immediately starts another one has two
 * in-flight callbacks from two different recorders, and the older one is still
 * entitled to deliver its bytes.
 *
 * Every state that can receive a late event carries a `sessionId`, and every
 * such event carries the one it belongs to. A mismatch is dropped. Without
 * that, a cancelled recording's audio lands in the composer of the recording
 * that replaced it — which is not merely a bug in the flow, it is the product
 * transcribing something the user explicitly threw away
 * (docs/policy/voice-input.md §8.2).
 *
 * ## What is deliberately not in here
 *
 * There is no `submit`. There is no state from which this machine causes a
 * message to be sent. A finished transcription hands text back to the composer
 * and returns to `idle`, and the user presses Send — the invariant in
 * docs/policy/voice-input.md §1, enforced by
 * `tests/voiceRecorderMachine.test.mjs` and by the end-to-end spec.
 */

import {
  VOICE_CLIP_MAX_SECONDS,
  VOICE_CLIP_MIN_BYTES,
} from "@/lib/voiceInputFormats";

/** Why a recording could not be started, or could not be used. */
export type VoiceRecorderErrorCode =
  /** `MediaRecorder`, `getUserMedia` or every candidate container is missing. */
  | "VOICE_UNSUPPORTED_BROWSER"
  /** The user, or a policy, refused microphone access. */
  | "VOICE_PERMISSION_DENIED"
  /** Permission was granted but no device produced a stream. */
  | "VOICE_DEVICE_UNAVAILABLE"
  /** The clip held no more than container headers. */
  | "VOICE_CLIP_EMPTY"
  /** The request never reached the server. */
  | "VOICE_NETWORK_ERROR"
  /** The server refused, or the provider did. Carries the server's own code. */
  | "VOICE_TRANSCRIPTION_FAILED";

export type VoiceRecorderState =
  | { status: "idle" }
  | { status: "permission_pending"; sessionId: number }
  | {
      status: "recording";
      sessionId: number;
      elapsedMs: number;
      /** Set once the limit stops the recorder, so the UI can say why. */
      stoppedByLimit: boolean;
    }
  | { status: "stopping"; sessionId: number; elapsedMs: number; stoppedByLimit: boolean }
  | { status: "transcribing"; sessionId: number; elapsedMs: number }
  | {
      status: "error";
      code: VoiceRecorderErrorCode;
      /** The server's refusal code, when the failure came from the server. */
      serverCode: string | null;
    };

export type VoiceRecorderEvent =
  | { type: "start_requested" }
  | { type: "unsupported" }
  | { type: "permission_granted"; sessionId: number }
  | { type: "permission_denied"; sessionId: number }
  | { type: "device_unavailable"; sessionId: number }
  | { type: "tick"; sessionId: number; elapsedMs: number }
  | { type: "stop_requested" }
  | { type: "cancel_requested" }
  | { type: "clip_ready"; sessionId: number; byteLength: number }
  | { type: "transcription_succeeded"; sessionId: number }
  | {
      type: "transcription_failed";
      sessionId: number;
      code: VoiceRecorderErrorCode;
      serverCode?: string | null;
    }
  | { type: "dismiss_error" };

/**
 * What the adapter must do as a result of the transition, as data.
 *
 * The reducer never performs an effect. It names one, the hook carries it out,
 * and a test can assert that cancelling asks for the tracks to be released
 * without owning a microphone.
 */
export type VoiceRecorderEffect =
  /** Ask for the microphone. Carries the session the answer must quote. */
  | { type: "request_microphone"; sessionId: number }
  /** Begin capturing for this session. */
  | { type: "start_capture"; sessionId: number }
  /** Ask the recorder to finish and deliver its bytes. */
  | { type: "stop_capture"; sessionId: number }
  /**
   * Stop capturing, release the tracks, and throw away whatever arrives.
   *
   * Distinct from `stop_capture` on purpose: they differ in what happens to
   * the bytes, and one effect with a boolean would be a single place for that
   * distinction to be got wrong.
   */
  | { type: "discard_capture"; sessionId: number }
  /** Release the microphone. Always paired with reaching a resting state. */
  | { type: "release_microphone" }
  /** Send the recorded clip for transcription. */
  | { type: "upload_clip"; sessionId: number };

export type VoiceRecorderTransition = {
  state: VoiceRecorderState;
  effects: VoiceRecorderEffect[];
};

export const initialVoiceRecorderState: VoiceRecorderState = { status: "idle" };

/** The states in which a microphone is, or may shortly be, open. */
const LIVE_STATUSES = new Set([
  "permission_pending",
  "recording",
  "stopping",
]);

export const isVoiceRecorderBusy = (state: VoiceRecorderState): boolean =>
  LIVE_STATUSES.has(state.status) || state.status === "transcribing";

/** The session a state belongs to, or `null` for the resting states. */
const sessionOf = (state: VoiceRecorderState): number | null =>
  "sessionId" in state ? state.sessionId : null;

const stay = (state: VoiceRecorderState): VoiceRecorderTransition => ({
  state,
  effects: [],
});

/**
 * Compile-time proof that the switch below covers every event.
 *
 * `never` is what does the work: if an event type gains a variant with no
 * case, `event` is no longer `never` here and the call stops type-checking. At
 * runtime it simply stays put, because a machine that threw on an unrecognised
 * event would turn a missed case into a crashed composer.
 */
const assertHandled = (
  event: never,
  state: VoiceRecorderState
): VoiceRecorderTransition => {
  void event;
  return stay(state);
};

/**
 * `sessionId` is supplied by the caller rather than generated here so the
 * reducer stays a function of its arguments. The hook increments a ref.
 */
export const voiceRecorderReducer = (
  state: VoiceRecorderState,
  event: VoiceRecorderEvent,
  nextSessionId: number
): VoiceRecorderTransition => {
  // Late events from a session that is no longer the current one are dropped
  // before any state is consulted. See the header: this is the whole reason
  // sessions exist, so it is one check rather than a case in every branch.
  if ("sessionId" in event && event.sessionId !== sessionOf(state)) {
    return stay(state);
  }

  switch (event.type) {
    case "start_requested": {
      // Starting is only meaningful from a resting state. A press while a
      // recording is already running is not a second recording; the UI shows
      // stop and cancel at that point, and treating it as a restart would
      // silently discard what the user has said so far.
      if (isVoiceRecorderBusy(state)) return stay(state);
      return {
        state: { status: "permission_pending", sessionId: nextSessionId },
        effects: [{ type: "request_microphone", sessionId: nextSessionId }],
      };
    }

    case "unsupported": {
      // Reachable from `idle` (feature-detected on press) and from
      // `permission_pending` (no container both ends accept). Not an error the
      // user can retry out of, but still dismissible: it must not sit in the
      // composer forever.
      if (state.status !== "idle" && state.status !== "permission_pending") {
        return stay(state);
      }
      return {
        state: { status: "error", code: "VOICE_UNSUPPORTED_BROWSER", serverCode: null },
        effects: [{ type: "release_microphone" }],
      };
    }

    case "permission_granted": {
      if (state.status !== "permission_pending") return stay(state);
      return {
        state: {
          status: "recording",
          sessionId: state.sessionId,
          elapsedMs: 0,
          stoppedByLimit: false,
        },
        effects: [{ type: "start_capture", sessionId: state.sessionId }],
      };
    }

    case "permission_denied": {
      if (state.status !== "permission_pending") return stay(state);
      return {
        state: { status: "error", code: "VOICE_PERMISSION_DENIED", serverCode: null },
        effects: [{ type: "release_microphone" }],
      };
    }

    case "device_unavailable": {
      if (state.status !== "permission_pending") return stay(state);
      return {
        state: { status: "error", code: "VOICE_DEVICE_UNAVAILABLE", serverCode: null },
        effects: [{ type: "release_microphone" }],
      };
    }

    case "tick": {
      if (state.status !== "recording") return stay(state);
      const elapsedMs = Math.max(state.elapsedMs, event.elapsedMs);
      if (elapsedMs >= VOICE_CLIP_MAX_SECONDS * 1000) {
        // The limit stops the recording; it does not throw it away. What has
        // been said so far is still the user's, and discarding two minutes of
        // speech to enforce a two-minute ceiling would be the limit punishing
        // the person who reached it.
        return {
          state: {
            status: "stopping",
            sessionId: state.sessionId,
            elapsedMs,
            stoppedByLimit: true,
          },
          effects: [{ type: "stop_capture", sessionId: state.sessionId }],
        };
      }
      return stay({ ...state, elapsedMs });
    }

    case "stop_requested": {
      if (state.status !== "recording") return stay(state);
      return {
        state: {
          status: "stopping",
          sessionId: state.sessionId,
          elapsedMs: state.elapsedMs,
          stoppedByLimit: state.stoppedByLimit,
        },
        effects: [{ type: "stop_capture", sessionId: state.sessionId }],
      };
    }

    case "cancel_requested": {
      // Cancel reaches every non-resting state, including `transcribing`: a
      // user who has changed their mind while the server is working is
      // entitled to stop waiting, and the transcript that arrives afterwards
      // is dropped by the session check above.
      const sessionId = sessionOf(state);
      if (sessionId === null) {
        // From `error`, cancel is just a dismissal.
        return state.status === "error"
          ? { state: { status: "idle" }, effects: [] }
          : stay(state);
      }
      return {
        state: { status: "idle" },
        effects: [
          { type: "discard_capture", sessionId },
          { type: "release_microphone" },
        ],
      };
    }

    case "clip_ready": {
      if (state.status !== "stopping") return stay(state);
      if (event.byteLength < VOICE_CLIP_MIN_BYTES) {
        // Refused here rather than at the server, because the server cannot
        // give a better answer and the round trip would cost the user a wait
        // to be told nothing was recorded. The server enforces the same floor
        // independently (docs/policy/voice-input.md §5.1) — this is the
        // pre-emption, not the enforcement.
        return {
          state: { status: "error", code: "VOICE_CLIP_EMPTY", serverCode: null },
          effects: [{ type: "release_microphone" }],
        };
      }
      return {
        state: {
          status: "transcribing",
          sessionId: state.sessionId,
          elapsedMs: state.elapsedMs,
        },
        effects: [
          { type: "release_microphone" },
          { type: "upload_clip", sessionId: state.sessionId },
        ],
      };
    }

    case "transcription_succeeded": {
      if (state.status !== "transcribing") return stay(state);
      // Back to rest, and nothing else. The transcript reaches the draft
      // through the hook's own callback; there is no effect here that could
      // grow into an automatic send.
      return { state: { status: "idle" }, effects: [] };
    }

    case "transcription_failed": {
      if (state.status !== "transcribing") return stay(state);
      return {
        state: {
          status: "error",
          code: event.code,
          serverCode: event.serverCode ?? null,
        },
        effects: [],
      };
    }

    case "dismiss_error": {
      if (state.status !== "error") return stay(state);
      return { state: { status: "idle" }, effects: [] };
    }

    default:
      // Exhaustiveness. Adding an event type without a case above makes this
      // line a compile error, rather than a press that is silently ignored at
      // runtime — which is the failure mode a `default: return state` hides.
      return assertHandled(event, state);
  }
};
