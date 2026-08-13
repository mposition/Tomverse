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
import type { RouterStickyState } from "@/lib/routerSelection";
import type { autoRolloutReadiness } from "@/lib/autoRolloutReadiness";

export type AutoSelectionRefusal =
  | "conversation_is_manual"
  /** No conversation row, so no mode and nowhere for sticky state to live. */
  | "no_conversation"
  | "cohort_refused"
  | "no_candidate";

export type AutoSelection =
  | {
      routed: true;
      modelId: string;
      /** Carry into the conversation row after the turn completes. */
      sticky: RouterStickyState;
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
  conversation: ConversationRoutingState | null;
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
  cohortConfig?: AutoCohortConfig;
  readiness?: ReturnType<typeof autoRolloutReadiness>;
  now?: () => number;
};

export const selectAutoModel = (input: AutoSelectionInput): AutoSelection => {
  const fallbackModelId = input.requestedModelId;

  // Checked before the cohort on purpose. A manual conversation is not a
  // cohort refusal, and recording it as one would make the cohort look
  // smaller than it is -- the account may well be in it, on other
  // conversations, right now.
  if (!input.conversation) {
    return { routed: false, reason: "no_conversation", fallbackModelId };
  }
  if (storedSelectionMode(input.conversation.selectionMode) !== "auto") {
    return { routed: false, reason: "conversation_is_manual", fallbackModelId };
  }

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
      sticky: stickyStateFor(input.conversation),
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
