import "server-only";

import { isImageGenerationEnabled } from "@/lib/appSettings";
import {
  resolveImageProviderBudget,
  type ResolvedImageProviderBudget,
} from "@/lib/imageProviderBudget";

export type ImageProviderBudgetReadiness = {
  ready: boolean;
  flagEnabled: boolean;
  resolved: ResolvedImageProviderBudget;
};

/**
 * Readiness contract for /api/ready: an unusable image budget only refuses
 * readiness while the feature flag is ON. The env-first deploy order means
 * "flag off, budget absent" is the legal intermediate state every deploy
 * passes through -- failing readiness there would brick a production that
 * has never enabled the feature. The moment the flag turns on, a missing or
 * partial budget is a fatal misconfiguration (policy section 8).
 */
export const getImageProviderBudgetReadiness =
  async (): Promise<ImageProviderBudgetReadiness> => {
    const resolved = resolveImageProviderBudget(process.env, {
      production: process.env.NODE_ENV === "production",
    });
    // A database failure keeps the flag reading false here; the database
    // readiness check reports that failure on its own.
    const flagEnabled = await isImageGenerationEnabled().catch(() => false);
    return {
      ready: !flagEnabled || resolved.limits !== null,
      flagEnabled,
      resolved,
    };
  };
