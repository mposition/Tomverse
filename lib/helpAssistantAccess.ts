/**
 * Whether the Help Centre's question box answers with a model call.
 *
 * Default-off opt-in like `feature.chatStarterEnabled`: only the literal
 * "true" turns it on. Each answer is a paid call (the Auto router's model,
 * held under the provider's operational budget), approved by the owner on
 * 2026-11-18 with no per-reader daily question limit. The kill switch is read
 * from the environment so it still works when the database does not.
 */
export const HELP_ASSISTANT_FLAG_KEY = "feature.helpAssistantEnabled";
export const HELP_ASSISTANT_KILL_SWITCH_ENV = "HELP_ASSISTANT_KILL_SWITCH";

export const helpAssistantEnabledFromValue = (value: string | null | undefined): boolean => value === "true";

export const helpAssistantKillSwitchEngaged = (env: Record<string, string | undefined>): boolean =>
  Boolean((env[HELP_ASSISTANT_KILL_SWITCH_ENV] ?? "").trim());

export const helpAssistantAvailable = (input: {
  storedFlagValue: string | null | undefined;
  env: Record<string, string | undefined>;
}): boolean => !helpAssistantKillSwitchEngaged(input.env) && helpAssistantEnabledFromValue(input.storedFlagValue);
