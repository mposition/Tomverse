/**
 * Whether Auto may spread a turn across a credit-equal tie.
 *
 * Default-off, the same shape as `feature.chatStarterEnabled`: a missing row,
 * NULL, an empty string or any value other than the literal `"true"` leaves
 * exploration off. Forgetting to seed the flag must not change which model
 * answers.
 *
 * The kill switch is read from the process environment and wins over the
 * stored flag, so an operator can stop the spread without a database write.
 * Turning it off takes effect on the next request. Nothing here rewrites a
 * conversation's stored mode or a past routing row.
 */

export const AUTO_EXPLORATION_FLAG_KEY = "feature.autoExplorationEnabled";

export const AUTO_EXPLORATION_KILL_SWITCH_ENV = "AUTO_EXPLORATION_KILL_SWITCH";

/** Only the literal `"true"` enables. */
export const autoExplorationEnabledFromValue = (
  value: string | null | undefined
): boolean => value === "true";

/**
 * Any non-empty value engages the switch. Only an absent or whitespace-only
 * variable leaves exploration reachable.
 */
export const autoExplorationKillSwitchEngaged = (
  env: Record<string, string | undefined>
): boolean => Boolean((env[AUTO_EXPLORATION_KILL_SWITCH_ENV] ?? "").trim());

export const autoExplorationAvailable = (input: {
  storedFlagValue: string | null | undefined;
  env: Record<string, string | undefined>;
}): boolean =>
  !autoExplorationKillSwitchEngaged(input.env) &&
  autoExplorationEnabledFromValue(input.storedFlagValue);
