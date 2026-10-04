import { z } from "zod";

export const PROMPT_REFINER_INPUT_SCOPE = "current_user_turn_text_only" as const;
export const PROMPT_REFINER_VERSION = "suggest-v1" as const;
export const PROMPT_REFINER_MAX_PROMPT_CHARS = 16_000;
export const PROMPT_REFINER_MAX_PROMPT_BYTES = 32 * 1024;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const promptText = z
  .string()
  .min(1)
  .max(PROMPT_REFINER_MAX_PROMPT_CHARS)
  .refine((value) => value.trim().length > 0, "prompt_refiner_prompt_empty")
  .refine(
    (value) => utf8Bytes(value) <= PROMPT_REFINER_MAX_PROMPT_BYTES,
    "prompt_refiner_prompt_too_large"
  );
const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
// Contract-owned prompt version, never a provider or model identifier.
const version = z.string().regex(/^suggest-v[1-9][0-9]{0,3}$/);

/**
 * The whole public request. Strictness is the data-minimisation boundary:
 * history, attachments, Memory, profile knowledge and model ids cannot be
 * smuggled into the Refiner simply because another Chat caller already has
 * them in memory.
 */
export const promptRefinerRequestSchema = z
  .object({
    requestId: opaqueId,
    prompt: promptText,
  })
  .strict();

/** The browser receives no provider or model identity for the Refiner. */
export const promptRefinerResponseSchema = z
  .object({
    requestId: opaqueId,
    suggestionId: opaqueId,
    refinedPrompt: promptText,
    refinerVersion: version,
    inputScope: z.literal(PROMPT_REFINER_INPUT_SCOPE),
  })
  .strict();

export type PromptRefinerRequest = z.infer<typeof promptRefinerRequestSchema>;
export type PromptRefinerResponse = z.infer<typeof promptRefinerResponseSchema>;

export type PromptRefinerPromptProblem =
  | "empty"
  | "too_many_characters"
  | "too_many_bytes";

/** Uses the same bounds as the request schema at the point the UI offers it. */
export function promptRefinerPromptProblem(
  prompt: string
): PromptRefinerPromptProblem | null {
  if (prompt.trim().length === 0) return "empty";
  if (prompt.length > PROMPT_REFINER_MAX_PROMPT_CHARS) {
    return "too_many_characters";
  }
  if (utf8Bytes(prompt) > PROMPT_REFINER_MAX_PROMPT_BYTES) {
    return "too_many_bytes";
  }
  return null;
}

export type BoundPromptRefinerSuggestion = PromptRefinerResponse & {
  /** The exact draft bytes for which the request was made. Browser-local. */
  sourcePrompt: string;
};

export type PromptRefinerUiState =
  | { status: "idle" }
  | { status: "requesting"; request: PromptRefinerRequest }
  | { status: "ready"; suggestion: BoundPromptRefinerSuggestion }
  | { status: "accepted_preview"; suggestion: BoundPromptRefinerSuggestion }
  | { status: "failed"; request: PromptRefinerRequest; failureCode: string };

const promptRefinerDecisionSchema = z.enum(["accepted", "kept_original"]);
export type PromptRefinerDecision = z.infer<typeof promptRefinerDecisionSchema>;

export type PromptRefinerResolution = {
  decision: PromptRefinerDecision;
  /** What remains visible in the composer after the decision. */
  displayPrompt: string;
  /** The user's authored bytes. This is the text the Message row must keep. */
  persistedUserPrompt: string;
  /** The text later Router and provider stages may read. */
  executionPrompt: string;
  provenance: {
    requestId: string;
    suggestionId: string;
    refinerVersion: string;
    inputScope: typeof PROMPT_REFINER_INPUT_SCOPE;
    decision: PromptRefinerDecision;
  };
};

/** Browser-local fixture identity; never a provider/model input or receipt. */
export type PromptRefinerDraftScope = Readonly<{
  identityKey: string | null;
  mountedSurface: string;
  conversationId: string | null;
}>;

const promptRefinerResolutionSchema = z
  .object({
    decision: promptRefinerDecisionSchema,
    displayPrompt: promptText,
    persistedUserPrompt: promptText,
    executionPrompt: promptText,
    provenance: z
      .object({
        requestId: opaqueId,
        suggestionId: opaqueId,
        refinerVersion: version,
        inputScope: z.literal(PROMPT_REFINER_INPUT_SCOPE),
        decision: promptRefinerDecisionSchema,
      })
      .strict(),
  })
  .strict();

/**
 * Fixture-only, pure handoff check. This is not server authorization: it
 * validates one UI decision against the still-ready suggestion, exact draft
 * and structured browser scope before the fixture owner records it. The
 * caller owns the consumed-key set and must add the returned key synchronously
 * before any other action, so a second event cannot reuse the same decision.
 */
export function validatePromptRefinerFixtureHandoff(input: {
  readySuggestion: BoundPromptRefinerSuggestion;
  resolution: PromptRefinerResolution;
  readyScope: PromptRefinerDraftScope;
  currentScope: PromptRefinerDraftScope;
  currentDraft: string;
  consumedKeys: ReadonlySet<string>;
}): { resolution: PromptRefinerResolution; consumptionKey: string } {
  const { readyScope, currentScope } = input;
  if (
    readyScope.identityKey !== currentScope.identityKey ||
    readyScope.mountedSurface !== currentScope.mountedSurface ||
    readyScope.conversationId !== currentScope.conversationId
  ) {
    throw new Error("prompt_refiner_handoff_scope_stale");
  }
  const { sourcePrompt, ...response } = input.readySuggestion;
  const suggestion = {
    ...promptRefinerResponseSchema.parse(response),
    sourcePrompt: promptText.parse(sourcePrompt),
  };
  if (input.currentDraft !== suggestion.sourcePrompt) {
    throw new Error("prompt_refiner_handoff_draft_stale");
  }
  const consumptionKey = JSON.stringify([
    readyScope.identityKey,
    readyScope.mountedSurface,
    readyScope.conversationId,
    suggestion.requestId,
    suggestion.suggestionId,
  ]);
  if (input.consumedKeys.has(consumptionKey)) {
    throw new Error("prompt_refiner_handoff_duplicate");
  }
  const supplied = promptRefinerResolutionSchema.parse(input.resolution);
  const expected = resolvePromptRefinerFixtureDecision({
    suggestion,
    currentPrompt: input.currentDraft,
    decision: supplied.decision,
  });
  if (
    supplied.displayPrompt !== expected.displayPrompt ||
    supplied.persistedUserPrompt !== expected.persistedUserPrompt ||
    supplied.executionPrompt !== expected.executionPrompt ||
    supplied.provenance.requestId !== expected.provenance.requestId ||
    supplied.provenance.suggestionId !== expected.provenance.suggestionId ||
    supplied.provenance.refinerVersion !== expected.provenance.refinerVersion ||
    supplied.provenance.decision !== expected.provenance.decision
  ) {
    throw new Error("prompt_refiner_handoff_forged");
  }
  return { resolution: expected, consumptionKey };
}

const sourceOf = (state: PromptRefinerUiState): string | null => {
  if (state.status === "idle") return null;
  return state.status === "ready" || state.status === "accepted_preview"
    ? state.suggestion.sourcePrompt
    : state.request.prompt;
};

/**
 * A request belongs to one exact draft snapshot. Typing, voice input, paste,
 * attachment-driven edits or a conversation switch make it stale rather than
 * allowing a late response to replace new user work.
 */
export function visiblePromptRefinerState(
  state: PromptRefinerUiState,
  currentPrompt: string
): PromptRefinerUiState | null {
  const sourcePrompt = sourceOf(state);
  return sourcePrompt === null || sourcePrompt === currentPrompt ? state : null;
}

/** Binds a server response to the exact request and still-current draft. */
export function bindPromptRefinerSuggestion(input: {
  request: PromptRefinerRequest;
  response: PromptRefinerResponse;
  currentPrompt: string;
}): BoundPromptRefinerSuggestion | null {
  const request = promptRefinerRequestSchema.parse(input.request);
  const response = promptRefinerResponseSchema.parse(input.response);
  if (response.requestId !== request.requestId) {
    throw new Error("prompt_refiner_response_request_mismatch");
  }
  if (input.currentPrompt !== request.prompt) return null;
  if (response.refinedPrompt.trim() === request.prompt.trim()) {
    throw new Error("prompt_refiner_response_no_change");
  }
  return { ...response, sourcePrompt: request.prompt };
}

/**
 * Resolves the product pre-send choice without overwriting authorship. The
 * accepted wording is visible in the composer, while the durable user Message
 * keeps the original and downstream execution receives the refined form.
 */
export function resolvePromptRefinerDecision(input: {
  suggestion: BoundPromptRefinerSuggestion;
  currentPrompt: string;
  decision: PromptRefinerDecision;
}): PromptRefinerResolution {
  const decision = promptRefinerDecisionSchema.parse(input.decision);
  const { sourcePrompt: rawSourcePrompt, ...publicResponse } = input.suggestion;
  const suggestion = {
    ...promptRefinerResponseSchema.parse(publicResponse),
    sourcePrompt: promptText.parse(rawSourcePrompt),
  };
  if (input.currentPrompt !== suggestion.sourcePrompt) {
    throw new Error("prompt_refiner_decision_stale");
  }
  const executionPrompt =
    decision === "accepted"
      ? suggestion.refinedPrompt
      : suggestion.sourcePrompt;
  return {
    decision,
    displayPrompt: executionPrompt,
    persistedUserPrompt: suggestion.sourcePrompt,
    executionPrompt,
    provenance: {
      requestId: suggestion.requestId,
      suggestionId: suggestion.suggestionId,
      refinerVersion: suggestion.refinerVersion,
      inputScope: suggestion.inputScope,
      decision,
    },
  };
}

/**
 * The fixture has no product handoff: accepted text is a read-only preview,
 * never a composer/durable-draft update. Keep this separate from the product
 * resolution so a later product caller can obey displayPrompt staleness.
 */
export function resolvePromptRefinerFixtureDecision(
  input: Parameters<typeof resolvePromptRefinerDecision>[0]
): PromptRefinerResolution {
  const resolution = resolvePromptRefinerDecision(input);
  return { ...resolution, displayPrompt: resolution.persistedUserPrompt };
}
