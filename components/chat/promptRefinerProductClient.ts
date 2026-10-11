import {
  type BoundPromptRefinerSuggestion,
  type PromptRefinerDecision,
  type PromptRefinerResolution,
} from "@/lib/promptRefinerSuggestion";
import {
  promptRefinerProductChatDecisionSchema,
  promptRefinerProductProposalFallbackSchema,
  promptRefinerProductProposalReadySchema,
  promptRefinerProductProposalRequestSchema,
  promptRefinerProductPrepareResponseSchema,
  promptRefinerProductScopeResponseSchema,
  type PromptRefinerProductChatDecision,
  type PromptRefinerProductFallbackReason,
  type PromptRefinerProductProposalRequest,
  type PromptRefinerProductPrepareResponse,
  type PromptRefinerProductScope,
} from "@/lib/promptRefinerProductApiContract";

export {
  promptRefinerProductProposalRequestSchema,
  promptRefinerProductScopeResponseSchema as promptRefinerProductScopeSchema,
  type PromptRefinerProductProposalRequest,
  type PromptRefinerProductScope,
};

export type PromptRefinerProductProposal = Readonly<{
  suggestion: BoundPromptRefinerSuggestion;
  scope: PromptRefinerProductScope;
  /** The request id the Message writer must use for this exact source turn. */
  clientRequestId: string;
}>;

export type PromptRefinerProductProposalResult =
  | { outcome: "ready"; proposal: PromptRefinerProductProposal }
  | { outcome: "fallback_original"; reason: PromptRefinerProductFallbackReason };

/**
 * Accepts only the server-held proposal reference and display copy. The source
 * bytes are supplied by the still-current local draft and never come back as
 * browser authority. Scope mismatches are stale responses, not proposals that
 * can be kept around for a later A -> B -> A navigation.
 */
export function parsePromptRefinerProductProposal(input: {
  value: unknown;
  expectedScope: PromptRefinerProductScope;
  sourcePrompt: string;
}): PromptRefinerProductProposalResult | null {
  const fallback = promptRefinerProductProposalFallbackSchema.safeParse(
    input.value
  );
  if (fallback.success) {
    return { outcome: "fallback_original", reason: fallback.data.reason };
  }

  const parsed = promptRefinerProductProposalReadySchema.safeParse(input.value);
  if (!parsed.success ||
      parsed.data.scopeId !== input.expectedScope.scopeId ||
      parsed.data.epoch !== input.expectedScope.epoch) {
    return null;
  }
  const {
    scopeId,
    epoch: responseEpoch,
    clientRequestId,
    ...response
  } = parsed.data;
  return {
    outcome: "ready",
    proposal: {
      suggestion: { ...response, sourcePrompt: input.sourcePrompt },
      scope: { scopeId, epoch: responseEpoch },
      clientRequestId,
    },
  };
}

/** Browser decisions name a held row. They never carry execution text. */
export function promptRefinerChatDecision(
  proposal: PromptRefinerProductProposal,
  decision: PromptRefinerDecision
): PromptRefinerProductChatDecision {
  return promptRefinerProductChatDecisionSchema.parse({
    suggestionId: proposal.suggestion.suggestionId,
    scopeId: proposal.scope.scopeId,
    epoch: proposal.scope.epoch,
    decision,
  });
}

export type PromptRefinerExplicitSendAuthority = Readonly<{
  authoredPrompt: string;
  decision: PromptRefinerProductChatDecision;
  clientRequestId: string;
}>;

/**
 * Resolves an explicit send from the still-current held identifiers. This is
 * deliberately text-asymmetric: only the authored source is returned. The
 * refined execution bytes remain server-held.
 */
export function resolvePromptRefinerExplicitSend(input: {
  proposal: PromptRefinerProductProposal | null;
  resolution: PromptRefinerResolution | null;
  decision: PromptRefinerProductChatDecision | null;
  currentScope: PromptRefinerProductScope | null;
  currentPrompt: string;
  boundAttachmentKey: string | null;
  currentAttachmentKey: string;
}): PromptRefinerExplicitSendAuthority | null {
  const { proposal, resolution, decision, currentScope } = input;
  if (!proposal || !resolution || !decision || !currentScope ||
      resolution.persistedUserPrompt !== input.currentPrompt ||
      input.boundAttachmentKey !== input.currentAttachmentKey ||
      proposal.scope.scopeId !== currentScope.scopeId ||
      proposal.scope.epoch !== currentScope.epoch ||
      decision.scopeId !== proposal.scope.scopeId ||
      decision.epoch !== proposal.scope.epoch ||
      decision.suggestionId !== proposal.suggestion.suggestionId ||
      decision.decision !== resolution.decision ||
      resolution.provenance.requestId !== proposal.suggestion.requestId ||
      resolution.provenance.suggestionId !== proposal.suggestion.suggestionId ||
      resolution.provenance.refinerVersion !== proposal.suggestion.refinerVersion ||
      resolution.provenance.inputScope !== proposal.suggestion.inputScope ||
      resolution.provenance.decision !== decision.decision) return null;
  return {
    authoredPrompt: resolution.persistedUserPrompt,
    decision,
    clientRequestId: proposal.clientRequestId,
  };
}

/**
 * Auto may only use the held row returned for the scope which initiated this
 * one preparation. A late A -> B -> A response is an original fallback in the
 * caller, never a decision that can be attached to the returning A turn.
 */
export function parsePromptRefinerProductAutoPrepare(
  value: unknown,
  expectedScope: PromptRefinerProductScope
): PromptRefinerProductPrepareResponse | null {
  const parsed = promptRefinerProductPrepareResponseSchema.safeParse(value);
  if (!parsed.success) return null;
  if (parsed.data.outcome === "auto_held" &&
      (parsed.data.decision.scopeId !== expectedScope.scopeId ||
        parsed.data.decision.epoch !== expectedScope.epoch)) return null;
  return parsed.data;
}

export type PromptRefinerExecutionObservation = Readonly<{
  execution: "applied" | "original";
  mode: "explicit" | "auto";
}>;

/** Content-free response metadata for UI notice only, never authorization. */
export function parsePromptRefinerExecutionHeaders(
  headers: Pick<Headers, "get">
): PromptRefinerExecutionObservation | null {
  const execution = headers.get("X-Prompt-Refiner-Execution");
  const mode = headers.get("X-Prompt-Refiner-Mode");
  if ((execution !== "applied" && execution !== "original") ||
      (mode !== "explicit" && mode !== "auto")) return null;
  return { execution, mode };
}

/** A held decision is single-use, so no client recovery may replay it. */
export function promptRefinerAllowsAutomaticChatRecovery(
  decision: PromptRefinerProductChatDecision | undefined
) {
  return decision === undefined;
}

/** Product turns preserve authored bytes instead of applying ordinary trim. */
export function promptRefinerAuthoredPromptForSend(input: {
  rawPrompt: string;
  ordinaryPrompt: string;
  productTurn: boolean;
}) {
  return input.productTurn ? input.rawPrompt : input.ordinaryPrompt;
}

