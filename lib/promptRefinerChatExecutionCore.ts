import { z } from "zod";
import { scopedMessageId } from "@/lib/messageRequestIdentity";

import {
  projectPromptRefinerChatHandoff,
  promptRefinerAutoMessageView,
  type PromptRefinerChatMessage,
} from "@/lib/promptRefinerChatHandoff";
import {
  bindPromptRefinerSuggestion,
  resolvePromptRefinerDecision,
} from "@/lib/promptRefinerSuggestion";

// A browser may name an offered decision, never supply the execution text.
export const promptRefinerChatDecisionSchema = z.object({
  suggestionId: z.string().uuid(),
  scopeId: z.string().uuid(),
  epoch: z.number().int().positive().max(2_147_483_647),
  decision: z.enum(["accepted", "kept_original"]),
}).strict();
export type PromptRefinerChatDecision = z.infer<typeof promptRefinerChatDecisionSchema>;

export class PromptRefinerChatExecutionError extends Error {
  readonly status = 409;
  readonly code = "PROMPT_REFINER_DECISION_UNAVAILABLE";
  constructor() {
    super("The Prompt Refiner decision is no longer available.");
    this.name = "PromptRefinerChatExecutionError";
  }
}

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
  const refuse = (): never => { throw new PromptRefinerChatExecutionError(); };
  const choice = promptRefinerChatDecisionSchema.safeParse(input.decision);
  const { held, facts } = input;
  const latest = input.messages.at(-1);
  if (!choice.success || held.state !== "ready" || facts.killSwitch ||
      !Number.isFinite(facts.dbNow.getTime()) || !Number.isFinite(held.expiresAt.getTime()) ||
      facts.dbNow >= held.expiresAt || held.userId !== facts.userId ||
      held.conversationId !== facts.conversationId ||
      facts.scope.conversationId !== facts.conversationId ||
      held.scopeId !== facts.scope.id || held.scopeEpoch !== facts.scope.epoch ||
      held.surface !== facts.scope.surface || held.recoveryEpoch !== facts.recoveryEpoch ||
      choice.data.scopeId !== held.scopeId || choice.data.epoch !== held.scopeEpoch ||
      choice.data.suggestionId !== held.id ||
      held.sourceMessageId !== facts.sourceMessageId ||
      held.sourcePrompt !== facts.persistedSourcePrompt ||
      !latest?.id || (latest.id !== facts.sourceMessageId &&
        scopedMessageId(facts.conversationId, latest.id) !== facts.sourceMessageId) || latest.role !== "user" ||
      latest.content !== held.sourcePrompt) return refuse();
  // An explicit accepted boolean cannot promote a stored automatic-mode result.
  // Auto has a distinct server release authority and is default-off.
  if (!["explicit", "auto"].includes(held.mode) ||
    (held.mode === "auto" ? !facts.autoEnabled || !facts.autoConversation : !facts.explicitEnabled)) {
    return refuse();
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
    if (!suggestion) return refuse();
    const scope = { identityKey: facts.userId, mountedSurface: held.surface, conversationId: facts.conversationId };
    const resolution = resolvePromptRefinerDecision({ suggestion, currentPrompt: facts.persistedSourcePrompt,
      decision: choice.data.decision });
    const projection = projectPromptRefinerChatHandoff({ messages: input.messages,
      sourceMessageId: latest.id, serverSuggestion: suggestion,
      boundScope: scope, currentScope: scope, decision: choice.data.decision, suppliedResolution: resolution });
    const executionMessages = promptRefinerAutoMessageView({ authoredMessages: input.messages, projection, currentScope: scope });
    return { authoredMessages: input.messages, executionMessages, provenance: projection.provenance };
  } catch {
    return refuse();
  }
}
