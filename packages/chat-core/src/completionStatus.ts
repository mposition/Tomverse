// Whether an assistant answer actually finished, or merely stopped.
//
// A provider that hits its output-token ceiling still returns HTTP 200 with a
// body full of real text -- the only difference from a finished answer is the
// finish reason. Treating that as a normal completion is what leaves a user
// staring at a sentence that ends mid-word with no explanation. This decides
// the difference in one pure place so the streaming client, the persisted
// message and a later re-fetch all say the same thing.
//
// Deliberately narrow: `cancelled` (the user stopped it), a request that
// failed with no answer, and the empty-response path keep their existing
// meanings and are decided elsewhere. This only ever distinguishes "finished"
// from "stopped short": the answer ran out of room (`length`), or the
// provider's stream ended on an error part -- which the AI SDK does not throw
// from `textStream`, it resolves the finish reason as `error` -- or without
// its completion signal (`interrupted`), after real text had arrived.

/** Persisted in `Message.status` and mirrored in the client Message type. */
export type ChatCompletionStatus = "normal" | "incomplete";

/**
 * Why an answer is incomplete. Not persisted -- `Message.status` only says
 * `incomplete` -- so it reaches the browser in the stream trailer.
 */
export type ChatIncompleteReason = "length" | "interrupted";

/**
 * Unified finish reasons for a stream that ended on a failure rather than on
 * an answer: `error` (the provider sent an error part mid-stream) and
 * `interrupted` (the provider's stream ended without a completion signal).
 */
export const INTERRUPTED_FINISH_REASONS: ReadonlySet<string> = new Set([
  "error",
  "interrupted",
]);

export type ChatCompletionOutcome = {
  status: ChatCompletionStatus;
  incompleteReason?: ChatIncompleteReason;
};

/**
 * Provider-raw finish reasons that mean "output token limit reached".
 *
 * The AI SDK's unified `finishReason` already reports `length` for the
 * providers it maps, but the raw reason is checked too: a provider this app
 * reaches through the generic OpenAI-compatible adapter can report a limit
 * the unified mapper does not recognise, and misreporting that as a finished
 * answer is the failure this exists to prevent. Compared after normalization
 * (lower-cased, non-alphanumerics collapsed to `_`), so `MAX_TOKENS`,
 * `max-tokens` and `max_tokens` all match.
 */
export const LENGTH_RAW_FINISH_REASONS: ReadonlySet<string> = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "model_length",
  "output_limit_reached",
]);

const normalizeRawFinishReason = (rawFinishReason: string) =>
  rawFinishReason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export const isLengthRawFinishReason = (
  rawFinishReason: string | undefined | null
): boolean =>
  typeof rawFinishReason === "string" &&
  LENGTH_RAW_FINISH_REASONS.has(normalizeRawFinishReason(rawFinishReason));

/**
 * The completion status for one finished turn. `length` on either the
 * unified or the provider-raw reason means the answer was cut off at its
 * ceiling; an interrupted finish reason, or `streamFailed` (the finish
 * metadata itself was rejected), means the provider's stream broke off;
 * anything else is a normal completion. `length` wins when both apply.
 */
export const resolveChatCompletionOutcome = (args: {
  finishReason?: string | null;
  rawFinishReason?: string | null;
  streamFailed?: boolean;
}): ChatCompletionOutcome => {
  const truncated =
    args.finishReason === "length" ||
    isLengthRawFinishReason(args.rawFinishReason);
  if (truncated) return { status: "incomplete", incompleteReason: "length" };
  const interrupted =
    args.streamFailed === true ||
    (typeof args.finishReason === "string" &&
      INTERRUPTED_FINISH_REASONS.has(args.finishReason));
  return interrupted
    ? { status: "incomplete", incompleteReason: "interrupted" }
    : { status: "normal" };
};

/** Narrows an untrusted string (a stream trailer) to an incomplete reason. */
export const isChatIncompleteReason = (
  value: unknown
): value is ChatIncompleteReason => value === "length" || value === "interrupted";

/** Narrows an untrusted string (a stored row, a stream trailer) to a status. */
export const isChatCompletionStatus = (
  value: unknown
): value is ChatCompletionStatus => value === "normal" || value === "incomplete";
