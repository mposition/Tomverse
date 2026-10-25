import "server-only";

import {
  assessPromptRefinerAutoShadow,
  type PromptRefinerAutoShadowAssessment,
  type PromptRefinerAutoShadowReason,
} from "@/lib/promptRefinerAutoShadow";
import {
  type PromptRefinerChatMessage,
  type PromptRefinerChatProjectionProvenance,
  type PromptRefinerExecutionMessage,
} from "@/lib/promptRefinerChatHandoff";
import {
  createPromptRefinerSyntheticDecisionSession,
  PromptRefinerSyntheticDecisionError,
} from "@/lib/promptRefinerSyntheticDecisionSession";

export type PromptRefinerSyntheticAutoSessionOptions =
  Parameters<typeof createPromptRefinerSyntheticDecisionSession>[0] & {
    /** Strict true enables only this process-local synthetic input view. */
    syntheticAutoEnabled?: boolean;
  };

export type PromptRefinerSyntheticAutoComparison =
  Parameters<typeof assessPromptRefinerAutoShadow>[0];

export type PromptRefinerSyntheticAutoInput<Message extends PromptRefinerChatMessage> =
  Readonly<{
    /** Already-parsed transcript observed by the synthetic server harness. */
    messages: readonly Message[];
    /** C03 admits only the ids and explicit accepted/kept_original choice. */
    choice?: unknown;
    /** Optional, retrospective observations; null represents missing evidence. */
    shadowComparison?: PromptRefinerSyntheticAutoComparison | null;
  }>;

export type PromptRefinerSyntheticAutoResult<Message extends PromptRefinerChatMessage> =
  Readonly<{
    authoredMessages: readonly Message[];
    /** Both stages receive one synchronously selected view, or neither does. */
    routerMessages: readonly PromptRefinerExecutionMessage<Message>[] | null;
    plannerMessages: readonly PromptRefinerExecutionMessage<Message>[] | null;
    inputSource: "original" | "accepted_proposal" | "none";
    reason: "default_off" | "explicit_acceptance_required" | "kept_original"
      | "accepted_proposal" | "decision_invalid_or_unavailable"
      | PromptRefinerAutoShadowReason;
    decisionErrorCode: PromptRefinerSyntheticDecisionError["code"] | "unknown" | null;
    provenance: PromptRefinerChatProjectionProvenance | null;
    shadowAssessment: PromptRefinerAutoShadowAssessment | null;
    evidenceAuthority: "synthetic_only";
    dispatchAuthorized: false;
  }>;

const missingComparison = (): PromptRefinerAutoShadowAssessment =>
  assessPromptRefinerAutoShadow({
    original: { qualityScore: null, costMicroUsd: null, preparationLatencyMs: null },
    candidate: { qualityScore: null, costMicroUsd: null, preparationLatencyMs: null },
    candidateOutcome: "completed",
  });

/**
 * D01/D02 synthetic-only facade. It owns the C03 session and consumes that
 * session before returning the same selected transcript to Router and Planner
 * stand-ins. No projection, suggestion bytes or authorization can be supplied
 * by a caller. There is no provider, product route, database, audit writer,
 * environment switch, network call or product dispatch connected here.
 *
 * The harness owner supplies authoritative snapshot transitions, including ABA.
 * Optional shadow comparisons describe earlier synthetic observations, never
 * a current-turn dispatch command or authenticated quality/rollout evidence.
 */
export function createPromptRefinerSyntheticAutoSession(
  input: PromptRefinerSyntheticAutoSessionOptions,
) {
  const enabled = input.syntheticAutoEnabled === true;
  const session = createPromptRefinerSyntheticDecisionSession(input);
  let haltedAssessment: PromptRefinerAutoShadowAssessment | null = null;

  return {
    status: session.status,
    updateSnapshot: session.updateSnapshot,
    beginProposal: session.beginProposal,
    completeProposal: session.completeProposal,
    close: session.close,
    fail: session.fail,
    consumeAutoInput<Message extends PromptRefinerChatMessage>(
      value: PromptRefinerSyntheticAutoInput<Message>,
    ): PromptRefinerSyntheticAutoResult<Message> {
      const messages = value.messages;
      let shadowAssessment: PromptRefinerAutoShadowAssessment | null = haltedAssessment;
      if (!haltedAssessment && Object.hasOwn(value, "shadowComparison")) {
        try {
          const comparison = value.shadowComparison;
          shadowAssessment = comparison == null
            ? missingComparison()
            : assessPromptRefinerAutoShadow(comparison);
        } catch {
          // An unreadable outcome could have occurred after dispatch.
          shadowAssessment = assessPromptRefinerAutoShadow({
            original: { qualityScore: null, costMicroUsd: null, preparationLatencyMs: null },
            candidate: { qualityScore: null, costMicroUsd: null, preparationLatencyMs: null },
            candidateOutcome: "unknown_after_dispatch",
          });
        }
      }
      if (shadowAssessment) shadowAssessment = Object.freeze({ ...shadowAssessment });
      const result = (
        view: readonly PromptRefinerExecutionMessage<Message>[] | null,
        inputSource: PromptRefinerSyntheticAutoResult<Message>["inputSource"],
        reason: PromptRefinerSyntheticAutoResult<Message>["reason"],
        provenance: PromptRefinerChatProjectionProvenance | null = null,
        decisionErrorCode: PromptRefinerSyntheticAutoResult<Message>["decisionErrorCode"] = null,
      ): PromptRefinerSyntheticAutoResult<Message> => ({
        authoredMessages: messages,
        routerMessages: view,
        plannerMessages: view,
        inputSource,
        reason,
        decisionErrorCode,
        provenance,
        shadowAssessment,
        evidenceAuthority: "synthetic_only",
        dispatchAuthorized: false,
      });

      if (shadowAssessment?.futureInputSignal === "stop_and_reconcile") {
        // Never convert a dispatched failure/unknown into an original retry.
        // New proposals or later comparison claims cannot clear this latch.
        haltedAssessment = shadowAssessment;
        session.close();
        return result(null, "none", shadowAssessment.reason);
      }

      const comparisonKeepsOriginal = shadowAssessment?.futureInputSignal === "keep_original";
      try {
        // Null still consumes/revokes ready state: toggling or replay cannot
        // resurrect acceptance after an original-input fallback.
        const projection = session.consumeSyntheticInput(
          messages,
          enabled && !comparisonKeepsOriginal ? value.choice ?? null : null,
        );
        if (!enabled) return result(messages, "original", "default_off");
        if (comparisonKeepsOriginal) {
          return result(messages, "original", shadowAssessment!.reason);
        }
        if (projection.provenance?.decision === "accepted") {
          return result(
            projection.executionMessages, "accepted_proposal", "accepted_proposal",
            projection.provenance,
          );
        }
        if (projection.provenance?.decision === "kept_original") {
          return result(messages, "original", "kept_original", projection.provenance);
        }
        return result(messages, "original", "explicit_acceptance_required");
      } catch (error) {
        session.fail();
        return result(
          messages, "original", "decision_invalid_or_unavailable", null,
          error instanceof PromptRefinerSyntheticDecisionError ? error.code : "unknown",
        );
      }
    },
  };
}
