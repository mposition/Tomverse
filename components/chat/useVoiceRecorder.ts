"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createVoiceCaptureAdapter,
  type VoiceCaptureAdapter,
} from "@/lib/voiceCaptureAdapter";
import {
  VOICE_CLIP_MAX_SECONDS,
  VOICE_RECORDER_BITS_PER_SECOND,
  VOICE_RECORDER_MIME_PREFERENCE,
} from "@/lib/voiceInputFormats";
import {
  initialVoiceRecorderState,
  isVoiceRecorderBusy,
  voiceRecorderReducer,
  type VoiceRecorderEvent,
  type VoiceRecorderState,
} from "@/lib/voiceRecorderMachine";

/**
 * React's share of voice input: state, and the lifetime of the adapter.
 *
 * Contract: docs/policy/voice-input.md §8.
 *
 * Three layers, and the split is load-bearing rather than tidy:
 *
 *   * `lib/voiceRecorderMachine.ts` decides what should happen. Pure.
 *   * `lib/voiceCaptureAdapter.ts` owns the microphone, the recorder, the
 *     timer and the request. Framework-free, so a test can make `stop()` throw.
 *   * this file wires them to React and to the conversation on screen.
 *
 * The resource handling used to live here, where the only way to execute it
 * was to render React and drive a real `MediaRecorder` — so "a failed recorder
 * still closes its microphone" was a comment rather than a test. It is now
 * `tests/voiceCaptureAdapter.test.mjs`.
 *
 * ## The transcript is returned, never sent
 *
 * `onTranscript` hands text to the composer. There is no submit callback, no
 * ref to a send handler and no event dispatch, so there is nothing here that a
 * later change could accidentally wire to Send (docs/policy/voice-input.md §1).
 *
 * ## A session belongs to one conversation
 *
 * docs/policy/voice-input.md §8.4. `ChatInput` is not remounted when the user
 * opens another conversation, so without this a transcription started in
 * conversation A would finish while B is on screen and its words would be
 * appended to B's draft. Every session captures its scope at the moment it
 * starts; `onTranscript` is given that scope rather than whatever is open when
 * the server answers, and a scope change ends the session outright.
 */

export type UseVoiceRecorderOptions = {
  /**
   * Called with the finished transcript and the draft scope it belongs to.
   *
   * The scope is the conversation the recording *started* in, which is not
   * necessarily the one on screen. The composer writes into that scope
   * explicitly.
   */
  onTranscript: (transcript: string, scopeId: string | null) => void;
  /** The conversation draft scope the composer is currently on. */
  scopeId: string | null;
  /**
   * Who is signed in, as an opaque key. A change ends a running session for
   * the same reason a conversation change does: the draft it was going to land
   * in is no longer the same person's.
   */
  identityKey?: string | null;
  /** Where to POST the clip. Injected so a test can point it elsewhere. */
  endpoint?: string;
};

export type VoiceRecorderController = {
  state: VoiceRecorderState;
  /** Seconds elapsed, for the recording indicator. */
  elapsedSeconds: number;
  /** The server's refusal code, when the last failure came from the server. */
  serverCode: string | null;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  dismissError: () => void;
};

const pickMimeType = (): string | null => {
  if (typeof MediaRecorder === "undefined") return null;
  for (const candidate of VOICE_RECORDER_MIME_PREFERENCE) {
    // Guarded: `isTypeSupported` is absent on a few old implementations that
    // still expose the constructor, and calling it would throw where the
    // honest answer is "this browser cannot do it".
    if (
      typeof MediaRecorder.isTypeSupported === "function" &&
      MediaRecorder.isTypeSupported(candidate)
    ) {
      return candidate;
    }
  }
  return null;
};

/** The container half of a `MediaRecorder` mime type, for the upload header. */
const containerOf = (mimeType: string) => mimeType.split(";", 1)[0].trim();

export const voiceRecorderSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  pickMimeType() !== null;

export function useVoiceRecorder(
  options: UseVoiceRecorderOptions
): VoiceRecorderController {
  const [state, setState] = useState<VoiceRecorderState>(
    initialVoiceRecorderState
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  /*
    The machine's state is kept in a ref *as well as* in React state, and the
    ref is only ever written inside `dispatch`.

    Both are needed. `dispatch` has to read the state it is transitioning from,
    and it runs from timers, device callbacks and `fetch` continuations — none
    of which can see a value captured when the component last rendered. The
    `useState` copy is what re-renders the controls.

    Writing the ref during render would be the obvious shortcut and is what
    React forbids (`react-hooks/refs`): a render can be thrown away, and the
    ref would keep the state of one that never committed.
  */
  const stateRef = useRef<VoiceRecorderState>(initialVoiceRecorderState);
  const sessionRef = useRef(0);
  const adapterRef = useRef<VoiceCaptureAdapter | null>(null);
  const dispatchRef = useRef<(event: VoiceRecorderEvent) => void>(() => {});

  /** The draft scope each live session was started in. */
  const sessionScopeRef = useRef(new Map<number, string | null>());

  const onTranscriptRef = useRef(options.onTranscript);
  const scopeRef = useRef(options.scopeId);
  const identityRef = useRef(options.identityKey ?? null);
  const endpoint = options.endpoint ?? "/api/chat/voice-transcription";

  // The latest-callback pattern, in an effect rather than the render body: the
  // callback is only read from an async continuation, which by definition runs
  // after the commit that stored it.
  useEffect(() => {
    onTranscriptRef.current = options.onTranscript;
  }, [options.onTranscript]);

  const runEffects = useCallback(
    (effects: ReturnType<typeof voiceRecorderReducer>["effects"]) => {
      const adapter = adapterRef.current;
      if (!adapter) return;
      for (const effect of effects) {
        // Each effect is isolated. A teardown that throws must not abandon the
        // effects queued behind it — `cancel_requested` emits discard *then*
        // release, and a throwing discard used to take the release with it,
        // leaving the microphone open on a recording the user threw away.
        try {
          switch (effect.type) {
            case "request_microphone":
              void adapter.requestMicrophone(effect.sessionId);
              break;
            case "start_capture":
              adapter.startCapture(effect.sessionId);
              break;
            case "stop_capture":
              adapter.stopCapture(effect.sessionId);
              break;
            case "discard_capture":
              adapter.discardCapture(effect.sessionId);
              break;
            case "release_microphone":
              adapter.releaseMicrophone(effect.sessionId);
              break;
            case "upload_clip":
              void adapter.uploadClip(effect.sessionId);
              break;
          }
        } catch {
          // Nothing here is actionable by the user, and a device teardown's
          // error object is not something this feature logs (§11.2).
        }
      }
    },
    []
  );

  const dispatch = useCallback(
    (event: VoiceRecorderEvent) => {
      const nextSessionId =
        event.type === "start_requested"
          ? sessionRef.current + 1
          : sessionRef.current;
      const transition = voiceRecorderReducer(
        stateRef.current,
        event,
        nextSessionId
      );
      if (event.type === "start_requested" && transition.state !== stateRef.current) {
        sessionRef.current = nextSessionId;
        // Captured here, at the only moment the answer is unambiguous.
        sessionScopeRef.current.set(nextSessionId, scopeRef.current);
      }
      stateRef.current = transition.state;
      setState(transition.state);
      runEffects(transition.effects);
    },
    [runEffects]
  );

  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  /**
   * Builds the adapter for a session, once the container is known.
   *
   * Created on demand rather than at mount: the mime type is the result of a
   * negotiation that needs `MediaRecorder`, which does not exist on the server.
   */
  const ensureAdapter = useCallback(
    (mimeType: string): VoiceCaptureAdapter => {
      if (adapterRef.current) return adapterRef.current;
      const adapter = createVoiceCaptureAdapter({
        deps: {
          getUserMedia: () =>
            navigator.mediaDevices.getUserMedia({
              // Mono, with the browser's own cleanup on. Speech recognition
              // gains nothing from stereo and pays for it in bytes.
              audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
              },
            }),
          createRecorder: (stream, mime) =>
            new MediaRecorder(stream as MediaStream, {
              mimeType: mime,
              audioBitsPerSecond: VOICE_RECORDER_BITS_PER_SECOND,
            }) as unknown as ReturnType<
              Parameters<typeof createVoiceCaptureAdapter>[0]["deps"]["createRecorder"]
            >,
          createClip: (parts, mediaType) =>
            new Blob(parts as BlobPart[], { type: mediaType }) as unknown as {
              size: number;
            } & BodyInit,
          fetchImpl: (input, init) => fetch(input, init),
          now: () => Date.now(),
          setInterval: (handler, ms) => window.setInterval(handler, ms),
          clearInterval: (handle) => window.clearInterval(handle as number),
        },
        mimeType,
        uploadMediaType: containerOf(mimeType),
        endpoint,
        dispatch: (event) => dispatchRef.current(event as VoiceRecorderEvent),
        onTranscript: (transcript, sessionId) => {
          // The scope this session started in, not the one on screen now.
          const scope = sessionScopeRef.current.get(sessionId) ?? null;
          onTranscriptRef.current(transcript, scope);
        },
        onElapsed: (elapsedMs) =>
          setElapsedSeconds(Math.floor(elapsedMs / 1000)),
      });
      adapterRef.current = adapter;
      return adapter;
    },
    [endpoint]
  );

  /*
    A conversation switch, or a change of who is signed in, ends a running
    session (docs/policy/voice-input.md §8.4).

    Compared against a ref rather than a dependency list on purpose: the first
    render must not count as a change, and the refs are what the async paths
    read. `ChatInput` is never remounted by a conversation switch, so this
    effect is the only thing standing between a recording started in A and a
    transcript appended to B.
  */
  useEffect(() => {
    const nextScope = options.scopeId;
    const nextIdentity = options.identityKey ?? null;
    const changed =
      scopeRef.current !== nextScope || identityRef.current !== nextIdentity;
    scopeRef.current = nextScope;
    identityRef.current = nextIdentity;
    if (!changed) return;
    if (!isVoiceRecorderBusy(stateRef.current)) return;
    const sessionId =
      "sessionId" in stateRef.current ? stateRef.current.sessionId : null;
    if (sessionId === null) return;
    dispatchRef.current({ type: "scope_changed", sessionId });
  }, [options.scopeId, options.identityKey]);

  // Unmounting mid-recording must not leave the microphone open. The composer
  // is remounted by ordinary navigation, so this is routine, not an edge case.
  useEffect(
    () => () => {
      adapterRef.current?.destroy();
      adapterRef.current = null;
    },
    []
  );

  /*
    Support is checked on the press, not held in state.

    `MediaRecorder` does not exist on the server, so a `supported` flag would
    start as "unknown" and settle after hydration — meaning either a microphone
    that appears a frame late, or one briefly rendered as unavailable to a user
    already reaching for it. Checking here means the button is always present
    and a browser that cannot record says so the moment it is asked.
  */
  const start = useCallback(() => {
    const mimeType = pickMimeType();
    if (!mimeType || !navigator.mediaDevices?.getUserMedia) {
      dispatchRef.current({ type: "unsupported" });
      return;
    }
    ensureAdapter(mimeType);
    dispatchRef.current({ type: "start_requested" });
  }, [ensureAdapter]);

  return {
    state,
    elapsedSeconds: Math.min(elapsedSeconds, VOICE_CLIP_MAX_SECONDS),
    serverCode: state.status === "error" ? state.serverCode : null,
    start,
    stop: () => dispatchRef.current({ type: "stop_requested" }),
    cancel: () => dispatchRef.current({ type: "cancel_requested" }),
    dismissError: () => dispatchRef.current({ type: "dismiss_error" }),
  };
}

export { isVoiceRecorderBusy };
