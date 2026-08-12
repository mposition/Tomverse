// Whether an assistant answer actually finished, or merely stopped.
//
// A provider that hits its output-token ceiling still returns HTTP 200 with a
// body full of real text -- the only difference from a finished answer is the
// finish reason. Treating that as a normal completion is what leaves a user
// staring at a sentence that ends mid-word with no explanation. This decides
// the difference in one pure place so the streaming client, the persisted
// message and a later re-fetch all say the same thing.
//
// Deliberately narrow: `cancelled` (the user stopped it), `error` (the
// request failed) and the empty-response path keep their existing meanings
// and are decided elsewhere. This only ever distinguishes "finished" from
// "ran out of room".

/** Persisted in `Message.status` and mirrored in the client Message type. */
export type ChatCompletionStatus = "normal" | "incomplete";

/** Why an answer is incomplete. One case today; the field names it anyway. */
export type ChatIncompleteReason = "length";

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
 * unified or the provider-raw reason means the answer was cut off; anything
 * else is a normal completion.
 */
export const resolveChatCompletionOutcome = (args: {
  finishReason?: string | null;
  rawFinishReason?: string | null;
}): ChatCompletionOutcome => {
  const truncated =
    args.finishReason === "length" ||
    isLengthRawFinishReason(args.rawFinishReason);
  return truncated
    ? { status: "incomplete", incompleteReason: "length" }
    : { status: "normal" };
};

/** Narrows an untrusted string (a stored row, a stream trailer) to a status. */
export const isChatCompletionStatus = (
  value: unknown
): value is ChatCompletionStatus => value === "normal" || value === "incomplete";
