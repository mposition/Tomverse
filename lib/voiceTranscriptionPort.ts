import "server-only";

import { resolveProviderApiKey } from "@/lib/modelRegistryShared";
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
 * `VOICE_TRANSCRIPTION_API_KEY`, falling back to the shared OpenAI key.
 *
 * The same shape as `OPENAI_IMAGE_API_KEY` in `lib/imageProviderAdapter.ts`,
 * and for the same reason: "the account that answers chat" and "the account
 * that transcribes audio" are not the same decision, so a deployment that
 * wants voice audio going to a separate account, organisation or
 * data-processing agreement can have that without touching chat
 * (docs/policy/voice-input.md §11.3). The fallback exists so a staging
 * environment already holding a chat key does not need a second one to try the
 * feature.
 *
 * The fallback goes through `resolveProviderApiKey` rather than naming
 * `OPENAI_API_KEY` here. A second inline list of provider key names is exactly
 * how three modules came to disagree about Google's, and
 * `tests/providerApiKeyNames.test.mjs` refuses one.
 */
export class OpenAiVoiceTranscriptionProvider implements VoiceTranscriptionPort {
  async transcribe(
    request: VoiceTranscriptionRequest
  ): Promise<VoiceTranscriptionResult> {
    const apiKey =
      process.env.VOICE_TRANSCRIPTION_API_KEY?.trim() ||
      resolveProviderApiKey("openai");
    if (!apiKey) {
      // No status, because no request was made. Reported rather than thrown:
      // the caller decides how loudly to say so, and a missing key is an
      // operational fact rather than an exception the user caused.
      return {
        ok: false,
        code: "provider_not_configured",
        status: null,
        disposition: "not_sent",
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
  if (process.env.VOICE_TRANSCRIPTION_API_KEY?.trim()) return "dedicated";
  if (resolveProviderApiKey("openai")) return "shared_openai";
  return "missing";
};
