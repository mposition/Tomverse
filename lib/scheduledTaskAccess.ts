/**
 * Whether scheduled tasks exist at all.
 *
 * Default-off opt-in like `feature.helpAssistantEnabled`: only the literal
 * "true" turns it on. Turning it on lets the server spend an account's own
 * credits while nobody is looking, one ordinary Chat turn per occurrence, so
 * it is an owner decision (real money leaving) made with the Admin switch.
 * The kill switch is read from the environment so it still stops new runs when
 * the database is the thing that is unwell.
 */
export const SCHEDULED_TASKS_FLAG_KEY = "feature.scheduledTasksEnabled";
export const SCHEDULED_TASKS_KILL_SWITCH_ENV = "SCHEDULED_TASKS_KILL_SWITCH";

export const scheduledTasksEnabledFromValue = (value: string | null | undefined): boolean => value === "true";

export const scheduledTasksKillSwitchEngaged = (env: Record<string, string | undefined>): boolean =>
  Boolean((env[SCHEDULED_TASKS_KILL_SWITCH_ENV] ?? "").trim());

export const scheduledTasksAvailable = (input: {
  storedFlagValue: string | null | undefined;
  env: Record<string, string | undefined>;
}): boolean => !scheduledTasksKillSwitchEngaged(input.env) && scheduledTasksEnabledFromValue(input.storedFlagValue);
