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
 * ## Signed-in only, and the reason recorded rather than assumed
 *
 * docs/policy/voice-input.md §4. Guests may attach files, so "guests are
 * anonymous" is not on its own an argument against offering them a
 * microphone — and the protections that make guest attachments safe were
 * examined rather than waved at:
 *
 *   * a signed guest cookie identifies the subject (`access.subjectKey`),
 *   * Turnstile gates the upload,
 *   * per-minute, per-day and daily-byte budgets bound how much a guest can
 *     push into object storage.
 *
 * Every one of those bounds *storage*, and storage is a cost this product
 * already knows how to price. Transcription is not storage: it is a paid
 * per-second call to a third party, and this repository has no settled answer
 * for what an audio second costs a user (docs/policy/voice-input.md §6). A
 * guest has no credit account and no plan to draw that from, so admitting
 * guests would mean serving an unpriced provider call against a cookie.
 *
 * So the MVP is signed-in only, and this function is where that decision is
 * written down instead of being inferred from an `isGuestMode` check at a
 * render site. When §6 is settled, guests become a policy change here rather
 * than an edit spread across the composer and the route.
 *
 * ## Plan is deliberately not a gate
 *
 * Every signed-in plan may use it, including Free. Voice input replaces typing;
 * it does not buy a better answer, and gating it by tier would be pricing a
 * accessibility affordance. That is a product decision recorded in §4, not an
 * oversight — which is why `tier` is accepted and explicitly unused rather
 * than absent from the signature.
 */
export type VoiceInputRefusal =
  | "feature_unavailable"
  | "authentication_required";

export const voiceInputRefusal = (input: {
  available: boolean;
  isSignedIn: boolean;
  /** Accepted, and deliberately not consulted. See above. */
  tier?: ModelTier | null;
}): VoiceInputRefusal | null => {
  if (!input.available) return "feature_unavailable";
  if (!input.isSignedIn) return "authentication_required";
  return null;
};
