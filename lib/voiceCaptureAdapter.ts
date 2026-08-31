/**
 * The thing that actually owns a microphone.
 *
 * Contract: docs/policy/voice-input.md §8.5.
 *
 * `lib/voiceRecorderMachine.ts` decides *what* should happen; this carries it
 * out. Framework-free and dependency-injected — no React, no `window`, no
 * globals — for the reason the repository applies everywhere else it separates
 * a core from a binding (`lib/emailProviderPortCore.ts`): the rules can then be
 * driven by a test without a browser, and nothing that cannot import the
 * binding has a reason to write its own copy of them.
 *
 * ## Why this was extracted
 *
 * The resource handling used to live inside `useVoiceRecorder`, where the only
 * way to execute it was to render React and drive a real `MediaRecorder`. So
 * the claims that matter most here — that a failed recorder still closes its
 * microphone, that a cleanup step which throws does not skip the rest, that a
 * late callback from a finished session cannot release the microphone a newer
 * one just opened — were argued in comments rather than tested. A reducer test
 * cannot prove any of them: the reducer names an effect, it does not perform
 * one.
 *
 * ## The rules this file exists to hold
 *
 * 1. **Cleanup is idempotent.** Every release/discard may be called any number
 *    of times, in any order, including after `destroy()`.
 * 2. **Cleanup never throws, and never stops half-way.** Each step is isolated,
 *    so a `stop()` that throws still leaves the tracks stopped and the timer
 *    cleared. A browser that throws on teardown must not be able to strand a
 *    microphone.
 * 3. **Every session-scoped operation checks its session.** An effect naming a
 *    session that is no longer the active one is dropped. This is the second
 *    line behind the reducer's own session guard, and it is the one that holds
 *    when a device callback reaches the adapter directly.
 * 4. **A failure closes what it opened.** There is no path that reports an
 *    error and leaves the stream live.
 */

/** Only the parts of `MediaRecorder` this adapter uses. */
export type VoiceRecorderLike = {
  state: string;
  start: (timeslice?: number) => void;
  stop: () => void;
  ondataavailable: ((event: { data?: { size: number } | null }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
};

/** Only the parts of `MediaStream` this adapter uses. */
export type VoiceStreamLike = {
  getTracks: () => Array<{ stop: () => void }>;
};

export type VoiceCaptureDeps = {
  /** Resolves a microphone stream, or rejects the way `getUserMedia` does. */
  getUserMedia: () => Promise<VoiceStreamLike>;
  /** Constructs a recorder, or throws the way `new MediaRecorder` does. */
  createRecorder: (stream: VoiceStreamLike, mimeType: string) => VoiceRecorderLike;
  /** Assembles the captured parts into something `fetch` can send. */
  createClip: (parts: unknown[], mediaType: string) => { size: number } & BodyInit;
  fetchImpl: typeof fetch;
  now: () => number;
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export type VoiceCaptureAdapterOptions = {
  deps: VoiceCaptureDeps;
  /** The container the recorder produces, already negotiated by the caller. */
  mimeType: string;
  /** The media type the upload declares — the container without parameters. */
  uploadMediaType: string;
  endpoint: string;
  dispatch: (event: VoiceCaptureDispatch) => void;
  /** Hands a finished transcript back, with the session it belongs to. */
  onTranscript: (transcript: string, sessionId: number) => void;
  /** Reports elapsed milliseconds to the UI, outside the machine. */
  onElapsed: (elapsedMs: number) => void;
  tickIntervalMs?: number;
};

/**
 * The events this adapter can raise. A subset of the machine's, by design: the
 * adapter reports what a device or a server did, never what the user did.
 */
export type VoiceCaptureDispatch =
  | { type: "unsupported"; sessionId?: number }
  | { type: "permission_granted"; sessionId: number }
  | { type: "permission_denied"; sessionId: number }
  | { type: "device_unavailable"; sessionId: number }
  | { type: "tick"; sessionId: number; elapsedMs: number }
  | { type: "clip_ready"; sessionId: number; byteLength: number }
  | { type: "transcription_succeeded"; sessionId: number }
  | {
      type: "transcription_failed";
      sessionId: number;
      code: "VOICE_NETWORK_ERROR" | "VOICE_TRANSCRIPTION_FAILED";
      serverCode?: string | null;
    };

/**
 * Runs one teardown step and swallows whatever it throws.
 *
 * The whole point of rule 2. A browser is entitled to throw from `stop()` — an
 * already-inactive recorder does — and one such throw used to abandon every
 * cleanup step queued behind it, which is how a cancelled recording could
 * leave the microphone indicator on.
 */
const attempt = (step: () => void) => {
  try {
    step();
  } catch {
    // Deliberately silent. Nothing here is diagnosable by a user, and the
    // error object from a device teardown is not something this feature logs
    // (docs/policy/voice-input.md §11.2).
  }
};

export type VoiceCaptureAdapter = {
  requestMicrophone: (sessionId: number) => Promise<void>;
  startCapture: (sessionId: number) => void;
  stopCapture: (sessionId: number) => void;
  discardCapture: (sessionId: number) => void;
  releaseMicrophone: (sessionId: number | null) => void;
  uploadClip: (sessionId: number) => Promise<void>;
  /** Unmount. Idempotent, and safe to call while anything is in flight. */
  destroy: () => void;
  /** What the adapter is holding. For tests and for nothing else. */
  inspect: () => {
    hasStream: boolean;
    hasRecorder: boolean;
    hasTimer: boolean;
    hasClip: boolean;
    activeSessionId: number | null;
    destroyed: boolean;
  };
};

export const createVoiceCaptureAdapter = (
  options: VoiceCaptureAdapterOptions
): VoiceCaptureAdapter => {
  const { deps } = options;

  let stream: VoiceStreamLike | null = null;
  let recorder: VoiceRecorderLike | null = null;
  let parts: unknown[] = [];
  let clip: ({ size: number } & BodyInit) | null = null;
  let timer: unknown = null;
  let startedAt = 0;
  let abort: AbortController | null = null;
  let destroyed = false;

  /**
   * The session the adapter is currently working for.
   *
   * Set when a microphone is requested and cleared when the session ends. Every
   * session-scoped method compares against it, which is what stops a device
   * callback belonging to a finished recording from touching a live one.
   */
  let activeSessionId: number | null = null;
  /** Sessions the user abandoned; their bytes are dropped wherever they land. */
  const discarded = new Set<number>();

  /**
   * The abandoned-session set is bounded.
   *
   * It only ever needs to answer "is this *recent* session abandoned", and a
   * session id only grows, so anything far behind the active one can never be
   * asked about again. Left unbounded it is a set that grows for as long as the
   * composer is mounted.
   */
  const rememberDiscarded = (sessionId: number) => {
    discarded.add(sessionId);
    if (discarded.size > 32) {
      const oldest = Math.min(...discarded);
      discarded.delete(oldest);
    }
  };

  const isCurrent = (sessionId: number) =>
    !destroyed && activeSessionId === sessionId && !discarded.has(sessionId);

  const clearTimer = () => {
    if (timer === null) return;
    const handle = timer;
    timer = null;
    attempt(() => deps.clearInterval(handle));
  };

  const stopTracks = () => {
    const current = stream;
    stream = null;
    if (!current) return;
    // Each track separately: one that throws must not leave the rest running,
    // because a single live track keeps the browser's recording indicator on.
    let tracks: Array<{ stop: () => void }> = [];
    attempt(() => {
      tracks = current.getTracks();
    });
    for (const track of tracks) attempt(() => track.stop());
  };

  const detachRecorder = () => {
    const current = recorder;
    recorder = null;
    if (!current) return;
    // Handlers are cleared before the recorder is dropped: a recorder that
    // fires `onstop` after its session ended would otherwise reach a closure
    // that still believes it is live.
    attempt(() => {
      current.ondataavailable = null;
      current.onstop = null;
      current.onerror = null;
    });
    attempt(() => {
      if (current.state !== "inactive") current.stop();
    });
  };

  const releaseMicrophone = (sessionId: number | null) => {
    // A release naming a session that is not the active one is a late effect
    // from a finished recording. Acting on it would close the microphone the
    // *current* session just opened.
    if (sessionId !== null && activeSessionId !== null && sessionId !== activeSessionId) {
      return;
    }
    clearTimer();
    detachRecorder();
    stopTracks();
    parts = [];
    if (sessionId !== null && sessionId === activeSessionId) activeSessionId = null;
  };

  const discardCapture = (sessionId: number) => {
    rememberDiscarded(sessionId);
    attempt(() => abort?.abort());
    abort = null;
    clip = null;
    parts = [];
    clearTimer();
    detachRecorder();
  };

  const requestMicrophone = async (sessionId: number) => {
    if (destroyed) return;
    activeSessionId = sessionId;
    let granted: VoiceStreamLike;
    try {
      granted = await deps.getUserMedia();
    } catch (error) {
      const name = (error as Error | null)?.name;
      // A refusal and a device that could not deliver have different fixes, so
      // they get different sentences.
      options.dispatch(
        name === "NotAllowedError" || name === "SecurityError"
          ? { type: "permission_denied", sessionId }
          : { type: "device_unavailable", sessionId }
      );
      return;
    }
    if (destroyed || discarded.has(sessionId) || activeSessionId !== sessionId) {
      // The user cancelled, switched conversation, or navigated away while the
      // permission prompt was open. The stream we were granted is released
      // here rather than left open behind a dialog nobody is looking at.
      for (const track of granted.getTracks()) attempt(() => track.stop());
      return;
    }
    stream = granted;
    options.dispatch({ type: "permission_granted", sessionId });
  };

  const startCapture = (sessionId: number) => {
    if (!isCurrent(sessionId)) return;
    const active = stream;
    if (!active) {
      // Reported as a device failure rather than silently ignored: the machine
      // is already in `recording` by now, so a return with no dispatch is the
      // stuck state this adapter exists to make impossible.
      options.dispatch({ type: "device_unavailable", sessionId });
      return;
    }

    parts = [];
    let created: VoiceRecorderLike;
    try {
      created = deps.createRecorder(active, options.mimeType);
    } catch {
      options.dispatch({ type: "unsupported", sessionId });
      return;
    }
    recorder = created;

    created.ondataavailable = (event) => {
      if (event?.data && event.data.size > 0) parts.push(event.data);
    };
    created.onstop = () => {
      const captured = parts;
      parts = [];
      // Nothing is assembled at all for an abandoned session: the parts go out
      // of scope rather than becoming a clip somebody could later send.
      if (discarded.has(sessionId) || destroyed) return;
      let assembled: ({ size: number } & BodyInit) | null = null;
      try {
        assembled = deps.createClip(captured, options.uploadMediaType);
      } catch {
        options.dispatch({ type: "device_unavailable", sessionId });
        return;
      }
      clip = assembled;
      options.dispatch({
        type: "clip_ready",
        sessionId,
        byteLength: assembled.size,
      });
    };
    created.onerror = () => {
      // A recorder that has errored will never fire `onstop`, so without this
      // the machine waits for a clip that cannot arrive.
      if (discarded.has(sessionId) || destroyed) return;
      options.dispatch({ type: "device_unavailable", sessionId });
    };

    try {
      // No timeslice: one final blob rather than a stream of fragments. A
      // complete container is what carries the duration the server reads.
      created.start();
    } catch (error) {
      // `start()` can throw after the constructor succeeded. Classified by the
      // browser's own name: a recorder that cannot support this configuration
      // is a different sentence from a device that is busy or gone.
      const name = (error as Error | null)?.name;
      options.dispatch(
        name === "NotSupportedError"
          ? { type: "unsupported", sessionId }
          : { type: "device_unavailable", sessionId }
      );
      return;
    }

    startedAt = deps.now();
    options.onElapsed(0);
    clearTimer();
    timer = deps.setInterval(() => {
      if (!isCurrent(sessionId)) return;
      const elapsedMs = deps.now() - startedAt;
      options.onElapsed(elapsedMs);
      options.dispatch({ type: "tick", sessionId, elapsedMs });
    }, options.tickIntervalMs ?? 250);
  };

  const stopCapture = (sessionId: number) => {
    if (!isCurrent(sessionId)) return;
    clearTimer();
    const current = recorder;
    if (!current) {
      options.dispatch({ type: "device_unavailable", sessionId });
      return;
    }
    if (current.state === "inactive") {
      // Already finished — either `onstop` has run, or the recorder died. The
      // machine is waiting either way, so it is told rather than left waiting.
      options.dispatch({ type: "device_unavailable", sessionId });
      return;
    }
    try {
      current.stop();
    } catch {
      // `stop()` throwing means no `onstop` is coming.
      options.dispatch({ type: "device_unavailable", sessionId });
    }
  };

  const uploadClip = async (sessionId: number) => {
    const body = clip;
    clip = null;
    if (!body) {
      options.dispatch({
        type: "transcription_failed",
        sessionId,
        code: "VOICE_TRANSCRIPTION_FAILED",
      });
      return;
    }
    if (discarded.has(sessionId) || destroyed) return;

    const controller = new AbortController();
    abort = controller;
    try {
      const response = await options.deps.fetchImpl(options.endpoint, {
        method: "POST",
        // The container only. A recorder mime carries a codec parameter the
        // endpoint's allowlist does not key on.
        headers: { "Content-Type": options.uploadMediaType },
        body,
        signal: controller.signal,
        cache: "no-store",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { code?: string }
          | null;
        options.dispatch({
          type: "transcription_failed",
          sessionId,
          code: "VOICE_TRANSCRIPTION_FAILED",
          serverCode: payload?.code ?? null,
        });
        return;
      }

      const payload = (await response.json()) as { transcript?: unknown };
      if (typeof payload.transcript !== "string" || !payload.transcript) {
        options.dispatch({
          type: "transcription_failed",
          sessionId,
          code: "VOICE_TRANSCRIPTION_FAILED",
          serverCode: "VOICE_TRANSCRIPT_EMPTY",
        });
        return;
      }

      // Checked again here, immediately before the text is handed over. The
      // machine's session guard protects the *state*; this protects the
      // *draft*, and the two are not the same thing: a transcript for an
      // abandoned session must reach no conversation at all.
      if (discarded.has(sessionId) || destroyed) return;
      options.onTranscript(payload.transcript, sessionId);
      options.dispatch({ type: "transcription_succeeded", sessionId });
    } catch (error) {
      if ((error as Error | null)?.name === "AbortError") return;
      if (discarded.has(sessionId) || destroyed) return;
      options.dispatch({
        type: "transcription_failed",
        sessionId,
        code: "VOICE_NETWORK_ERROR",
      });
    } finally {
      if (abort === controller) abort = null;
    }
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (activeSessionId !== null) rememberDiscarded(activeSessionId);
    attempt(() => abort?.abort());
    abort = null;
    clip = null;
    clearTimer();
    detachRecorder();
    stopTracks();
    parts = [];
    activeSessionId = null;
  };

  return {
    requestMicrophone,
    startCapture,
    stopCapture,
    discardCapture,
    releaseMicrophone,
    uploadClip,
    destroy,
    inspect: () => ({
      hasStream: stream !== null,
      hasRecorder: recorder !== null,
      hasTimer: timer !== null,
      hasClip: clip !== null,
      activeSessionId,
      destroyed,
    }),
  };
};
