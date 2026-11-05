import { scopedMessageId } from "@/lib/messageRequestIdentity";

import {
  projectPromptRefinerChatHandoff,
  promptRefinerAutoMessageView,
  type PromptRefinerChatMessage,
} from "@/lib/promptRefinerChatHandoff";
import {
  bindPromptRefinerSuggestion,
  promptRefinerChatDecisionSchema,
  resolvePromptRefinerDecision,
} from "@/lib/promptRefinerSuggestion";

export { promptRefinerChatDecisionSchema } from "@/lib/promptRefinerSuggestion";
export type { PromptRefinerChatDecision } from "@/lib/promptRefinerSuggestion";

/**
 * Why a held decision was refused, for the operator's log line only. Every one
 * answers the client identically, and no value carries content.
 */
export const PROMPT_REFINER_REFUSAL_REASONS = [
  "malformed_decision", "not_found", "consumed", "stale", "expired", "kill_switch",
  "guard_paused", "owner_mismatch", "scope_mismatch", "epoch_mismatch", "decision_mismatch",
  "source_mismatch", "mode_disabled", "request_incomplete", "pinned_deployment",
  "preview_changed", "consume_lost", "receipt_mismatch", "internal",
] as const;
export type PromptRefinerRefusalReason = (typeof PROMPT_REFINER_REFUSAL_REASONS)[number];

export class PromptRefinerChatExecutionError extends Error {
  readonly status = 409;
  readonly code = "PROMPT_REFINER_DECISION_UNAVAILABLE";
  constructor(readonly reason: PromptRefinerRefusalReason = "internal") {
    super("The Prompt Refiner decision is no longer available.");
    this.name = "PromptRefinerChatExecutionError";
  }
}

/** The reason on a refusal; anything else that ended the decision is `internal`. */
export const promptRefinerRefusalReasonOf = (error: unknown): PromptRefinerRefusalReason =>
  error instanceof PromptRefinerChatExecutionError ? error.reason : "internal";

export type PromptRefinerHeldChatSuggestion = Readonly<{
  id: string;
  userId: string;
  conversationId: string;
  surface: "chat" | "workspace";
  scopeId: string;
  scopeEpoch: number;
  recoveryEpoch: number;
  sourceMessageId: string;
  sourcePrompt: string;
  refinedPrompt: string;
  requestId: string;
  refinerVersion: string;
  mode: "explicit" | "auto";
  state: "ready" | "consumed" | "stale";
  expiresAt: Date;
}>;

/** All facts here are read by the store under its row locks, not from a body. */
export type PromptRefinerChatExecutionFacts = Readonly<{
  userId: string;
  conversationId: string;
  sourceMessageId: string;
  persistedSourcePrompt: string;
  recoveryEpoch: number;
  scope: Readonly<{ id: string; epoch: number; surface: "chat" | "workspace"; conversationId: string }>;
  dbNow: Date;
  explicitEnabled: boolean;
  autoEnabled: boolean;
  autoConversation: boolean;
  killSwitch: boolean;
}>;

/** Validate first; the transaction must consume once before returning this view. */
export function validatePromptRefinerChatExecution<Message extends PromptRefinerChatMessage>(input: {
  messages: readonly Message[];
  decision: unknown;
  held: PromptRefinerHeldChatSuggestion;
  facts: PromptRefinerChatExecutionFacts;
}) {
  const refuse = (reason: PromptRefinerRefusalReason): never => {
    throw new PromptRefinerChatExecutionError(reason);
  };
  const choice = promptRefinerChatDecisionSchema.safeParse(input.decision);
  const { held, facts } = input;
  const latest = input.messages.at(-1);
  if (!choice.success) return refuse("malformed_decision");
  if (held.state !== "ready") return refuse(held.state === "consumed" ? "consumed" : "stale");
  if (facts.killSwitch) return refuse("kill_switch");
  if (!Number.isFinite(facts.dbNow.getTime()) || !Number.isFinite(held.expiresAt.getTime()) ||
      facts.dbNow >= held.expiresAt) return refuse("expired");
  if (held.userId !== facts.userId || held.conversationId !== facts.conversationId ||
      facts.scope.conversationId !== facts.conversationId) return refuse("owner_mismatch");
  if (held.scopeId !== facts.scope.id || held.surface !== facts.scope.surface ||
      choice.data.scopeId !== held.scopeId) return refuse("scope_mismatch");
  if (held.scopeEpoch !== facts.scope.epoch || held.recoveryEpoch !== facts.recoveryEpoch ||
      choice.data.epoch !== held.scopeEpoch) return refuse("epoch_mismatch");
  if (choice.data.suggestionId !== held.id) return refuse("decision_mismatch");
  if (held.sourceMessageId !== facts.sourceMessageId ||
      held.sourcePrompt !== facts.persistedSourcePrompt ||
      !latest?.id || (latest.id !== facts.sourceMessageId &&
        scopedMessageId(facts.conversationId, latest.id) !== facts.sourceMessageId) || latest.role !== "user" ||
      latest.content !== held.sourcePrompt) return refuse("source_mismatch");
  // An explicit accepted boolean cannot promote a stored automatic-mode result.
  // Auto has a distinct server release authority and is default-off.
  if (!["explicit", "auto"].includes(held.mode) ||
    (held.mode === "auto" ? !facts.autoEnabled || !facts.autoConversation : !facts.explicitEnabled)) {
    return refuse("mode_disabled");
  }
  try {
    const suggestion = bindPromptRefinerSuggestion({
      request: { requestId: held.requestId, prompt: held.sourcePrompt },
      response: {
        requestId: held.requestId, suggestionId: held.id, refinedPrompt: held.refinedPrompt,
        refinerVersion: held.refinerVersion, inputScope: "current_user_turn_text_only",
      },
      currentPrompt: facts.persistedSourcePrompt,
    });
    if (!suggestion) return refuse("source_mismatch");
    const scope = { identityKey: facts.userId, mountedSurface: held.surface, conversationId: facts.conversationId };
    const resolution = resolvePromptRefinerDecision({ suggestion, currentPrompt: facts.persistedSourcePrompt,
      decision: choice.data.decision });
    const projection = projectPromptRefinerChatHandoff({ messages: input.messages,
      sourceMessageId: latest.id, serverSuggestion: suggestion,
      boundScope: scope, currentScope: scope, decision: choice.data.decision, suppliedResolution: resolution });
    const executionMessages = promptRefinerAutoMessageView({ authoredMessages: input.messages, projection, currentScope: scope });
    return { authoredMessages: input.messages, executionMessages,
      provenance: projection.provenance, mode: held.mode };
  } catch (error) {
    return refuse(promptRefinerRefusalReasonOf(error));
  }
}
