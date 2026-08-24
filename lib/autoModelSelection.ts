/**
 * One question, answered in one place: which model answers this turn, and did
 * Auto choose it?
 *
 * `lib/routerDecision.ts` runs the Router. `lib/autoCohort.ts` says whether
 * this account may be routed at all. `lib/conversationSelectionMode.ts` holds
 * the conversation's mode and Auto's memory of it. Each is complete and none
 * of them answers the question on its own, because the answer needs all three
 * and a fallback for every way they can decline.
 *
 * ## Falling back is a normal outcome, not an error
 *
 * There are five ways Auto does not route a turn -- the conversation is
 * manual, the account is outside the cohort, a readiness gate is outstanding,
 * the kill switch is on, or the Router found no candidate -- and in every one
 * of them the right behaviour is identical: answer with the model the user
 * would have got anyway. The user is told nothing, because from their side
 * nothing went wrong.
 *
 * What must not happen is the reverse: a turn that reports itself as routed
 * when it fell back. The metrics that grade routing would then include turns
 * the Router never decided, and the sticky streak would advance on turns
 * nobody judged. So `routed` is a discriminated tag rather than a nullable
 * model id, and `fallbackModelId` is on the refusal branch where nothing can
 * read it as a routing result.
 */

import type { AiModel, ModelTier } from "@/lib/models";
import {
  decideAutoCohort,
  type AutoCohortConfig,
  type AutoCohortDecision,
} from "@/lib/autoCohort";
import { autoProductBoundary } from "@/lib/autoProductBoundary";
import type { ProductKeyReadMode } from "@/lib/productKeyReadMode";
import {
  storedSelectionMode,
  stickyStateFor,
  type ConversationRoutingState,
} from "@/lib/conversationSelectionMode";
import {
  decideRouterModel,
  type RouterDecisionRecord,
  type RouterVersions,
  ROUTER_VERSIONS,
} from "@/lib/routerDecision";
import type { RouterTieBreakSignals } from "@/lib/routerScorePolicy";
import type { RouterStickyState } from "@/lib/routerSelection";
import type { autoRolloutReadiness } from "@/lib/autoRolloutReadiness";

export type AutoSelectionRefusal =
  /**
   * The conversation belongs to a product Auto is not offered in.
   *
   * An AutoSelectionRefusal and never an AutoCohortRefusal, and reported
   * before the cohort is consulted (decision record v1.2 §3). A Review
   * conversation is not outside the cohort; it was never a subject of the
   * cohort question, and counting it as one would dilute the rollout
   * percentage with Review traffic until "what share of Chat users are routed"
   * stopped being readable.
   */
  | "product_not_chat"
  | "conversation_is_manual"
  /** No conversation row, so no mode and nowhere for sticky state to live. */
  | "no_conversation"
  | "cohort_refused"
  /**
   * The turn carries an attachment whose size could not be established.
   *
   * Routing needs the size, because what an attachment costs differs per
   * model, and a size a client declared is a claim rather than a measurement:
   * an understated one would steer the Router to a model whose window the real
   * content does not fit, and the user would get a context-window error for a
   * model they did not choose. So the size is read from object storage, and an
   * attachment that cannot be read there -- no key, a key outside the caller's
   * own prefix, or a store that will not answer -- is not routed.
   *
   * Deliberately reported *after* the cohort refusal, so this counts only
   * turns that would otherwise have been routed -- which is exactly the number
   * that says what the limitation costs.
   */
  | "attachments_unmeasurable"
  | "no_candidate";

export type AutoSelection =
  | {
      routed: true;
      modelId: string;
      /** Carry into the conversation row after the turn completes. */
      sticky: RouterStickyState;
      /**
       * What §7's automatic fallback may try instead, best first.
       *
       * The Router's own eligible set with the chosen model removed, so a
       * fallback candidate has passed exactly the filters the primary passed.
       * The stream must not compute its own: a second filter is free to
       * disagree with the one that made the decision, and the disagreement
       * would only ever show as a model being dispatched that the Router had
       * already refused.
       */
      fallbackCandidateModelIds: readonly string[];
      record: RouterDecisionRecord;
      versions: RouterVersions;
      cohort: Extract<AutoCohortDecision, { eligible: true }>;
    }
  | {
      routed: false;
      reason: AutoSelectionRefusal;
      /** What answers instead: always the model the user would have got. */
      fallbackModelId: string;
      /** Present when the cohort was consulted, for operator logging. */
      cohort?: AutoCohortDecision;
      /** Present on `no_candidate`, so the refusal can be explained. */
      record?: RouterDecisionRecord;
    };

export type AutoSelectionInput = {
  /** The model the request asked for; the fallback in every refusal. */
  requestedModelId: string;
  /**
   * The conversation's mode and Auto's memory of it.
   *
   * `null` when there is no conversation -- and legitimately `null` when the
   * caller skipped the read because the cohort would refuse anyway. The cohort
   * is checked first for exactly that reason, so a skipped read is never
   * mistaken for a missing conversation.
   */
  conversation: ConversationRoutingState | null;
  /**
   * True when the turn carries an attachment whose size could not be
   * established. False both for a turn with no attachment and for one whose
   * attachments were measured -- see `measureTurnAttachments`.
   */
  attachmentsUnmeasurable: boolean;
  /**
   * The conversation's stored productKey, or null when there is no
   * conversation.
   *
   * Read from the row, never from the surface the request came from: §6
   * forbids a surfaceProductKey fallback at dispatch precisely because the
   * surface is the client's claim and the row is the server's decision.
   *
   * Null is not a product refusal -- it is `no_conversation` further down,
   * which counts a different thing.
   */
  productKey: string | null;
  /** Defaults to the transition's own mode. See lib/productKeyReadMode.ts. */
  readMode?: ProductKeyReadMode;
  subjectKey: string;
  isGuest: boolean;
  /** The candidate filter's own plan type: a tier, or Guest. */
  plan: ModelTier | "Guest" | null;
  /** The turn's text, for the task profile. Never stored anywhere. */
  text: string;
  attachments: readonly { mediaType?: string }[];
  webSearchRequested: boolean;
  models: readonly AiModel[];
  reservedInputTokens: number;
  /**
   * The unfitted cap. The candidate filter fits it to each model's own window,
   * and handing it a figure already fitted to the requested model's window
   * would bias every other candidate against the one the user happened to pick.
   */
  requestOutputCapTokens: number;
  unhealthyModelIds?: readonly string[];
  regionBlockedModelIds?: readonly string[];
  availableCredits?: number;
  creditsByModelId?: Readonly<Record<string, number>>;
  /** Per-model attachment cost. See `lib/routerCandidates.ts`. */
  attachmentTokensFor?: (model: AiModel) => number;
  /**
   * Measured tie-break signals -- recent success rate and time to first token
   * per model -- for the ranking's third and fourth criteria.
   *
   * Optional, and unknown when absent rather than assumed: a criterion with no
   * data abstains, so a caller that has not wired the health rollup and the
   * output-token telemetry yet gets a ranking decided by quality band and
   * cost, not one that quietly credits every model with a perfect record.
   */
  signals?: RouterTieBreakSignals;
  cohortConfig?: AutoCohortConfig;
  readiness?: ReturnType<typeof autoRolloutReadiness>;
  now?: () => number;
};

export const selectAutoModel = (input: AutoSelectionInput): AutoSelection => {
  const fallbackModelId = input.requestedModelId;

  // The product first, before the cohort. Cheaper than the cohort as well as
  // more fundamental: the caller has already read the row under its ownership
  // check, so this costs nothing at all.
  //
  // `cohort` is deliberately absent from this refusal. The cohort was not
  // consulted, so there is no bucket to log, and a bucket logged here would
  // appear in rollout figures for a conversation that was never a subject of
  // the rollout.
  const product = autoProductBoundary({
    productKey: input.productKey,
    // The row's existence, not its product. A conversation whose productKey
    // is still NULL resolves to Review through the read mode and is refused;
    // a turn with no conversation has nothing to resolve and falls through to
    // `no_conversation` below.
    hasConversation: input.conversation !== null,
    readMode: input.readMode,
  });
  if (product.reason === "product_not_chat") {
    return { routed: false, reason: "product_not_chat", fallbackModelId };
  }

  // The cohort next, and it is the only remaining check that costs nothing: the plan is
  // already in hand and readiness is read from memory. Everything below it
  // needs the conversation row, so a caller can skip that read entirely for an
  // account the cohort would refuse -- which, while the rollout is off, is
  // every account. A feature that is disabled should cost nothing, not merely
  // do nothing.
  const cohort = decideAutoCohort({
    subjectKey: input.subjectKey,
    isGuest: input.isGuest,
    plan: input.plan,
    config: input.cohortConfig,
    readiness: input.readiness,
  });
  if (!cohort.eligible) {
    return { routed: false, reason: "cohort_refused", fallbackModelId, cohort };
  }

  // Below here the account *is* in the cohort, so a manual conversation is
  // reported as manual rather than as a cohort refusal. That distinction is
  // what keeps the cohort's size honest: this account may be routing another
  // conversation right now.
  if (!input.conversation) {
    return { routed: false, reason: "no_conversation", fallbackModelId, cohort };
  }
  if (storedSelectionMode(input.conversation.selectionMode) !== "auto") {
    return { routed: false, reason: "conversation_is_manual", fallbackModelId, cohort };
  }

  if (input.attachmentsUnmeasurable) {
    return { routed: false, reason: "attachments_unmeasurable", fallbackModelId, cohort };
  }

  const decision = decideRouterModel(
    {
      text: input.text,
      attachments: input.attachments,
      webSearchRequested: input.webSearchRequested,
      models: input.models,
      // Non-null here: the cohort refused a guest and a plan-less account
      // above, so a plan that reached this line is one the filters accept.
      plan: input.plan as ModelTier | "Guest",
      reservedInputTokens: input.reservedInputTokens,
      requestOutputCapTokens: input.requestOutputCapTokens,
      unhealthyModelIds: input.unhealthyModelIds,
      regionBlockedModelIds: input.regionBlockedModelIds,
      availableCredits: input.availableCredits,
      creditsByModelId: input.creditsByModelId,
      attachmentTokensFor: input.attachmentTokensFor,
      sticky: stickyStateFor(input.conversation),
      signals: input.signals,
    },
    input.now
  );

  // Every model was filtered out. The user still gets an answer from the model
  // they would have had; what they do not get is a Router silently picking
  // "something" because a default was easier to return than a refusal.
  if (decision.outcome !== "selected") {
    return {
      routed: false,
      reason: "no_candidate",
      fallbackModelId,
      cohort,
      record: decision.record,
    };
  }

  return {
    routed: true,
    modelId: decision.modelId,
    sticky: decision.sticky,
    fallbackCandidateModelIds: decision.fallbackCandidateModelIds,
    record: decision.record,
    versions: ROUTER_VERSIONS,
    cohort,
  };
};

/**
 * What the client is told about this turn's model.
 *
 * Forward-compatible by construction: a client that does not know a field
 * ignores it, and a client that knows `selectionMode` can render the Auto
 * badge without a second request. `reason` is the Router's own fixed
 * identifier, never prose and never anything derived from the turn, so it can
 * be localised on the client and logged on the server without either becoming
 * a copy of what the user wrote.
 */
export type SelectionDisclosure = {
  selectionMode: "manual" | "auto";
  /** The model that actually answered, routed or not. */
  modelId: string;
  /** True only when the Router chose it. */
  routed: boolean;
  /** Fixed selection-reason identifier, or the refusal, for an Auto turn. */
  reason: string | null;
};

export const selectionDisclosure = (
  selection: AutoSelection,
  conversationMode: "manual" | "auto"
): SelectionDisclosure =>
  selection.routed
    ? {
        selectionMode: conversationMode,
        modelId: selection.modelId,
        routed: true,
        reason: selection.record.selectionReason,
      }
    : {
        selectionMode: conversationMode,
        modelId: selection.fallbackModelId,
        routed: false,
        // A manual conversation has no routing reason to report, and inventing
        // one would put every manual turn into the Auto metrics.
        reason: conversationMode === "auto" ? selection.reason : null,
      };
