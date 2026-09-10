/**
 * Who may use voice input, and what turns it off.
 *
 * Contract: docs/policy/voice-input.md §2, §3, §9.
 *
 * Pure, framework-free and dependency-free, for the same reason
 * `lib/imageGenerationAccess.ts` is: the answers are needed by a `server-only`
 * settings module, by a route handler, by an RSC shell and by unit tests that
 * must reach them without a database or a request. A second copy of any of
 * these rules is how a rollout flag ends up meaning one thing in the composer
 * and another in the endpoint.
 */

import type { ModelTier } from "@/lib/models";

/**
 * The rollout flag's `AppSetting` key.
 *
 * Default-off opt-in, exactly like `feature.imageGenerationEnabled`: a missing
 * row, NULL, an empty string or any value other than the literal `"true"`
 * leaves voice input OFF. Forgetting to seed a flag must never open a feature
 * whose provider cost and credit price are still undecided
 * (docs/policy/voice-input.md §6).
 */
export const VOICE_INPUT_FLAG_KEY = "feature.voiceInputEnabled";

/** See above: only the literal `"true"` enables. */
export const voiceInputEnabledFromValue = (
  value: string | null | undefined
): boolean => value === "true";

/**
 * The environment variable that forces voice input off regardless of the
 * stored flag.
 *
 * Two switches and not one, because they answer different questions at
 * different speeds (docs/policy/voice-input.md §9):
 *
 *   * The `AppSetting` row is the *rollout* state. Changing it is a deliberate
 *     database write made as part of the activation procedure, and reading it
 *     needs a healthy database.
 *   * This variable is the *kill switch*. It is read from the process
 *     environment with no database round trip, so it still works when the
 *     database is the thing that is unwell, and it takes effect on the next
 *     deployment of an environment variable rather than on a code change.
 *
 * The kill switch always wins. There is no value of the stored flag that can
 * re-enable the feature while this is set, which is the property that makes it
 * usable during an incident: an operator flipping it does not have to also
 * find out who else could turn the feature back on.
 */
export const VOICE_INPUT_KILL_SWITCH_ENV = "VOICE_INPUT_KILL_SWITCH";

/**
 * Whether the kill switch is engaged.
 *
 * Deliberately permissive about *how* it is engaged and strict about how it is
 * released: `1`, `true`, `on` and `yes` (any case, surrounded by any
 * whitespace) all mean "off", and so does any other non-empty value. Only an
 * absent or empty variable leaves the feature reachable.
 *
 * That asymmetry is the point. An operator typing `VOICE_INPUT_KILL_SWITCH=y`
 * at three in the morning has said what they meant; a switch that answered
 * "that is not one of my four accepted spellings, carry on serving" would be a
 * switch that failed in the direction nobody wants.
 */
export const voiceInputKillSwitchEngaged = (
  env: Record<string, string | undefined>
): boolean => Boolean((env[VOICE_INPUT_KILL_SWITCH_ENV] ?? "").trim());

/**
 * The two inputs folded into the one answer every surface uses.
 *
 * Every caller — the RSC shell that decides whether to render a microphone at
 * all, and the endpoint that decides whether to accept a clip — goes through
 * this, so the button and the route can never disagree about whether the
 * feature exists.
 */
export const voiceInputAvailable = (input: {
  storedFlagValue: string | null | undefined;
  env: Record<string, string | undefined>;
}): boolean =>
  !voiceInputKillSwitchEngaged(input.env) &&
  voiceInputEnabledFromValue(input.storedFlagValue);

/**
 * Why a caller may not use voice input, or `null` when they may.
 *
 * ## Guests are admitted (2026-09-10), and the earlier reasoning is kept
 *
 * docs/policy/voice-input.md §4. The MVP was signed-in only, and the argument
 * for it was not "guests are anonymous". Guests may already attach files, and
 * the protections that make that safe were examined: a signed guest cookie
 * identifies the subject (`access.subjectKey`), Turnstile gates the upload,
 * and per-minute, per-day and daily-byte budgets bound how much a guest can
 * push into object storage.
 *
 * The objection was that every one of those bounds *storage*, which this
 * product knows how to price, while transcription is a paid per-second call to
 * a third party. A guest has no credit account to attribute that to, so
 * admitting guests meant serving a provider call against a cookie.
 *
 * **The product owner decided on 2026-09-10 to admit guests on the same limits
 * as a signed-in caller.** What makes the exposure finite is not the subject
 * budget — a cookie can be cleared, and a new one is a new subject — but the
 * provider-wide budget beneath it: `reserveVoiceBudgets` reserves against
 * `VOICE_PROVIDER_SECONDS_PER_DAY`/`_PER_MONTH` as well, so the day's total
 * seconds are capped however many subjects appear.
 *
 * **What that leaves is a denial-of-budget risk rather than an unbounded
 * bill**, and it is written here because it is the part the change does not
 * solve: a script cycling cookies can spend the day's provider budget and
 * leave real callers refused. Turnstile is the protection that would answer
 * it, and guest voice does not have it yet (§4).
 *
 * ## Neither plan nor sign-in is a gate
 *
 * `tier` and `isSignedIn` are both accepted and deliberately not consulted.
 * Voice input replaces typing; it does not buy a better answer. Keeping the
 * fields in the signature is how each decision stays visible at the place it
 * is made, rather than becoming an absence nobody can date.
 */
export type VoiceInputRefusal =
  | "feature_unavailable"
  | "authentication_required";

export const voiceInputRefusal = (input: {
  available: boolean;
  /**
   * Accepted, and deliberately not consulted since 2026-09-10. See above.
   *
   * `authentication_required` stays in `VoiceInputRefusal` because the route
   * still answers it when the feature is reached without any resolvable
   * subject at all -- a different condition from "this caller is a guest".
   */
  isSignedIn?: boolean;
  /** Accepted, and deliberately not consulted. See above. */
  tier?: ModelTier | null;
}): VoiceInputRefusal | null => {
  if (!input.available) return "feature_unavailable";
  return null;
};
