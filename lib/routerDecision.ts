// One Auto routing decision, start to finish.
//
// lib/taskProfileCore.ts reads the turn, lib/routerCandidates.ts says which
// models may be considered, and lib/routerSelection.ts ranks what survives.
// Each is complete and each was unreachable: nothing called any of them, so
// there was no Router -- only three functions that would make one.
//
// This is the seam between them, and it exists to hold three things the parts
// cannot hold individually:
//
// **A refusal is an outcome, not a null.** When every model is filtered out,
// the honest answer is that Auto has nothing to offer and the caller must say
// so. Returning `selectedModelId: null` and trusting every call site to check
// it is how a default model gets picked "just in case" -- which is exactly the
// case where the user most needs to be told. The decision is a discriminated
// union instead: nothing reads a model id off a refusal.
//
// **The record is content-free by construction.** RoutingRun exists to explain
// a decision afterwards, and the temptation is to keep the prompt so the
// explanation is legible. That is the same mistake as copying the question
// into the rate-limit telemetry: the audit becomes a second copy of the thing
// it audits. Nothing here accepts the turn's text into the record -- the
// profile contributes fixed rule names and script labels, the filters
// contribute model ids and fixed reason identifiers, and that is all there is.
//
// **Versions travel together.** Four components each carry their own version,
// and a decision that records three of them cannot be attributed later. They
// are collected in one place so adding a fifth is a change here rather than a
// change in every caller.

import {
  filterRouterCandidates,
  ROUTER_CANDIDATE_VERSION,
  type CandidateRejection,
  type RouterCandidate,
  type RouterCandidateInput,
} from "@/lib/routerCandidates";
import {
  selectRouterModel,
  ROUTER_SELECTION_VERSION,
  type RouterStickyState,
  type SelectionReason,
} from "@/lib/routerSelection";
import {
  buildTaskProfile,
  TASK_PROFILE_VERSION,
  type TaskProfile,
  type TaskProfileInput,
} from "@/lib/taskProfileCore";

/**
 * Bump when the composition changes -- a new stage, a different order, a
 * different meaning for an existing field. The component versions below move
 * independently; this one says how they were put together.
 */
export const ROUTER_DECISION_VERSION = "router-decision-v1";

export type RouterVersions = {
  decision: string;
  taskProfile: string;
  candidates: string;
  selection: string;
};

export const ROUTER_VERSIONS: RouterVersions = {
  decision: ROUTER_DECISION_VERSION,
  taskProfile: TASK_PROFILE_VERSION,
  candidates: ROUTER_CANDIDATE_VERSION,
  selection: ROUTER_SELECTION_VERSION,
};

export type RouterDecisionInput = TaskProfileInput &
  Omit<RouterCandidateInput, "profile"> & {
    /** The conversation's current model and challenger streak, if any. */
    sticky?: RouterStickyState | null;
  };

/**
 * What RoutingRun stores. Everything here is a fixed identifier, a model id, a
 * count or a version string -- never anything derived from what the user wrote.
 */
export type RouterDecisionRecord = {
  versions: RouterVersions;
  taskKind: TaskProfile["kind"];
  taskConfidence: TaskProfile["kindConfidence"];
  needsCurrentInformation: boolean;
  expectedOutputLength: TaskProfile["expectedOutputLength"];
  scripts: readonly string[];
  /** Fixed rule names from the profiler, never text from the turn. */
  signals: readonly string[];
  reservedInputTokens: number;
  requestOutputCapTokens: number;
  consideredModelCount: number;
  eligibleModelIds: readonly string[];
  rejections: readonly { modelId: string; reason: CandidateRejection }[];
  selectedModelId: string | null;
  selectionReason: SelectionReason;
  selectionMargin: number;
  challengerModelId: string | null;
  turnsFavouringChallenger: number;
  decisionLatencyMs: number;
};

export type RouterDecision =
  | {
      outcome: "selected";
      modelId: string;
      /** Output room this model has for this turn, from the window arithmetic. */
      outputTokens: number;
      profile: TaskProfile;
      /** Carry into the next turn so hysteresis can accumulate. */
      sticky: RouterStickyState;
      /**
       * The other eligible models, best first, with the chosen one removed.
       *
       * §6: an automatic fallback's candidate must pass the same compatibility
       * filters as the primary. These did -- they are the rest of the set this
       * decision was made from, in the order it ranked them. Empty means the
       * Router had exactly one model to offer, which is a refusal reason for a
       * fallback rather than a reason to go looking elsewhere.
       */
      fallbackCandidateModelIds: readonly string[];
      record: RouterDecisionRecord;
    }
  | {
      outcome: "no_candidate";
      profile: TaskProfile;
      /**
       * Why each model was unavailable, first blocking reason only. This is
       * what the caller turns into an explanation; without it the user is told
       * "no model is available" and nothing else.
       */
      rejections: readonly { modelId: string; reason: CandidateRejection }[];
      record: RouterDecisionRecord;
    };

/** Distinct rejection reasons, most frequent first. What to tell the user. */
export const summariseRejections = (
  rejections: readonly { modelId: string; reason: CandidateRejection }[]
): readonly { reason: CandidateRejection; count: number }[] => {
  const counts = new Map<CandidateRejection, number>();
  for (const rejection of rejections) {
    counts.set(rejection.reason, (counts.get(rejection.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) =>
      right.count === left.count
        ? left.reason.localeCompare(right.reason)
        : right.count - left.count
    );
};

/**
 * Runs the whole decision.
 *
 * `now` is injected rather than read, because the latency this records is a
 * measurement and a measurement with a hidden clock cannot be tested. Callers
 * pass `Date.now`; tests pass a counter.
 */
export function decideRouterModel(
  input: RouterDecisionInput,
  now: () => number = Date.now
): RouterDecision {
  const startedAt = now();

  const profile = buildTaskProfile({
    text: input.text,
    attachments: input.attachments,
    webSearchRequested: input.webSearchRequested,
  });

  const candidates = filterRouterCandidates({
    models: input.models,
    plan: input.plan,
    profile,
    reservedInputTokens: input.reservedInputTokens,
    requestOutputCapTokens: input.requestOutputCapTokens,
    attachmentTokensFor: input.attachmentTokensFor,
    unhealthyModelIds: input.unhealthyModelIds,
    regionBlockedModelIds: input.regionBlockedModelIds,
    availableCredits: input.availableCredits,
    creditsByModelId: input.creditsByModelId,
  });

  const selection = selectRouterModel({
    profile,
    eligible: candidates.eligible,
    sticky: input.sticky ?? null,
  });

  const record: RouterDecisionRecord = {
    versions: ROUTER_VERSIONS,
    taskKind: profile.kind,
    taskConfidence: profile.kindConfidence,
    needsCurrentInformation: profile.needsCurrentInformation,
    expectedOutputLength: profile.expectedOutputLength,
    scripts: profile.scripts,
    signals: profile.signals,
    reservedInputTokens: input.reservedInputTokens,
    requestOutputCapTokens: input.requestOutputCapTokens,
    consideredModelCount: input.models.length,
    eligibleModelIds: candidates.eligible.map((candidate) => candidate.modelId),
    rejections: candidates.rejected,
    selectedModelId: selection.selectedModelId,
    selectionReason: selection.reason,
    selectionMargin: selection.margin,
    challengerModelId: selection.challengerModelId,
    turnsFavouringChallenger: selection.turnsFavouringChallenger,
    decisionLatencyMs: Math.max(0, now() - startedAt),
  };

  if (selection.selectedModelId === null) {
    return {
      outcome: "no_candidate",
      profile,
      rejections: candidates.rejected,
      record,
    };
  }

  // The selection names a model; the filter knows its output room. They cannot
  // disagree -- selection only ever ranks what the filter returned -- but an
  // absent entry would mean one of them changed without the other, so it is a
  // refusal rather than a default.
  const chosen: RouterCandidate | undefined = candidates.eligible.find(
    (candidate) => candidate.modelId === selection.selectedModelId
  );
  if (!chosen) {
    throw new Error(
      `Router selected ${selection.selectedModelId}, which is not in its own eligible set.`
    );
  }

  return {
    outcome: "selected",
    modelId: chosen.modelId,
    outputTokens: chosen.outputTokens,
    profile,
    sticky: {
      modelId: chosen.modelId,
      turnsFavouringChallenger: selection.turnsFavouringChallenger,
    },
    // The chosen model is removed rather than assumed to be first: stickiness
    // can select a model the ranking did not put at the top, and a list that
    // still contained the primary would offer it as its own alternative.
    fallbackCandidateModelIds: selection.rankedModelIds.filter(
      (modelId) => modelId !== chosen.modelId
    ),
    record,
  };
}
