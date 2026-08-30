import "server-only";

import {
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  transcribeWithOpenAi,
  type VoiceTranscriptionPort,
  type VoiceTranscriptionRequest,
  type VoiceTranscriptionResult,
} from "@/lib/voiceTranscriptionPortCore";

/**
 * The one provider implementation, bound to this deployment's environment.
 *
 * Contract: docs/policy/voice-input.md §10.
 *
 * A thin binding, in the same shape as `lib/emailProviderPort.ts`: every
 * decision — what the wire call looks like, how a failure is classified, what
 * is allowed to come back — lives in `lib/voiceTranscriptionPortCore.ts`, and
 * this file supplies `process.env` and nothing else. The split is what keeps a
 * route handler from reaching for `fetch` and an API key directly, which is
 * how the STT call would end up coupled to the surface that happens to need it
 * first.
 *
 * ## The key
 *
 * `VOICE_TRANSCRIPTION_API_KEY`, falling back to `OPENAI_API_KEY`.
 *
 * Its own variable first, because "the account that answers chat" and "the
 * account that transcribes audio" are not the same decision: a deployment that
 * wants voice audio going to a separate account, a separate organisation or a
 * separate data-processing agreement can have that without touching chat
 * (docs/policy/voice-input.md §11.3). The fallback exists so that a staging
 * environment already holding a chat key does not need a second one to try the
 * feature — but production is expected to set the dedicated variable, and
 * whether it did is recorded rather than assumed.
 */
export class OpenAiVoiceTranscriptionProvider implements VoiceTranscriptionPort {
  async transcribe(
    request: VoiceTranscriptionRequest
  ): Promise<VoiceTranscriptionResult> {
    const apiKey =
      process.env.VOICE_TRANSCRIPTION_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // No status, because no request was made. Reported rather than thrown:
      // the caller decides how loudly to say so, and a missing key is an
      // operational fact rather than an exception the user caused.
      return {
        ok: false,
        code: "provider_not_configured",
        status: null,
        notConfigured: true,
      };
    }

    return transcribeWithOpenAi(request, {
      apiKey,
      model:
        process.env.VOICE_TRANSCRIPTION_MODEL ||
        DEFAULT_VOICE_TRANSCRIPTION_MODEL,
      fetchImpl: fetch,
    });
  }
}

const provider = new OpenAiVoiceTranscriptionProvider();

/** The provider every transcription goes through. One instance, no routing. */
export const voiceTranscriptionProvider = (): VoiceTranscriptionPort => provider;

/**
 * Whether this deployment has a dedicated key rather than borrowing chat's.
 *
 * Reported by the endpoint's structured log so an operator can see, without
 * reading the environment, which account the audio actually went to.
 */
export const voiceTranscriptionKeySource = ():
  | "dedicated"
  | "shared_openai"
  | "missing" => {
  if (process.env.VOICE_TRANSCRIPTION_API_KEY) return "dedicated";
  if (process.env.OPENAI_API_KEY) return "shared_openai";
  return "missing";
};
