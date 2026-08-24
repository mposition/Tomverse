/**
 * Which recovery a failed chat turn is offered.
 *
 * The category decides what the error card puts in front of the user: retry,
 * retry without the files, pick a cheaper model, or close a panel. Getting it
 * wrong is not cosmetic -- a refusal classified `generic` offers "try again"
 * and nothing else, and if trying again cannot possibly work the card is a
 * dead end.
 *
 * That is what happened to `DUPLICATE_ATTACHMENT_OBJECT`. The attachment
 * branch used to be decided by reading the *sentence*:
 *
 *     message.errorHadAttachments && /pdf|office|unsupported|invalid/
 *
 * The server sends a code for exactly this reason, and the sentence is a
 * translated, rewritable string that happens to have contained one of those
 * four words often enough for the heuristic to look like it worked. "Duplicate
 * attachment objects are not allowed." contains none of them, so the one
 * affordance that would have helped -- send it again without the file -- was
 * never rendered, and the only button on the card re-sent the request that had
 * just been refused.
 *
 * Pure and code-first: a new refusal is a line in one of the sets below.
 * `content` remains an input only as a fallback for messages persisted before
 * `errorCode` was carried, and it can never override a code that is known.
 */

export const CHAT_ERROR_CATEGORIES = [
  "quota",
  "model_retired",
  "attachment",
  "generic",
] as const;

export type ChatErrorCategory = (typeof CHAT_ERROR_CATEGORIES)[number];

/**
 * Codes where the fix is changing what's being asked for (fewer/cheaper
 * models, a different model) rather than repeating the same request.
 */
export const QUOTA_CHAT_ERROR_CODES: ReadonlySet<string> = new Set([
  "CREDIT_BALANCE_INSUFFICIENT",
  "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
  "PLAN_ENTITLEMENT_EXHAUSTED",
  "PLAN_DAILY_CREDIT_LIMIT_REACHED",
  "CHAT_QUOTA_EXCEEDED",
  "FREE_PRO_MODEL_QUOTA_EXCEEDED",
  "OPERATIONAL_COST_GUARDRAIL_TRIGGERED",
  "PROVIDER_BUDGET_EXHAUSTED",
  // Retired codes, still classified so a response cached from an older
  // deployment keeps offering the "change what you asked for" affordances.
  "INTERNAL_DAILY_COST_SAFETY_LIMIT",
  "INTERNAL_MONTHLY_COST_SAFETY_LIMIT",
  "PROVIDER_DAILY_SPEND_LIMIT_REACHED",
  "PROVIDER_SPEND_LIMIT_REACHED",
  "CHAT_CONCURRENCY_EXCEEDED",
  "CHAT_IP_CONCURRENCY_EXCEEDED",
]);

/**
 * Codes where the files are what the server refused, so sending the same
 * question without them is a real way forward.
 *
 * Everything `/api/chat` can throw about an attachment belongs here, including
 * the counting and reference refusals: each of them is answered by dropping a
 * file, and none of them is answered by pressing retry.
 */
export const ATTACHMENT_CHAT_ERROR_CODES: ReadonlySet<string> = new Set([
  // -- Shape and content --------------------------------------------------
  "ATTACHMENT_TYPE_MISMATCH",
  "ATTACHMENT_ENCODING_UNREADABLE",
  "ATTACHMENT_ANIMATED_IMAGE",
  "INVALID_IMAGE_ATTACHMENT",
  "INVALID_PDF_ATTACHMENT",
  "ATTACHMENT_NO_TEXT",
  "ATTACHMENT_ENCRYPTED",
  "ATTACHMENT_UNREADABLE",
  "ATTACHMENT_TEXT_TOO_LARGE",
  "ATTACHMENT_MODEL_IMAGE_UNSUPPORTED",
  "UNSUPPORTED_ATTACHMENT_TYPE",
  "ATTACHMENT_TOO_LARGE",
  "INVALID_ATTACHMENT_KIND",
  // -- Guest equivalents ---------------------------------------------------
  "GUEST_ATTACHMENT_TYPE_MISMATCH",
  "GUEST_ATTACHMENT_NO_TEXT",
  "GUEST_ATTACHMENT_UNREADABLE",
  "GUEST_ATTACHMENT_TEXT_TOO_LARGE",
  "GUEST_ATTACHMENT_UNSUPPORTED_TYPE",
  // -- Archives -------------------------------------------------------------
  "ARCHIVE_CORRUPT",
  "ARCHIVE_ENCRYPTED",
  "ARCHIVE_ZIP64_UNSUPPORTED",
  "ARCHIVE_TOO_MANY_ENTRIES",
  "ARCHIVE_ENTRY_TOO_LARGE",
  "ARCHIVE_EXPANSION_TOO_LARGE",
  "ARCHIVE_COMPRESSION_RATIO",
  "ARCHIVE_UNSAFE_PATH",
  "ARCHIVE_EXECUTABLE_ENTRY",
  "ARCHIVE_CREDENTIAL_ENTRY",
  "ARCHIVE_UNSUPPORTED_COMPRESSION",
  "ARCHIVE_SIZE_MISMATCH",
  "ARCHIVE_NO_SUPPORTED_FILES",
  "ARCHIVE_PROCESSING_TIMEOUT",
  // -- Counting and references ---------------------------------------------
  "DUPLICATE_ATTACHMENT_OBJECT",
  "TOO_MANY_ATTACHMENTS",
  "TOO_MANY_ATTACHMENT_OBJECTS",
  "TOO_MANY_CONVERSATION_ATTACHMENTS",
  "GUEST_TOO_MANY_ATTACHMENTS",
  "GUEST_TOO_MANY_CONVERSATION_ATTACHMENTS",
  "INLINE_ATTACHMENT_FORBIDDEN",
  "ATTACHMENT_REFERENCE_REQUIRED",
  // -- Operational ----------------------------------------------------------
  // The files are the only reason this turn was refused, and sending the
  // question without them is what gets an answer while the flag is off.
  "ATTACHMENTS_DISABLED_BY_ADMIN",
]);

/**
 * The pre-code fallback, kept only for messages persisted before `errorCode`
 * travelled with them. Deliberately not consulted when a code is known.
 */
const looksLikeFileParsingSentence = (content: string) => {
  const normalized = content.toLowerCase();
  return (
    normalized.includes("pdf") ||
    normalized.includes("office") ||
    normalized.includes("unsupported") ||
    normalized.includes("invalid")
  );
};

export const classifyChatError = (message: {
  errorCode?: string | null;
  content?: string | null;
  errorHadAttachments?: boolean;
}): ChatErrorCategory => {
  const code = message.errorCode || "";
  if (code === "MODEL_RETIRED") return "model_retired";
  if (QUOTA_CHAT_ERROR_CODES.has(code)) return "quota";
  if (ATTACHMENT_CHAT_ERROR_CODES.has(code)) return "attachment";
  // An unrecognised code is a decision, not a gap to fill by reading the
  // sentence: a code the server sent and this build does not know is generic,
  // and only a message that carries no code at all falls back.
  if (code) return "generic";
  return message.errorHadAttachments &&
    looksLikeFileParsingSentence(message.content ?? "")
    ? "attachment"
    : "generic";
};
