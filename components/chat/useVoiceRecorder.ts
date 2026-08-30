"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  VOICE_CLIP_MAX_SECONDS,
  VOICE_RECORDER_BITS_PER_SECOND,
  VOICE_RECORDER_MIME_PREFERENCE,
} from "@/lib/voiceInputFormats";
import {
  initialVoiceRecorderState,
  isVoiceRecorderBusy,
  voiceRecorderReducer,
  type VoiceRecorderEffect,
  type VoiceRecorderEvent,
  type VoiceRecorderState,
} from "@/lib/voiceRecorderMachine";

/**
 * The adapter between `lib/voiceRecorderMachine.ts` and the browser.
 *
 * Contract: docs/policy/voice-input.md §8.
 *
 * Everything device-shaped lives here — `getUserMedia`, `MediaRecorder`, the
 * elapsed-time interval, the upload — and every *decision* lives in the
 * reducer. The split is not decoration: the orderings that actually break this
 * feature (a blob arriving after a cancel, a permission answer arriving after
 * the user gave up, the limit and a stop landing in the same tick) cannot be
 * provoked reliably by driving a real recorder, and they are all unit tests
 * against the reducer.
 *
 * ## The transcript is returned, never sent
 *
 * `onTranscript` hands text to the composer. There is no submit callback, no
 * ref to a send handler and no event dispatch, so there is nothing here that a
 * later change could accidentally wire to Send
 * (docs/policy/voice-input.md §1).
 */

export type UseVoiceRecorderOptions = {
  /** Called with the finished transcript. The composer decides what to do. */
  onTranscript: (transcript: string) => void;
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

    Both are needed and neither is redundant. `dispatch` has to read the state
    it is transitioning from, and it runs from timers, `MediaRecorder`
    callbacks and `fetch` continuations — none of which can see a value
    captured when the component last rendered. The `useState` copy is what
    actually re-renders the controls.

    Writing the ref during render would be the obvious shortcut and is exactly
    what React forbids (`react-hooks/refs`): under concurrent rendering a
    render can be thrown away, and the ref would keep the state of a render
    that never committed.
  */
  const stateRef = useRef<VoiceRecorderState>(initialVoiceRecorderState);

  const sessionRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeRef = useRef<string | null>(null);
  const clipRef = useRef<Blob | null>(null);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Sessions the user abandoned. Their bytes are dropped on arrival. */
  const discardedRef = useRef(new Set<number>());
  const abortRef = useRef<AbortController | null>(null);
  const onTranscriptRef = useRef(options.onTranscript);
  const endpoint = options.endpoint ?? "/api/chat/voice-transcription";

  // The latest-callback pattern, in an effect rather than in the render body.
  // The callback is only ever read from an async continuation, which by
  // definition runs after the commit that stored it.
  useEffect(() => {
    onTranscriptRef.current = options.onTranscript;
  }, [options.onTranscript]);

  const stopTicking = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const releaseMicrophone = useCallback(() => {
    stopTicking();
    // Stopping every track is what turns the browser's recording indicator
    // off. Dropping the reference without this leaves the microphone open —
    // to the user, the product is still listening.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, [stopTicking]);

  /** Forward-declared so effects can dispatch follow-up events. */
  const dispatchRef = useRef<(event: VoiceRecorderEvent) => void>(() => {});

  const uploadClip = useCallback(
    async (sessionId: number) => {
      const clip = clipRef.current;
      const mimeType = mimeRef.current;
      clipRef.current = null;
      if (!clip || !mimeType) {
        dispatchRef.current({
          type: "transcription_failed",
          sessionId,
          code: "VOICE_TRANSCRIPTION_FAILED",
        });
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          // The container only. A `MediaRecorder` mime carries a codec
          // parameter the endpoint's allowlist does not key on, and sending it
          // would make the header disagree with the table on both sides.
          headers: { "Content-Type": containerOf(mimeType) },
          body: clip,
          signal: controller.signal,
          // The clip is not a navigation and must never be replayed from a
          // cache or sent with ambient credentials beyond the session cookie.
          cache: "no-store",
        });

        if (!response.ok) {
          const payload = (await response
            .json()
            .catch(() => null)) as { code?: string } | null;
          dispatchRef.current({
            type: "transcription_failed",
            sessionId,
            code: "VOICE_TRANSCRIPTION_FAILED",
            serverCode: payload?.code ?? null,
          });
          return;
        }

        const payload = (await response.json()) as { transcript?: unknown };
        if (typeof payload.transcript !== "string" || !payload.transcript) {
          dispatchRef.current({
            type: "transcription_failed",
            sessionId,
            code: "VOICE_TRANSCRIPTION_FAILED",
            serverCode: "VOICE_TRANSCRIPT_EMPTY",
          });
          return;
        }

        // The session check in the reducer protects the *state*; this one
        // protects the *draft*. A transcript from a cancelled recording must
        // not reach the composer even though the machine would ignore the
        // event that follows it.
        if (!discardedRef.current.has(sessionId)) {
          onTranscriptRef.current(payload.transcript);
        }
        dispatchRef.current({ type: "transcription_succeeded", sessionId });
      } catch (error) {
        if ((error as Error | null)?.name === "AbortError") return;
        dispatchRef.current({
          type: "transcription_failed",
          sessionId,
          code: "VOICE_NETWORK_ERROR",
        });
      } finally {
        abortRef.current = null;
      }
    },
    [endpoint]
  );

  const requestMicrophone = useCallback(
    async (sessionId: number) => {
      const mimeType = pickMimeType();
      if (!navigator.mediaDevices?.getUserMedia || !mimeType) {
        dispatchRef.current({ type: "unsupported" });
        return;
      }
      mimeRef.current = mimeType;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Mono, and the browser's own cleanup switched on. Voice recognition
          // gains nothing from stereo and pays for it in bytes.
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        if (discardedRef.current.has(sessionId)) {
          // The user cancelled while the permission prompt was open. The
          // stream we were granted is released immediately rather than left
          // open behind a dialog nobody is looking at any more.
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        dispatchRef.current({ type: "permission_granted", sessionId });
      } catch (error) {
        const name = (error as Error | null)?.name;
        // `NotAllowedError` and `SecurityError` are refusals; everything else
        // is a device that could not deliver. They get different sentences
        // because they have different fixes.
        dispatchRef.current(
          name === "NotAllowedError" || name === "SecurityError"
            ? { type: "permission_denied", sessionId }
            : { type: "device_unavailable", sessionId }
        );
      }
    },
    []
  );

  const startCapture = useCallback(
    (sessionId: number) => {
      const stream = streamRef.current;
      const mimeType = mimeRef.current;
      if (!stream || !mimeType) {
        dispatchRef.current({ type: "device_unavailable", sessionId });
        return;
      }
      chunksRef.current = [];
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, {
          mimeType,
          audioBitsPerSecond: VOICE_RECORDER_BITS_PER_SECOND,
        });
      } catch {
        dispatchRef.current({ type: "unsupported" });
        return;
      }
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const parts = chunksRef.current;
        chunksRef.current = [];
        if (discardedRef.current.has(sessionId)) {
          // Nothing is assembled at all for an abandoned session: the parts go
          // out of scope here rather than becoming a Blob somebody could
          // later decide to send.
          return;
        }
        const clip = new Blob(parts, { type: containerOf(mimeType) });
        clipRef.current = clip;
        dispatchRef.current({
          type: "clip_ready",
          sessionId,
          byteLength: clip.size,
        });
      };
      recorder.onerror = () => {
        dispatchRef.current({ type: "device_unavailable", sessionId });
      };
      // No timeslice: one final blob rather than a stream of fragments. A
      // complete container is what carries the duration the server reads
      // (lib/voiceClipDuration.ts), and a chunked recording assembled by hand
      // is where that stops being true.
      recorder.start();

      startedAtRef.current = Date.now();
      setElapsedSeconds(0);
      stopTicking();
      tickRef.current = setInterval(() => {
        const elapsedMs = Date.now() - startedAtRef.current;
        setElapsedSeconds(Math.floor(elapsedMs / 1000));
        dispatchRef.current({ type: "tick", sessionId, elapsedMs });
      }, 250);
    },
    [stopTicking]
  );

  // No session parameter: the recorder is the current one by construction, and
  // an argument that is never read invites a caller to believe it is checked.
  const stopCapture = useCallback(() => {
    stopTicking();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, [stopTicking]);

  const discardCapture = useCallback(
    (sessionId: number) => {
      discardedRef.current.add(sessionId);
      abortRef.current?.abort();
      abortRef.current = null;
      clipRef.current = null;
      chunksRef.current = [];
      stopCapture();
    },
    [stopCapture]
  );

  const runEffect = useCallback(
    (effect: VoiceRecorderEffect) => {
      switch (effect.type) {
        case "request_microphone":
          void requestMicrophone(effect.sessionId);
          return;
        case "start_capture":
          startCapture(effect.sessionId);
          return;
        case "stop_capture":
          stopCapture();
          return;
        case "discard_capture":
          discardCapture(effect.sessionId);
          return;
        case "release_microphone":
          releaseMicrophone();
          return;
        case "upload_clip":
          void uploadClip(effect.sessionId);
          return;
      }
    },
    [
      discardCapture,
      releaseMicrophone,
      requestMicrophone,
      startCapture,
      stopCapture,
      uploadClip,
    ]
  );

  const dispatch = useCallback(
    (event: VoiceRecorderEvent) => {
      const nextSessionId =
        event.type === "start_requested" ? sessionRef.current + 1 : sessionRef.current;
      const transition = voiceRecorderReducer(
        stateRef.current,
        event,
        nextSessionId
      );
      if (event.type === "start_requested" && transition.state !== stateRef.current) {
        sessionRef.current = nextSessionId;
      }
      stateRef.current = transition.state;
      setState(transition.state);
      for (const effect of transition.effects) runEffect(effect);
    },
    [runEffect]
  );
  // Assigned in an effect for the same reason as `onTranscriptRef`: every
  // caller of `dispatchRef.current` is a timer, a device callback or a network
  // continuation, all of which run after the commit.
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  // Unmounting mid-recording must not leave the microphone open. The composer
  // is remounted by ordinary navigation, so this is a routine path, not an
  // edge case.
  useEffect(
    () => () => {
      discardedRef.current.add(sessionRef.current);
      abortRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      if (tickRef.current) clearInterval(tickRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    []
  );

  /*
    Support is checked on the press, not held in state.

    `MediaRecorder` does not exist on the server, so a `supported` flag would
    have to start as "unknown" and settle after hydration — which means either
    a microphone that appears a frame late, or one that is briefly rendered as
    unavailable to a user who is already reaching for it. Checking here instead
    means the button is always present and a browser that cannot record says so
    the moment it is asked, which is a state the machine already models.
  */
  const start = useCallback(() => {
    if (!voiceRecorderSupported()) {
      dispatchRef.current({ type: "unsupported" });
      return;
    }
    dispatchRef.current({ type: "start_requested" });
  }, []);

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
