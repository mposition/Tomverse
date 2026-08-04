import "server-only";

import { isImageGenerationEnabled } from "@/lib/appSettings";
import {
  resolveActiveImageProviderBudgets,
  type ResolvedImageProviderBudgetByProvider,
} from "@/lib/imageProviderBudget";

export type ImageProviderBudgetReadiness = {
  ready: boolean;
  flagEnabled: boolean;
  /** One entry per provider with an enabled model (policy section 8). */
  providers: ResolvedImageProviderBudgetByProvider[];
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
    const providers = resolveActiveImageProviderBudgets(process.env, {
      production: process.env.NODE_ENV === "production",
    });
    // A database failure keeps the flag reading false here; the database
    // readiness check reports that failure on its own.
    const flagEnabled = await isImageGenerationEnabled().catch(() => false);
    return {
      ready:
        !flagEnabled ||
        providers.every((entry) => entry.resolved.limits !== null),
      flagEnabled,
      providers,
    };
  };
