import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePromptRefinerExecutionHeaders,
  parsePromptRefinerProductAutoPrepare,
  parsePromptRefinerProductProposal,
  promptRefinerChatDecision,
  promptRefinerAllowsAutomaticChatRecovery,
  promptRefinerAuthoredPromptForSend,
  promptRefinerProductProposalRequestSchema,
  resolvePromptRefinerExplicitSend,
} from "@/components/chat/promptRefinerProductClient";
import { resolvePromptRefinerDecision } from "@/lib/promptRefinerSuggestion";
import { reusablePreparedDraftRevision } from
  "@/components/chat/useConversationDrafts";

const scope = {
  scopeId: "00000000-0000-4000-8000-000000000011",
  epoch: 7,
};

const response = {
  requestId: "00000000-0000-4000-8000-000000000012",
  suggestionId: "00000000-0000-4000-8000-000000000013",
  refinedPrompt: "Explain the trade-off and include one example.",
  refinerVersion: "suggest-v1",
  inputScope: "current_user_turn_text_only",
  scopeId: scope.scopeId,
  epoch: scope.epoch,
  clientRequestId: "00000000-0000-4000-8000-000000000014",
};

test("proposal requests contain only a durable scope and draft revision", () => {
  const request = promptRefinerProductProposalRequestSchema.parse({
    conversationId: "cmuers9ox00mj02nzy05rg9ld",
    scopeId: scope.scopeId,
    epoch: scope.epoch,
    draftRevision: 3,
  });
  assert.deepEqual(Object.keys(request).sort(), [
    "conversationId",
    "draftRevision",
    "epoch",
    "scopeId",
  ]);
  assert.throws(() => promptRefinerProductProposalRequestSchema.parse({
    ...request,
    prompt: "browser supplied source",
  }));
  assert.throws(() => promptRefinerProductProposalRequestSchema.parse({
    ...request,
    accepted: true,
  }));
});

test("auto preparation accepts only the initiating scope and server decision", () => {
  const prepared = parsePromptRefinerProductAutoPrepare({
    outcome: "auto_held",
    decision: {
      suggestionId: response.suggestionId,
      scopeId: scope.scopeId,
      epoch: scope.epoch,
      decision: "accepted",
    },
    clientRequestId: response.clientRequestId,
  }, scope);
  assert.equal(prepared?.outcome, "auto_held");
  assert.equal(parsePromptRefinerProductAutoPrepare({
    outcome: "auto_held",
    decision: {
      suggestionId: response.suggestionId,
      scopeId: scope.scopeId,
      epoch: scope.epoch + 1,
      decision: "accepted",
    },
    clientRequestId: response.clientRequestId,
  }, scope), null);
  assert.equal(parsePromptRefinerProductAutoPrepare({
    outcome: "auto_held",
    decision: {
      suggestionId: response.suggestionId,
      scopeId: scope.scopeId,
      epoch: scope.epoch,
      decision: "accepted",
    },
    clientRequestId: response.clientRequestId,
    refinedPrompt: "browser-visible execution bytes are forbidden here",
  }, scope), null);
  assert.deepEqual(parsePromptRefinerProductAutoPrepare({
    outcome: "original_fallback",
    reason: "budget_exhausted",
  }, scope), {
    outcome: "original_fallback",
    reason: "budget_exhausted",
  });
});

test("execution headers are paired content-free observations", () => {
  const headers = new Headers({
    "X-Prompt-Refiner-Execution": "applied",
    "X-Prompt-Refiner-Mode": "auto",
  });
  assert.deepEqual(parsePromptRefinerExecutionHeaders(headers), {
    execution: "applied",
    mode: "auto",
  });
  headers.delete("X-Prompt-Refiner-Mode");
  assert.equal(parsePromptRefinerExecutionHeaders(headers), null);
  assert.equal(parsePromptRefinerExecutionHeaders(new Headers({
    "X-Prompt-Refiner-Execution": "accepted",
    "X-Prompt-Refiner-Mode": "explicit",
  })), null);
});

test("a held decision disables automatic Chat recovery replay", () => {
  const decision = {
    suggestionId: response.suggestionId,
    scopeId: scope.scopeId,
    epoch: scope.epoch,
    decision: "accepted" as const,
  };
  assert.equal(promptRefinerAllowsAutomaticChatRecovery(undefined), true);
  assert.equal(promptRefinerAllowsAutomaticChatRecovery(decision), false);
  assert.equal(promptRefinerAllowsAutomaticChatRecovery({
    ...decision,
    decision: "kept_original",
  }), false);
});

test("auto and explicit product turns keep authored whitespace", () => {
  assert.equal(promptRefinerAuthoredPromptForSend({
    rawPrompt: "  authored prompt\n",
    ordinaryPrompt: "authored prompt",
    productTurn: true,
  }), "  authored prompt\n");
  assert.equal(promptRefinerAuthoredPromptForSend({
    rawPrompt: "  ordinary prompt\n",
    ordinaryPrompt: "ordinary prompt",
    productTurn: false,
  }), "ordinary prompt");
});

test("an exact durable draft generation reuses its held revision without ABA", () => {
  const draft = { text: "exact source", attachments: [] };
  assert.equal(reusablePreparedDraftRevision({
    revision: 4,
    persistedGeneration: 9,
    captureGeneration: 9,
    capturedDraft: draft,
    currentDraft: draft,
  }), 4);
  assert.equal(reusablePreparedDraftRevision({
    revision: 5,
    persistedGeneration: 10,
    captureGeneration: 9,
    capturedDraft: draft,
    currentDraft: draft,
  }), null);
  assert.equal(reusablePreparedDraftRevision({
    revision: 4,
    persistedGeneration: 9,
    captureGeneration: 9,
    capturedDraft: draft,
    currentDraft: { text: "edited source", attachments: [] },
  }), null);
});

test("a bound response preserves the local authored source for display only", () => {
  const parsed = parsePromptRefinerProductProposal({
    value: response,
    expectedScope: scope,
    sourcePrompt: "compare these options",
  });
  assert.equal(parsed?.outcome, "ready");
  if (!parsed || parsed.outcome !== "ready") return;
  assert.equal(parsed.proposal.suggestion.sourcePrompt, "compare these options");
  assert.equal(parsed.proposal.clientRequestId, response.clientRequestId);
  assert.deepEqual(promptRefinerChatDecision(parsed.proposal, "accepted"), {
    suggestionId: response.suggestionId,
    scopeId: scope.scopeId,
    epoch: scope.epoch,
    decision: "accepted",
  });
});

test("explicit send retains exact authorship and rejects stale scope or attachments", () => {
  const sourcePrompt = "  compare café and 카페  \n";
  const parsed = parsePromptRefinerProductProposal({
    value: response,
    expectedScope: scope,
    sourcePrompt,
  });
  assert.equal(parsed?.outcome, "ready");
  if (!parsed || parsed.outcome !== "ready") return;
  const resolution = resolvePromptRefinerDecision({
    suggestion: parsed.proposal.suggestion,
    currentPrompt: sourcePrompt,
    decision: "accepted",
  });
  const decision = promptRefinerChatDecision(parsed.proposal, "accepted");
  assert.deepEqual(resolvePromptRefinerExplicitSend({
    proposal: parsed.proposal,
    resolution,
    decision,
    currentScope: scope,
    currentPrompt: sourcePrompt,
    boundAttachmentKey: "attachment:a",
    currentAttachmentKey: "attachment:a",
  }), {
    authoredPrompt: sourcePrompt,
    decision,
    clientRequestId: response.clientRequestId,
  });
  assert.equal(resolvePromptRefinerExplicitSend({
    proposal: parsed.proposal,
    resolution,
    decision,
    currentScope: { ...scope, epoch: scope.epoch + 1 },
    currentPrompt: sourcePrompt,
    boundAttachmentKey: "attachment:a",
    currentAttachmentKey: "attachment:a",
  }), null);
  assert.equal(resolvePromptRefinerExplicitSend({
    proposal: parsed.proposal,
    resolution,
    decision,
    currentScope: scope,
    currentPrompt: sourcePrompt,
    boundAttachmentKey: "attachment:a",
    currentAttachmentKey: "attachment:b",
  }), null);
  const keptResolution = resolvePromptRefinerDecision({
    suggestion: parsed.proposal.suggestion,
    currentPrompt: sourcePrompt,
    decision: "kept_original",
  });
  const keptDecision = promptRefinerChatDecision(
    parsed.proposal,
    "kept_original"
  );
  assert.deepEqual(resolvePromptRefinerExplicitSend({
    proposal: parsed.proposal,
    resolution: keptResolution,
    decision: keptDecision,
    currentScope: scope,
    currentPrompt: sourcePrompt,
    boundAttachmentKey: "attachment:a",
    currentAttachmentKey: "attachment:a",
  }), {
    authoredPrompt: sourcePrompt,
    decision: keptDecision,
    clientRequestId: response.clientRequestId,
  });
});

test("scope ABA, extra fields, and malformed server ids fail closed", () => {
  assert.equal(parsePromptRefinerProductProposal({
    value: response,
    expectedScope: { ...scope, epoch: scope.epoch + 2 },
    sourcePrompt: "compare these options",
  }), null);
  assert.equal(parsePromptRefinerProductProposal({
    value: { ...response, provider: "hidden-provider" },
    expectedScope: scope,
    sourcePrompt: "compare these options",
  }), null);
  assert.equal(parsePromptRefinerProductProposal({
    value: { ...response, clientRequestId: "not-a-uuid" },
    expectedScope: scope,
    sourcePrompt: "compare these options",
  }), null);
});

test("closed fallback reasons return to the original without a decision", () => {
  assert.deepEqual(parsePromptRefinerProductProposal({
    value: {
      code: "PROMPT_REFINER_FALLBACK_ORIGINAL",
      reason: "budget_exhausted",
    },
    expectedScope: scope,
    sourcePrompt: "original",
  }), {
    outcome: "fallback_original",
    reason: "budget_exhausted",
  });
  assert.equal(parsePromptRefinerProductProposal({
    value: {
      code: "PROMPT_REFINER_FALLBACK_ORIGINAL",
      reason: "invented",
    },
    expectedScope: scope,
    sourcePrompt: "original",
  }), null);
});
