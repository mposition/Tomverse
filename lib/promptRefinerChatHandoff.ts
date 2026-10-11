import { z } from "zod";

import {
  PROMPT_REFINER_INPUT_SCOPE,
  resolvePromptRefinerDecision,
  type BoundPromptRefinerSuggestion,
  type PromptRefinerDecision,
  type PromptRefinerResolution,
} from "@/lib/promptRefinerSuggestion";

/**
 * The already-parsed Chat transcript shape this projection needs. It neither
 * parses the public request nor widens the Chat payload contract.
 */
export type PromptRefinerChatMessage = Readonly<{
  id?: string;
  role: "user" | "assistant";
  content: string;
  attachments?: readonly unknown[];
}>;

export type PromptRefinerExecutionMessage<
  Message extends PromptRefinerChatMessage,
> = Omit<Message, "content"> & Readonly<{ content: string }>;

/** The scope facts a future server caller must resolve, not browser claims. */
export type PromptRefinerChatScope = Readonly<{
  identityKey: string | null;
  mountedSurface: string;
  conversationId: string | null;
}>;

export const PROMPT_REFINER_CHAT_PROJECTION_ERROR_CODES = [
  "prompt_refiner_chat_scope_invalid",
  "prompt_refiner_chat_scope_stale",
  "prompt_refiner_chat_source_id_invalid",
  "prompt_refiner_chat_message_id_duplicate",
  "prompt_refiner_chat_source_message_missing",
  "prompt_refiner_chat_source_message_not_current_user",
  "prompt_refiner_chat_decision_invalid",
  "prompt_refiner_chat_server_suggestion_invalid",
  "prompt_refiner_chat_draft_stale",
  "prompt_refiner_chat_resolution_invalid",
  "prompt_refiner_chat_resolution_forged",
  "prompt_refiner_chat_projection_untrusted",
] as const;

export type PromptRefinerChatProjectionErrorCode =
  (typeof PROMPT_REFINER_CHAT_PROJECTION_ERROR_CODES)[number];

/** Fixed, content-free failures for a future server caller to classify. */
export class PromptRefinerChatProjectionError extends Error {
  constructor(readonly code: PromptRefinerChatProjectionErrorCode) {
    super(code);
    this.name = "PromptRefinerChatProjectionError";
  }
}

const fail = (code: PromptRefinerChatProjectionErrorCode): never => {
  throw new PromptRefinerChatProjectionError(code);
};

const scopeSchema = z
  .object({
    identityKey: z.string().nullable(),
    mountedSurface: z.string(),
    conversationId: z.string().nullable(),
  })
  .strict();

/*
 * Bounds are re-established by resolvePromptRefinerDecision() from the
 * server-held suggestion. This strict schema only admits the exact supplied
 * resolution shape before every value is compared byte-for-byte.
 */
const suppliedResolutionSchema = z
  .object({
    decision: z.enum(["accepted", "kept_original"]),
    displayPrompt: z.string(),
    persistedUserPrompt: z.string(),
    executionPrompt: z.string(),
    provenance: z
      .object({
        requestId: z.string(),
        suggestionId: z.string(),
        refinerVersion: z.string(),
        inputScope: z.literal(PROMPT_REFINER_INPUT_SCOPE),
        decision: z.enum(["accepted", "kept_original"]),
      })
      .strict(),
  })
  .strict();

const sameScope = (
  left: PromptRefinerChatScope,
  right: PromptRefinerChatScope
) =>
  left.identityKey === right.identityKey &&
  left.mountedSurface === right.mountedSurface &&
  left.conversationId === right.conversationId;

const sameResolution = (
  supplied: PromptRefinerResolution,
  expected: PromptRefinerResolution
) =>
  supplied.decision === expected.decision &&
  supplied.displayPrompt === expected.displayPrompt &&
  supplied.persistedUserPrompt === expected.persistedUserPrompt &&
  supplied.executionPrompt === expected.executionPrompt &&
  supplied.provenance.requestId === expected.provenance.requestId &&
  supplied.provenance.suggestionId === expected.provenance.suggestionId &&
  supplied.provenance.refinerVersion === expected.provenance.refinerVersion &&
  supplied.provenance.inputScope === expected.provenance.inputScope &&
  supplied.provenance.decision === expected.provenance.decision;

export type PromptRefinerChatProjectionProvenance = Readonly<{
  sourceMessageId: string;
  requestId: string;
  suggestionId: string;
  refinerVersion: string;
  inputScope: typeof PROMPT_REFINER_INPUT_SCOPE;
  decision: PromptRefinerDecision;
}>;

export type PromptRefinerChatProjection<
  Message extends PromptRefinerChatMessage,
> = Readonly<{
  /** The exact input array and message objects. Durable authorship reads this. */
  authoredMessages: readonly Message[];
  /**
   * The same transcript with only the exact current user's content changed on
   * acceptance. Other message and attachment references remain unchanged.
   */
  executionMessages: readonly PromptRefinerExecutionMessage<Message>[];
  /** Ephemeral validated handoff facts, not an execution or disposition receipt. */
  provenance: PromptRefinerChatProjectionProvenance;
}>;

// A routing view must come from the exact local projection call, not from a
// structurally similar object supplied by a browser or another call site.
// This does not prove that serverSuggestion was server-held or consumed.
const localProjections = new WeakMap<
  object,
  Readonly<{
    scope: PromptRefinerChatScope;
    sourceIndex: number;
    authoredSnapshot: string;
    executionPrompt: string;
  }>
>();

const transcriptSnapshot = (
  messages: readonly PromptRefinerChatMessage[]
): string => {
  try {
    const snapshot = JSON.stringify(messages);
    if (typeof snapshot === "string") return snapshot;
  } catch {
    // A non-JSON transcript cannot be used as an Auto routing view.
  }
  return fail("prompt_refiner_chat_projection_untrusted");
};

/**
 * Selects the text view for both Auto Router and shadow profiling. With no
 * server-validated handoff the only possible view is the authored transcript.
 * A future product caller must separately establish server-held suggestion
 * provenance, one-time consumption, scope lifetime and rollout permission.
 */
export function promptRefinerAutoMessageView<
  Message extends PromptRefinerChatMessage,
>(input: {
  authoredMessages: readonly Message[];
  projection?: PromptRefinerChatProjection<Message> | null;
  currentScope?: PromptRefinerChatScope;
}): readonly PromptRefinerExecutionMessage<Message>[] {
  if (input.projection == null) return input.authoredMessages;
  const binding = localProjections.get(input.projection);
  if (
    !binding ||
    input.projection.authoredMessages !== input.authoredMessages
  ) {
    return fail("prompt_refiner_chat_projection_untrusted");
  }
  const currentScope = scopeSchema.safeParse(input.currentScope);
  if (!currentScope.success) return fail("prompt_refiner_chat_scope_invalid");
  if (!sameScope(binding.scope, currentScope.data)) {
    return fail("prompt_refiner_chat_scope_stale");
  }
  if (transcriptSnapshot(input.authoredMessages) !== binding.authoredSnapshot) {
    return fail("prompt_refiner_chat_draft_stale");
  }
  const source = input.authoredMessages[binding.sourceIndex];
  if (!source || source.role !== "user") {
    return fail("prompt_refiner_chat_draft_stale");
  }
  if (binding.executionPrompt === source.content) return input.authoredMessages;
  // Never hand an Auto caller the mutable executionMessages on the supplied
  // projection. Reconstruct only the validated current user's content.
  return input.authoredMessages.map((message, index) =>
    index === binding.sourceIndex
      ? { ...message, content: binding.executionPrompt }
      : message
  );
}

/**
 * Purely projects one already-parsed transcript into authorship and execution
 * views. `serverSuggestion` must come from server-held state; this function
 * cannot prove its storage origin, authenticate a caller, authorise execution,
 * or consume a suggestion. The three-field scope also cannot detect a
 * same-value ABA; a future caller must own a server-side lifetime/epoch and
 * provide all of those boundaries.
 */
export function projectPromptRefinerChatHandoff<
  Message extends PromptRefinerChatMessage,
>(input: {
  messages: readonly Message[];
  sourceMessageId: string;
  serverSuggestion: BoundPromptRefinerSuggestion;
  boundScope: PromptRefinerChatScope;
  currentScope: PromptRefinerChatScope;
  decision: PromptRefinerDecision;
  suppliedResolution: PromptRefinerResolution;
}): PromptRefinerChatProjection<Message> {
  let boundScope: PromptRefinerChatScope;
  let currentScope: PromptRefinerChatScope;
  try {
    boundScope = scopeSchema.parse(input.boundScope);
    currentScope = scopeSchema.parse(input.currentScope);
  } catch {
    return fail("prompt_refiner_chat_scope_invalid");
  }
  if (!sameScope(boundScope, currentScope)) {
    return fail("prompt_refiner_chat_scope_stale");
  }

  if (
    typeof input.sourceMessageId !== "string" ||
    input.sourceMessageId.length === 0
  ) {
    return fail("prompt_refiner_chat_source_id_invalid");
  }

  const seenIds = new Set<string>();
  let sourceIndex = -1;
  let latestUserIndex = -1;
  for (const [index, message] of input.messages.entries()) {
    if (message.id !== undefined) {
      if (seenIds.has(message.id)) {
        return fail("prompt_refiner_chat_message_id_duplicate");
      }
      seenIds.add(message.id);
      if (message.id === input.sourceMessageId) sourceIndex = index;
    }
    if (message.role === "user") latestUserIndex = index;
  }

  if (sourceIndex < 0) {
    return fail("prompt_refiner_chat_source_message_missing");
  }
  if (
    sourceIndex !== latestUserIndex ||
    input.messages[sourceIndex]?.role !== "user"
  ) {
    return fail("prompt_refiner_chat_source_message_not_current_user");
  }

  if (input.decision !== "accepted" && input.decision !== "kept_original") {
    return fail("prompt_refiner_chat_decision_invalid");
  }

  const sourceMessage = input.messages[sourceIndex];
  let expected: PromptRefinerResolution;
  try {
    expected = resolvePromptRefinerDecision({
      suggestion: input.serverSuggestion,
      currentPrompt: sourceMessage.content,
      decision: input.decision,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "prompt_refiner_decision_stale"
    ) {
      return fail("prompt_refiner_chat_draft_stale");
    }
    return fail("prompt_refiner_chat_server_suggestion_invalid");
  }

  let supplied: PromptRefinerResolution;
  try {
    supplied = suppliedResolutionSchema.parse(input.suppliedResolution);
  } catch {
    return fail("prompt_refiner_chat_resolution_invalid");
  }
  if (!sameResolution(supplied, expected)) {
    return fail("prompt_refiner_chat_resolution_forged");
  }

  const executionMessages =
    expected.executionPrompt === sourceMessage.content
      ? input.messages
      : input.messages.map((message, index) =>
          index === sourceIndex
            ? { ...message, content: expected.executionPrompt }
            : message
        );

  const projection = {
    authoredMessages: input.messages,
    executionMessages: executionMessages as readonly PromptRefinerExecutionMessage<Message>[],
    provenance: {
      sourceMessageId: input.sourceMessageId,
      requestId: expected.provenance.requestId,
      suggestionId: expected.provenance.suggestionId,
      refinerVersion: expected.provenance.refinerVersion,
      inputScope: expected.provenance.inputScope,
      decision: expected.decision,
    },
  };
  localProjections.set(projection, {
    scope: boundScope,
    sourceIndex,
    authoredSnapshot: transcriptSnapshot(input.messages),
    executionPrompt: expected.executionPrompt,
  });
  return projection;
}
