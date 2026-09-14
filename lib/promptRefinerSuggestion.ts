import { z } from "zod";

export const PROMPT_REFINER_INPUT_SCOPE = "current_user_turn_text_only" as const;
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

/**
 * An accepted resolution is valid only while the composer still holds the
 * exact display bytes produced by that decision. Any later edit makes the
 * caller discard it and treat the edited draft as newly authored input.
 */
export function isPromptRefinerResolutionCurrent(
  resolution: PromptRefinerResolution,
  currentPrompt: string
): boolean {
  return resolution.displayPrompt === currentPrompt;
}

const sourceOf = (state: PromptRefinerUiState): string | null => {
  if (state.status === "idle") return null;
  return state.status === "ready"
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
 * Resolves the pre-send choice without overwriting authorship. Even when the
 * proposal is accepted, the durable user Message remains the original text;
 * only downstream execution receives the refined form.
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
