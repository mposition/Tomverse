import type { AiModel } from "@/lib/models";
import { decideRouterModel, ROUTER_VERSIONS, type RouterDecisionRecord,
  type RouterVersions } from "@/lib/routerDecision";
import type { RouterCandidateInput } from "@/lib/routerCandidates";
import type { RouterTieBreakSignals } from "@/lib/routerScorePolicy";

export type GuestChatAutoSelection = Readonly<
  | {
      routed: true;
      modelId: string;
      fallbackCandidateModelIds: readonly string[];
      record: RouterDecisionRecord;
      versions: RouterVersions;
    }
  | {
      routed: false;
      reason: "authority_refused" | "attachments_unmeasurable" | "no_candidate";
      record?: RouterDecisionRecord;
    }
>;

export type GuestChatAutoSelectionInput = Readonly<{
  /** Result of the server-side signed authority verification for this request. */
  authorityVerified: boolean;
  text: string;
  attachments: readonly { mediaType?: string }[];
  attachmentsUnmeasurable: boolean;
  webSearchRequested: boolean;
  searchBackendReadiness: RouterCandidateInput["searchBackendReadiness"];
  models: readonly AiModel[];
  reservedInputTokens: number;
  requestOutputCapTokens: number;
  unhealthyModelIds?: readonly string[];
  regionBlockedModelIds?: readonly string[];
  availableCredits: number;
  creditsByModelId: Readonly<Record<string, number>>;
  attachmentTokensFor?: (model: AiModel) => number;
  signals?: RouterTieBreakSignals;
  now?: () => number;
}>;

/**
 * Deterministic Guest Smart Adaptive selection.
 *
 * This deliberately does not call `selectAutoModel`: that account path owns
 * stored Conversation mode, account cohort and sticky state, none of which a
 * Guest turn has. The caller must first verify the short-lived Guest Chat
 * authority and reserve the shared Guest quota. Candidate filtering remains
 * the ordinary Router's `plan: "Guest"` path, so this cannot widen the Guest
 * model allowlist.
 */
export function selectGuestChatAutoModel(
  input: GuestChatAutoSelectionInput,
): GuestChatAutoSelection {
  if (!input.authorityVerified) {
    return Object.freeze({ routed: false, reason: "authority_refused" });
  }
  if (input.attachmentsUnmeasurable) {
    return Object.freeze({ routed: false, reason: "attachments_unmeasurable" });
  }
  const decision = decideRouterModel({
    text: input.text,
    attachments: input.attachments,
    webSearchRequested: input.webSearchRequested,
    searchBackendReadiness: input.searchBackendReadiness,
    models: input.models,
    plan: "Guest",
    reservedInputTokens: input.reservedInputTokens,
    requestOutputCapTokens: input.requestOutputCapTokens,
    unhealthyModelIds: input.unhealthyModelIds,
    regionBlockedModelIds: input.regionBlockedModelIds,
    availableCredits: input.availableCredits,
    creditsByModelId: input.creditsByModelId,
    attachmentTokensFor: input.attachmentTokensFor,
    sticky: null,
    signals: input.signals,
  }, input.now);
  if (decision.outcome !== "selected") {
    return Object.freeze({ routed: false, reason: "no_candidate",
      record: decision.record });
  }
  return Object.freeze({ routed: true, modelId: decision.modelId,
    fallbackCandidateModelIds: Object.freeze(
      [...decision.fallbackCandidateModelIds]),
    record: decision.record, versions: ROUTER_VERSIONS });
}
