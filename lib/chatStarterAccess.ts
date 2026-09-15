/**
 * Whether the Chat starter catalogue is offered at all, and what turns it off.
 *
 * Contract: docs/ui-contracts/chat-starter-catalog.md section 5.
 *
 * Pure, framework-free and dependency-free, for the same reason
 * `lib/voiceInputAccess.ts` and `lib/imageGenerationAccess.ts` are: the answer
 * is needed by a `server-only` settings module, by an RSC shell and by unit
 * tests that must reach it without a database or a request. A second copy of
 * the rule is how a rollout flag ends up meaning one thing in the welcome
 * screen and another in the admin toggle.
 *
 * This module answers one question only -- does the gallery exist. Which cards
 * it holds is `lib/chatStarterCatalog.ts`, and which of those a given viewer
 * may act on is `lib/chatStarterAvailability.ts`. Keeping the three apart is
 * what lets the availability rules be tested without a flag and the flag be
 * flipped without touching the table.
 */

/**
 * The rollout flag's `AppSetting` key.
 *
 * Default-off opt-in, exactly like `feature.imageGenerationEnabled` and
 * `feature.voiceInputEnabled`: a missing row, NULL, an empty string or any
 * value other than the literal `"true"` leaves the starter catalogue OFF.
 *
 * The fail-closed direction matters more here than the word "beta" suggests.
 * This surface is the first thing a new account sees, and every card on it is
 * a promise about what the product does. Forgetting to seed a flag must not
 * put promises in front of somebody before anyone decided to make them.
 */
export const CHAT_STARTER_FLAG_KEY = "feature.chatStarterEnabled";

/** See above: only the literal `"true"` enables. */
export const chatStarterEnabledFromValue = (
  value: string | null | undefined
): boolean => value === "true";

/**
 * The environment variable that forces the starter catalogue off regardless of
 * the stored flag.
 *
 * Two switches and not one, for the reason `VOICE_INPUT_KILL_SWITCH_ENV`
 * records: the `AppSetting` row is the rollout state and needs a healthy
 * database to read, while this is read from the process environment with no
 * round trip, so it still works when the database is the thing that is unwell.
 *
 * The kill switch always wins. There is no value of the stored flag that can
 * re-enable the gallery while this is set.
 */
export const CHAT_STARTER_KILL_SWITCH_ENV = "CHAT_STARTER_KILL_SWITCH";

/**
 * Whether the kill switch is engaged.
 *
 * Permissive about how it is engaged and strict about how it is released, the
 * same asymmetry `voiceInputKillSwitchEngaged` documents: any non-empty value
 * means off, and only an absent or whitespace-only variable leaves the gallery
 * reachable.
 */
export const chatStarterKillSwitchEngaged = (
  env: Record<string, string | undefined>
): boolean => Boolean((env[CHAT_STARTER_KILL_SWITCH_ENV] ?? "").trim());

/**
 * The two inputs folded into the one answer every surface uses.
 *
 * `offered=false` renders nothing -- not a disabled teaser, not a greyed row.
 * The rule is `docs/ui-contracts/prompt-refiner-suggestion.md` section 1,
 * applied here for the same reason: a surface that promises a feature to
 * somebody who cannot reach it is worse than no surface at all.
 */
export const chatStarterAvailable = (input: {
  storedFlagValue: string | null | undefined;
  env: Record<string, string | undefined>;
}): boolean =>
  !chatStarterKillSwitchEngaged(input.env) &&
  chatStarterEnabledFromValue(input.storedFlagValue);
