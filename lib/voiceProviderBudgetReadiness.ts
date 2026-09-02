import "server-only";

import { isVoiceInputEnabled } from "@/lib/appSettings";
import {
  resolveVoiceProviderBudget,
  type ResolvedVoiceProviderBudget,
} from "@/lib/voiceProviderBudget";

export type VoiceProviderBudgetReadiness = {
  ready: boolean;
  flagEnabled: boolean;
  budget: ResolvedVoiceProviderBudget;
};

/**
 * Readiness contract for /api/ready: an unusable audio budget refuses
 * readiness only while the voice flag is ON.
 *
 * Contract: docs/policy/voice-input.md §6.1-4.
 *
 * The same env-first deploy order the image budget follows applies here --
 * "flag off, budget absent" is the legal state every deployment that has
 * never enabled voice input sits in permanently, and failing readiness there
 * would brick production for a feature nobody turned on. The moment the flag
 * is on, a missing budget is a misconfiguration standing between this product
 * and an unbounded third-party bill.
 */
export const getVoiceProviderBudgetReadiness =
  async (): Promise<VoiceProviderBudgetReadiness> => {
    const budget = resolveVoiceProviderBudget(process.env, {
      production: process.env.NODE_ENV === "production",
    });
    // A database failure keeps the flag reading false here; the database
    // readiness check reports that failure on its own.
    const flagEnabled = await isVoiceInputEnabled().catch(() => false);
    return {
      ready: !flagEnabled || budget.limits !== null,
      flagEnabled,
      budget,
    };
  };
