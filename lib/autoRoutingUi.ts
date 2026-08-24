/**
 * Whether this account is shown the Auto option at all, and what it is told.
 *
 * Deliberately last in the rollout (`docs/ops/tomverse-chat-auto-router-rollout.md`),
 * and behind a flag that is off, because a control is a promise: putting Auto
 * in the picker says the product routes this conversation, and until the
 * cohort is real that sentence is not true.
 *
 * ## Offered means it would actually do something
 *
 * The flag alone is not enough. `lib/autoCohort.ts` decides per account
 * whether Auto routes anything, so a picker that offered Auto to somebody
 * outside the cohort would give them a switch that flips, saves, renders as
 * on -- and changes nothing, because every turn would still be answered by
 * their own model. A control that appears to work and does not is worse than
 * an absent one: the user cannot tell the difference between "Auto chose this
 * model" and "Auto is not running", and neither can support.
 *
 * So the option is offered only when the flag is on **and** the account is
 * cohort-eligible, and the two conditions are collapsed into one boolean
 * before the client ever sees them.
 *
 * ## Why the client is not told why
 *
 * `offered: false` carries no reason across the wire. The refusals are
 * internal rollout state -- which bucket the account landed in, what share is
 * enabled, which readiness gate is outstanding -- and none of it is the user's
 * business or safe to publish: a client that could read its bucket could tell
 * you the rollout percentage, and one that knew the salt could work out
 * anyone's. The operator-facing reason stays on the server, where
 * `describeAutoCohortRefusal` already writes it out for a log.
 */

import {
  decideAutoCohort,
  type AutoCohortConfig,
  type AutoCohortDecision,
} from "@/lib/autoCohort";
import { autoProductBoundary } from "@/lib/autoProductBoundary";
import type { ProductKeyReadMode } from "@/lib/productKeyReadMode";
import type { ModelTier } from "@/lib/models";
import type { autoRolloutReadiness } from "@/lib/autoRolloutReadiness";

/** Off by default. A flag that has to be turned on is the whole point. */
export const AUTO_ROUTER_UI_FLAG = "TOMVERSE_AUTO_ROUTER_UI_ENABLED";

export const isAutoRouterUiEnabled = (
  environment: Record<string, string | undefined> = process.env
) => environment[AUTO_ROUTER_UI_FLAG] === "true";

/**
 * `product_not_chat` sits alongside the two rollout refusals rather than
 * inside the cohort's, because it is answered before the cohort is consulted
 * (decision record v1.2 §3). A Review conversation is not outside the cohort;
 * it was never a subject of the question, and counting it as a cohort refusal
 * would dilute the rollout percentage with Review traffic.
 */
export type AutoUiRefusal = "ui_flag_off" | "product_not_chat" | "not_eligible";

/** The server's own view: a boolean, plus why, for the log. */
export type AutoUiAvailability = {
  offered: boolean;
  reason: AutoUiRefusal | null;
  /** Present when the cohort was consulted at all. */
  cohort: AutoCohortDecision | null;
};

export type AutoUiAvailabilityInput = {
  subjectKey: string;
  isGuest: boolean;
  plan: ModelTier | "Guest" | null;
  /**
   * The conversation's stored productKey, or null when there is no
   * conversation yet.
   *
   * Read from the row under an ownership check -- never from a request body,
   * a Referer, or the surface the client was on. Null is not a product
   * refusal: a screen with no conversation has no product to refuse, and
   * falling back to a surface is what §6 forbids.
   */
  productKey?: string | null;
  /**
   * Whether a conversation row exists at all. False for the surface-entry
   * question ("may this account start a Chat"), where there is nothing to
   * read a product from and nothing to resolve.
   */
  hasConversation?: boolean;
  readMode?: ProductKeyReadMode;
  flagEnabled?: boolean;
  cohortConfig?: AutoCohortConfig;
  readiness?: ReturnType<typeof autoRolloutReadiness>;
};

export const autoUiAvailability = (
  input: AutoUiAvailabilityInput
): AutoUiAvailability => {
  const flagEnabled = input.flagEnabled ?? isAutoRouterUiEnabled();
  // The cohort is not consulted when the flag is off. Nothing turns on it, and
  // hashing a subject to answer a question already answered is work the
  // request does not need to do.
  if (!flagEnabled) {
    return { offered: false, reason: "ui_flag_off", cohort: null };
  }

  // The product, before the cohort. `cohort: null` is the point as much as
  // the reason is: the cohort was not consulted, so there is no bucket to
  // report, and the rollout figures stay a statement about Chat.
  const product = autoProductBoundary({
    productKey: input.productKey ?? null,
    hasConversation: input.hasConversation ?? false,
    readMode: input.readMode,
  });
  if (product.reason === "product_not_chat") {
    return { offered: false, reason: "product_not_chat", cohort: null };
  }

  const cohort = decideAutoCohort({
    subjectKey: input.subjectKey,
    isGuest: input.isGuest,
    plan: input.plan,
    config: input.cohortConfig,
    readiness: input.readiness,
  });
  return cohort.eligible
    ? { offered: true, reason: null, cohort }
    : { offered: false, reason: "not_eligible", cohort };
};

/**
 * What crosses the wire.
 *
 * One boolean, and nothing else. Kept as a named type rather than an inline
 * `{ offered }` so that adding a field later is a decision somebody makes
 * here, with this file's reasoning in front of them, rather than a property
 * that gets spread into a response because it happened to be in scope.
 */
export type AutoSelectionCapability = { offered: boolean };

export const autoSelectionCapability = (
  availability: AutoUiAvailability
): AutoSelectionCapability => ({ offered: availability.offered });

/**
 * Whether a requested mode may be stored.
 *
 * `manual` is always allowed, including for an account that was never offered
 * Auto. Two reasons, and the second is the one that matters: an account can
 * leave the cohort -- the percentage drops, the plan changes, a gate expires
 * -- while its conversations are still marked `auto`, and refusing to let
 * those go back to manual would strand them in a mode the account can no
 * longer act on. Returning to manual is also what clears sticky state, so
 * blocking it would leave rows the constraint expects nothing to hold.
 */
export const mayStoreSelectionMode = (
  mode: "manual" | "auto",
  availability: AutoUiAvailability
): boolean => mode === "manual" || availability.offered;
