import "server-only";

import { isVoiceInputEnabled } from "@/lib/appSettings";
import {
  voiceModelPriceRefusal,
  type VoiceModelPriceRefusalCode,
} from "@/lib/voiceInputPricing";
import { resolveVoiceTranscriptionModel } from "@/lib/voiceTranscriptionPortCore";

export type VoiceModelPriceReadiness = {
  ready: boolean;
  flagEnabled: boolean;
  /** The model this deployment would call, as the port resolves it. */
  modelId: string;
  refusal: { code: VoiceModelPriceRefusalCode; detail: string } | null;
};

/**
 * Readiness contract for /api/ready: voice input refuses to be ready on a
 * model whose cost this deployment does not know.
 *
 * Contract: docs/policy/voice-input.md §6.1.4.
 *
 * ## Why this exists separately from the budget check
 *
 * §6.1.3 left the register saying "the default model is verified and the other
 * one is not". That distinction lived only in the document and in a CI check --
 * and CI cannot see `VOICE_TRANSCRIPTION_MODEL`, because it is a deployment's
 * environment variable. So nothing stopped a deployment from selecting the
 * unverified model, and "resolved for the default model" was not true of the
 * running system. This is where it becomes true.
 *
 * Same flag gate as the provider budget, for the same reason: a deployment
 * that has never switched voice input on sits in that state permanently, and
 * failing readiness there would break production over a feature nobody
 * enabled.
 *
 * The model is resolved through the port's own resolver rather than read from
 * the environment here. A check that reads the variable itself can drift from
 * the caller, and then it is verifying a model nobody calls.
 */
export const getVoiceModelPriceReadiness =
  async (): Promise<VoiceModelPriceReadiness> => {
    const modelId = resolveVoiceTranscriptionModel(process.env);
    const refusal = voiceModelPriceRefusal({ modelId });
    // A database failure keeps the flag reading false here; the database
    // readiness check reports that failure on its own.
    const flagEnabled = await isVoiceInputEnabled().catch(() => false);
    return {
      ready: !flagEnabled || refusal === null,
      flagEnabled,
      modelId,
      refusal,
    };
  };
