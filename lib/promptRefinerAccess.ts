/**
 * Prompt Refiner rollout and emergency-stop semantics.
 *
 * Kept framework-free so the RSC shell, future admission endpoint and unit
 * tests share one answer. A missing or misspelled rollout value fails closed;
 * any non-empty kill-switch value wins over it.
 */

export const PROMPT_REFINER_FLAG_KEY = "feature.promptRefinerEnabled";
export const PROMPT_REFINER_KILL_SWITCH_ENV = "PROMPT_REFINER_KILL_SWITCH";
// Adapter presence is insufficient: readiness is granted only by the exact
// deployment release readback. The no-argument form stays closed so an old
// shell cannot turn product execution on merely because code was deployed.
export const promptRefinerProductAdapterReady = (release?: {
  explicitEnabled: boolean;
  autoEnabled: boolean;
}): boolean => release !== undefined &&
  (release.explicitEnabled || release.autoEnabled);

export const promptRefinerProductReleaseReady = (release: {
  explicitEnabled: boolean;
  autoEnabled: boolean;
}): boolean => release.explicitEnabled || release.autoEnabled;

export const promptRefinerEnabledFromValue = (
  value: string | null | undefined
): boolean => value === "true";

export const promptRefinerKillSwitchEngaged = (
  env: Record<string, string | undefined>
): boolean =>
  Boolean((env[PROMPT_REFINER_KILL_SWITCH_ENV] ?? "").trim());

export const promptRefinerAvailable = (input: {
  storedFlagValue: string | null | undefined;
  env: Record<string, string | undefined>;
}): boolean =>
  !promptRefinerKillSwitchEngaged(input.env) &&
  promptRefinerEnabledFromValue(input.storedFlagValue);

/**
 * Reads rollout state only after the two read-free refusal gates have passed.
 * The injected reader keeps the ordering executable in unit tests without a
 * database and is used by the server-only AppSetting boundary in production.
 */
export const readPromptRefinerAvailability = async (input: {
  env: Record<string, string | undefined>;
  databaseEnabled: boolean;
  readStoredFlag: () => Promise<string | null | undefined>;
}): Promise<boolean> => {
  if (promptRefinerKillSwitchEngaged(input.env)) return false;
  if (!input.databaseEnabled) return false;
  return promptRefinerEnabledFromValue(await input.readStoredFlag());
};

/**
 * The server's final UI decision. Rollout permission alone is insufficient:
 * an adapter that can fulfil the request must also exist in this deployment.
 */
export const promptRefinerOfferDecision = (input: {
  available: boolean;
  adapterReady: boolean;
}): boolean => input.available && input.adapterReady;
