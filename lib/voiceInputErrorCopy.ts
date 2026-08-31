/**
 * Refusal code -> the copy key that explains it.
 *
 * Contract: docs/policy/voice-input.md §13.
 *
 * The same shape as `lib/chatAttachmentErrorCopy.ts`, and for the reason that
 * file records: a flow whose every failure produces one sentence — "something
 * went wrong, try again" — gives wrong advice to most of the people who see
 * it. A denied microphone permission, a browser that cannot record, a clip
 * with nothing in it, a daily limit and a provider outage have five different
 * fixes, and only one of them is "try again".
 *
 * Pure: a code in, a translation key out. The client resolves the key, so
 * every locale gets the same coverage, and adding a refusal without adding its
 * sentence is a missing key rather than a silent fallback.
 */

/** Keys under the `chat.` namespace in `locales/*.ts`. */
export const VOICE_INPUT_ERROR_COPY_KEYS: Readonly<Record<string, string>> = {
  // -- Before anything is recorded ------------------------------------------
  VOICE_UNSUPPORTED_BROWSER: "chat.voiceErrorUnsupportedBrowser",
  VOICE_PERMISSION_DENIED: "chat.voiceErrorPermissionDenied",
  VOICE_DEVICE_UNAVAILABLE: "chat.voiceErrorDeviceUnavailable",

  // -- The clip itself -------------------------------------------------------
  VOICE_CLIP_EMPTY: "chat.voiceErrorClipEmpty",
  VOICE_CLIP_TOO_LARGE: "chat.voiceErrorClipTooLarge",
  VOICE_CLIP_TOO_LONG: "chat.voiceErrorClipTooLong",
  VOICE_CLIP_UNREADABLE: "chat.voiceErrorClipUnreadable",
  VOICE_CLIP_TYPE_MISMATCH: "chat.voiceErrorClipUnreadable",
  VOICE_CLIP_UNSUPPORTED_TYPE: "chat.voiceErrorClipUnreadable",

  // -- Nothing was said ------------------------------------------------------
  // Its own sentence rather than a generic failure: the request worked, the
  // provider worked, and the answer is that the recording had no speech in it.
  // "Try again" is right here and wrong almost everywhere else on this list.
  VOICE_TRANSCRIPT_EMPTY: "chat.voiceErrorTranscriptEmpty",

  // -- The recording could not follow the user ------------------------------
  // Not a fault. The user opened another conversation, or signed out, while a
  // recording was running; it ended rather than putting its words somewhere
  // they were not spoken (docs/policy/voice-input.md §8.4).
  VOICE_SCOPE_CHANGED: "chat.voiceErrorScopeChanged",

  // -- Access ----------------------------------------------------------------
  VOICE_INPUT_DISABLED: "chat.voiceErrorUnavailable",
  VOICE_AUTHENTICATION_REQUIRED: "chat.voiceErrorSignInRequired",

  // -- Operational -----------------------------------------------------------
  VOICE_OPERATIONAL_LIMIT_REACHED: "chat.voiceErrorLimitReached",
  API_RATE_LIMITED: "chat.voiceErrorLimitReached",
  VOICE_PROVIDER_UNAVAILABLE: "chat.voiceErrorProviderUnavailable",
  VOICE_NETWORK_ERROR: "chat.voiceErrorNetwork",
  VOICE_TRANSCRIPTION_FAILED: "chat.voiceErrorTranscriptionFailed",
};

/**
 * The fallback when a code arrives that this map does not know.
 *
 * A code the client has never heard of is still a refusal the user is
 * entitled to a sentence about, and this is the one place "please try again"
 * is the honest thing to say.
 */
export const VOICE_INPUT_ERROR_FALLBACK_KEY = "chat.voiceErrorTranscriptionFailed";

export const voiceInputErrorCopyKey = (code: string | null | undefined): string =>
  (code && VOICE_INPUT_ERROR_COPY_KEYS[code]) || VOICE_INPUT_ERROR_FALLBACK_KEY;
