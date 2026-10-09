import "server-only";
import { createPromptRefinerSyntheticAutoSession } from "@/lib/promptRefinerSyntheticAutoSession";
import { PROMPT_REFINER_INPUT_SCOPE } from "@/lib/promptRefinerSuggestion";
import type { ChatE04AutoAction } from "@/lib/chatE04StagingFixture";

/** Fixed public synthetic examples; accepts no prompt, comparison or authority. */
export function runChatE04SyntheticAuto(action: ChatE04AutoAction) {
  const original = "E04 synthetic: compare two notebooks.";
  const refined = "E04 synthetic: compare two notebooks by battery and weight.";
  const snapshot = { draft: original, sourceMessageId: "e04-current", scope: {
    identityKey: "e04-synthetic", mountedSurface: "e04-qa", conversationId: "e04-synthetic-chat",
  } };
  const messages = [
    { id: "e04-history", role: "assistant" as const, content: "E04 synthetic history." },
    { id: snapshot.sourceMessageId, role: "user" as const, content: original },
  ];
  const session = createPromptRefinerSyntheticAutoSession({
    snapshot, now: () => 1_000, syntheticAutoEnabled: action !== "default_off",
  });
  const request = session.beginProposal();
  session.completeProposal(request.requestId, {
    requestId: request.requestId, suggestionId: "e04-synthetic-suggestion",
    refinedPrompt: refined, refinerVersion: "suggest-v1", inputScope: PROMPT_REFINER_INPUT_SCOPE,
  });
  const choice = { requestId: request.requestId, suggestionId: "e04-synthetic-suggestion",
    decision: action === "kept_original" ? "kept_original" : "accepted" };
  if (action === "stale") {
    session.updateSnapshot({ ...snapshot, draft: original + " edited" });
    session.updateSnapshot(snapshot);
  }
  if (action === "replay") session.consumeAutoInput({ messages, choice });
  const result = session.consumeAutoInput({ messages, choice,
    ...(action === "unknown" ? { shadowComparison: {
      original: { qualityScore: null, costMicroUsd: null, preparationLatencyMs: null },
      candidate: { qualityScore: null, costMicroUsd: null, preparationLatencyMs: null },
      candidateOutcome: "unknown_after_dispatch" as const,
    } } : {}),
  });
  return {
    action, reason: result.reason, inputSource: result.inputSource,
    decisionErrorCode: result.decisionErrorCode,
    authoredOriginalPreserved: result.authoredMessages.at(-1)?.content === original,
    stagesShareInput: result.routerMessages === result.plannerMessages,
    selectedSyntheticText: result.routerMessages?.at(-1)?.content ?? null,
    evidenceAuthority: result.evidenceAuthority, dispatchAuthorized: result.dispatchAuthorized,
    providerCalls: 0, costMicroUsd: 0, productDatabaseWrites: 0, auditWrites: 0,
  };
}
