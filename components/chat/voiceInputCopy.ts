import {
  VOICE_CLIP_MAX_SECONDS,
  VOICE_CLIP_MAX_BYTES,
} from "@/lib/voiceInputFormats";
import { voiceInputErrorCopyKey } from "@/lib/voiceInputErrorCopy";

/**
 * Every sentence the voice controls render, resolved once.
 *
 * Contract: docs/policy/voice-input.md §13.
 *
 * The same shape as `components/chat/deepResearchSuggestionCopy.ts`, and for
 * the reason that file exists: a component that calls `useLanguage()` itself
 * cannot be executed by a test — the unit lane cannot render React, and
 * `useContext` outside a render is not a thing. Resolving the copy here and
 * passing it in makes the controls plain functions of their arguments, which
 * is what lets `tests/client/voiceInputControl.test.tsx` assert what each
 * state actually renders.
 *
 * It also puts every user-facing string for this feature in one list, so
 * "which sentences does voice input own" is answerable by reading one type.
 */

export type VoiceInputCopy = {
  start: string;
  stop: string;
  cancel: string;
  /** Carries `{time}`; the control substitutes the elapsed clock. */
  recording: string;
  requestingPermission: string;
  transcribing: string;
  limitReached: string;
  dismissError: string;
  privacyNote: string;
  /** A refusal code in, the sentence that explains it out. */
  errorFor: (code: string | null | undefined) => string;
};

export const resolveVoiceInputCopy = (input: {
  t: (key: string) => string;
}): VoiceInputCopy => ({
  start: input.t("chat.voiceStart"),
  stop: input.t("chat.voiceStop"),
  cancel: input.t("chat.voiceCancel"),
  recording: input.t("chat.voiceRecording"),
  requestingPermission: input.t("chat.voiceRequestingPermission"),
  transcribing: input.t("chat.voiceTranscribing"),
  limitReached: input.t("chat.voiceLimitReached"),
  dismissError: input.t("chat.voiceDismissError"),
  privacyNote: input.t("chat.voicePrivacyNote"),
  // Resolved lazily rather than as a map of every code: the sentence depends
  // on which refusal actually happened, and building all fourteen on every
  // render to use one of them is work nobody asked for.
  errorFor: (code) => input.t(voiceInputErrorCopyKey(code)),
});

/**
 * The limits, for anywhere a sentence has to name one.
 *
 * Re-exported here rather than imported separately by the controls so the copy
 * layer and the enforcement layer cannot drift into quoting different numbers.
 */
export const VOICE_INPUT_LIMIT_SUMMARY = {
  maxSeconds: VOICE_CLIP_MAX_SECONDS,
  maxBytes: VOICE_CLIP_MAX_BYTES,
} as const;
