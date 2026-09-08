/**
 * The one table of what a voice clip may be.
 *
 * Contract: docs/policy/voice-input.md §5.
 *
 * The chat attachment system learned this the expensive way: its format list
 * had drifted into four copies — the picker's `accept`, the client's
 * extension-to-MIME normalisation, the upload allowlist and the processing
 * branch — and keeping them in step was manual work that nothing checked
 * (AGENTS.md, "채팅 첨부 형식과 압축파일"). Voice input starts with one table,
 * and the recorder's preference order, the server allowlist, the container
 * sniff and the provider hand-off are all derived from it.
 *
 * Pure and framework-free: the browser needs the preference order, the route
 * needs the allowlist, and a unit test needs both without a request.
 *
 * ## What decides membership
 *
 * A container is in this table only if **both** ends can handle it:
 *
 *   1. `MediaRecorder` in at least one supported browser produces it, and
 *   2. the transcription provider accepts it.
 *
 * The provider's accepted list is `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `wav`
 * and `webm` (OpenAI speech-to-text guide, read 2026-08-30). That is why
 * `audio/ogg` is absent even though Firefox will happily record it: a clip we
 * accept and then cannot transcribe is a refusal moved from the moment of
 * recording — where the user can do something about it — to the moment after
 * they have spoken. The recorder negotiates down to a container both ends
 * know, or reports that this browser cannot do voice input at all.
 */

export type VoiceClipFormat = {
  /** The canonical media type stored and sent to the provider. */
  readonly mediaType: string;
  /** The extension given to the part in the provider's multipart body. */
  readonly extension: string;
  /**
   * How the container declares its own length, which decides whether the
   * pre-provider duration check can be a refusal or only an observation
   * (docs/policy/voice-input.md §5.2, `lib/voiceClipDuration.ts`).
   */
  readonly durationSource: "ebml" | "mp4" | "riff" | "none";
};

export const VOICE_CLIP_FORMATS: readonly VoiceClipFormat[] = [
  // Chromium and Firefox. Verified against real `MediaRecorder` output: a
  // complete Blob carries Info > Duration and Info > TimecodeScale.
  { mediaType: "audio/webm", extension: "webm", durationSource: "ebml" },
  // Safari, and Chromium's second choice. Verified against real Chromium
  // `audio/mp4` output: fragmented, with a populated `mvhd`.
  { mediaType: "audio/mp4", extension: "mp4", durationSource: "mp4" },
  // Not produced by `MediaRecorder` anywhere today. Kept because the format is
  // exactly measurable from its header, which makes it the honest fixture for
  // the duration limit's own tests, and because a platform that starts
  // offering it needs no change here.
  { mediaType: "audio/wav", extension: "wav", durationSource: "riff" },
] as const;

export const voiceClipFormatFor = (
  mediaType: string | null | undefined
): VoiceClipFormat | null => {
  // A recorder reports `audio/webm;codecs=opus`; the table keys on the
  // container. Parameters are dropped rather than matched: which codec Opus
  // is inside a WebM is the provider's problem, not this allowlist's.
  const container = (mediaType ?? "").split(";", 1)[0].trim().toLowerCase();
  return (
    VOICE_CLIP_FORMATS.find((format) => format.mediaType === container) ?? null
  );
};

/**
 * What the browser should try, best first.
 *
 * Ordered by what the recorders actually produce well rather than by the table
 * above: Opus in WebM is the smallest thing Chromium and Firefox can make, and
 * MP4/AAC is what Safari can. `audio/wav` is not offered — `MediaRecorder` does
 * not produce it, and listing it would be a preference that never matches.
 */
export const VOICE_RECORDER_MIME_PREFERENCE: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
] as const;

/**
 * The `accept`-style list, for the one place a user-facing sentence needs to
 * name what can be recorded. Not used as a picker filter: there is no picker.
 */
export const VOICE_CLIP_MEDIA_TYPES: readonly string[] = VOICE_CLIP_FORMATS.map(
  (format) => format.mediaType
);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The hard upload ceiling, enforced by the endpoint against the bytes that
 * actually arrive and not only against `Content-Length`
 * (docs/policy/voice-input.md §5.1).
 *
 * 8 MB. Two minutes of Opus at the bitrate the recorder is pinned to is a few
 * hundred kilobytes, so this is roughly an order of magnitude of headroom for
 * a container that encodes worse than expected — and still a third of the
 * provider's own 25 MB limit, so a clip this endpoint accepts is never one the
 * provider will refuse for size.
 */
export const VOICE_CLIP_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Below this a clip cannot contain speech, only container headers.
 *
 * The real WebM produced by a 2.5-second recording is about 10 KB, and its
 * header alone is around 300 bytes. 2 KB refuses a recording that was started
 * and stopped in the same gesture — the common accident — without being
 * anywhere near a real utterance.
 *
 * This is a *refusal*, not a silent no-op: "nothing was recorded" is a
 * sentence the user can act on, and sending an empty container to a provider
 * to be told the same thing costs money to learn.
 */
export const VOICE_CLIP_MIN_BYTES = 2 * 1024;

/**
 * The per-clip recording ceiling in seconds.
 *
 * The browser stops the recorder at this point, and the server refuses a clip
 * that declares more (docs/policy/voice-input.md §5.2). Two minutes is a long
 * spoken question and a short monologue; the composer is for asking things,
 * and a limit that also has to bound an undecided provider bill belongs at the
 * short end until §6 is settled.
 */
export const VOICE_CLIP_MAX_SECONDS = 120;

/**
 * The slack allowed between what the browser meant to record and what the
 * container says it recorded.
 *
 * A recorder asked to stop at 120.000s writes a container that ends on the
 * last encoded frame, which can be a few tens of milliseconds either side.
 * Refusing at exactly the limit would fail an honest recording for arithmetic
 * nobody controls, so the *refusal* threshold is the limit plus this.
 */
export const VOICE_CLIP_DURATION_TOLERANCE_SECONDS = 1;

/** The refusal threshold the server actually compares against. */
export const VOICE_CLIP_REFUSAL_SECONDS =
  VOICE_CLIP_MAX_SECONDS + VOICE_CLIP_DURATION_TOLERANCE_SECONDS;

/**
 * The bitrate the recorder is pinned to.
 *
 * Fixed rather than left to the browser so the byte ceiling above means a
 * predictable number of seconds, and so a device that would otherwise record
 * at 128 kbps does not spend the budget four times faster than the phone next
 * to it. 32 kbps Opus is comfortably above what speech recognition needs.
 */
export const VOICE_RECORDER_BITS_PER_SECOND = 32_000;

/**
 * The longest transcript this endpoint will return.
 *
 * A ceiling on what goes into the composer, not on what the provider may say:
 * the transcript is inserted into a draft the user then edits, and the chat
 * request that eventually carries it has its own limits. Two minutes of fast
 * speech is well under this; a transcript longer than this means something has
 * gone wrong upstream, and truncating it silently would put words in the
 * user's draft that they never said and cannot see the end of.
 */
export const VOICE_TRANSCRIPT_MAX_CHARACTERS = 4_000;
