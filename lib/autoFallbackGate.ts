/**
 * Which turns an automatic fallback may be attempted on at all.
 *
 * §9.1's fourth open item: "'Text-only turns' is still too wide for a first
 * cut." This is that narrowing, written down where it can be tested rather
 * than spread across the conditions of an `if` in a 3,000-line handler.
 *
 * Every refusal is named. "No fallback happened" and "a fallback was out of
 * scope for this reason" are different facts, and only the second one can be
 * counted -- a rollout that cannot say why it never fires is a rollout nobody
 * can tell is working.
 *
 * ## Why each exclusion, and not merely "text only"
 *
 * A tool call, a web search or a deep research job is not a stream of text
 * that another model could simply continue. Each has state the first attempt
 * already began -- a search executed and surcharged, a job submitted and
 * polled, a tool result the conversation now refers to -- and §5 requires the
 * fallback candidate to build its own context and manifest, which cannot
 * include what the first attempt was in the middle of doing. Attachments are
 * excluded for the narrower reason that a candidate's ability to read them is
 * a per-model capability the first cut does not re-check.
 *
 * Guests are excluded structurally, the same way `lib/autoCohort.ts` excludes
 * them: Auto never routes a guest turn, so a guest turn has no routed primary
 * to fall back from.
 */

export const AUTO_FALLBACK_FLAG = "AUTO_ROUTER_FALLBACK_ENABLED";

/**
 * Default off, and off is what a deployment gets by doing nothing.
 *
 * §9.1's order puts staging fault injection *after* the swap is wired and
 * before it is enabled, so the shipped value has to be the one that runs no
 * second provider call.
 */
export const autoFallbackFlagEnabled = (
  environment: Record<string, string | undefined> = process.env
): boolean => environment[AUTO_FALLBACK_FLAG] === "on";

export type FallbackScopeRefusal =
  /** `AUTO_ROUTER_FALLBACK_ENABLED` is not `on`. */
  | "flag_off"
  /** The Router did not choose this turn's model, so §7 does not apply. */
  | "not_routed"
  /** Guests are outside the cohort, so no guest turn is ever routed. */
  | "guest"
  /** A tool was offered; its results are state a second attempt cannot inherit. */
  | "tools_offered"
  /**
   * A web search ran: executed, surcharged, and not repeatable for free.
   *
   * Both routes. An application-managed search has spent backend requests
   * against this turn's counted allowance and taken the eight-credit surcharge
   * exactly as a native one has, so a second attempt would either re-spend both
   * or answer without the search the user paid for. Neither is a fallback.
   */
  | "web_search"
  /** A deep research job is submitted and polled, not streamed. */
  | "deep_research"
  /** Reading an attachment is a per-model capability the first cut does not re-check. */
  | "attachments"
  /** Nothing else survived the Router's filters, so there is nobody to fall back to. */
  | "no_candidate";

export type FallbackScope =
  | { allowed: true }
  | { allowed: false; reason: FallbackScopeRefusal };

export type FallbackScopeInput = {
  routed: boolean;
  isGuest: boolean;
  toolsOffered: boolean;
  nativeSearchEnabled: boolean;
  /**
   * Whether this turn registered this application's own `web_search` tool.
   *
   * Its own field rather than folded into `nativeSearchEnabled`, because the
   * two are read apart everywhere else and a caller setting the wrong one would
   * be making a claim about which provider ran the search. Both produce the
   * same refusal here, which is the point: the reason a searching turn cannot
   * fall back is about the search having happened, not about who ran it.
   */
  appManagedSearchEnabled?: boolean;
  deepResearch: boolean;
  hasAttachments: boolean;
  candidateCount: number;
  environment?: Record<string, string | undefined>;
};

/**
 * Whether this turn is in scope, and if not, why.
 *
 * The flag is checked first so that a deployment with it off produces exactly
 * one reason for every turn, rather than a distribution of reasons describing
 * a feature that is not on. Everything after it is the turn's own shape.
 */
export const autoFallbackScope = (input: FallbackScopeInput): FallbackScope => {
  if (!autoFallbackFlagEnabled(input.environment)) {
    return { allowed: false, reason: "flag_off" };
  }
  if (!input.routed) return { allowed: false, reason: "not_routed" };
  if (input.isGuest) return { allowed: false, reason: "guest" };
  if (input.deepResearch) return { allowed: false, reason: "deep_research" };
  if (input.nativeSearchEnabled || input.appManagedSearchEnabled === true) {
    return { allowed: false, reason: "web_search" };
  }
  if (input.toolsOffered) return { allowed: false, reason: "tools_offered" };
  if (input.hasAttachments) return { allowed: false, reason: "attachments" };
  if (input.candidateCount <= 0) return { allowed: false, reason: "no_candidate" };
  return { allowed: true };
};
