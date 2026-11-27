import { AVAILABLE_MODELS, type AiModel } from "@/lib/models";

/**
 * Extraction ceiling for revising a generated file (lib/generatedArtifactRevision.ts,
 * lib/generatedArtifactWorkbookRevision.ts). A Chat request does not use it.
 */
export const MAX_EXTRACTED_ATTACHMENT_CHARACTERS = 300_000;

/**
 * How much text the parsers may build for one Chat request.
 *
 * Not a product limit. What a turn may send is the input token limit
 * (`CHAT_INPUT_TOKEN_LIMIT`: for an account, the model's context window), checked
 * on the whole conversation later. This only stops a
 * parser from assembling a string no request could carry. The parsers guard
 * their own memory separately (lib/officeSecurity.ts, lib/chatArchiveLimits.ts).
 *
 * The 300,000-character request limit that used to stand here also counted the
 * files of every earlier message again on each turn, so a conversation whose
 * files added up past it refused every later message, new file or not
 * (2026-11-16 report). Operator decision 2026-11-16: drop it.
 *
 * Sized from the largest compiled context window (operator decision
 * 2026-11-18), so it never refuses a file the model could hold: five characters
 * a token is above English text (about four) and far above Korean.
 */
export const CHAT_ATTACHMENT_CHARACTERS_PER_CONTEXT_TOKEN = 5;

export const CHAT_ATTACHMENT_PARSE_CHARACTERS = Math.max(
  2_000_000,
  ...(AVAILABLE_MODELS as readonly AiModel[]).map(
    (model) => (model.contextWindowTokens ?? 0) * CHAT_ATTACHMENT_CHARACTERS_PER_CONTEXT_TOKEN
  )
);

/**
 * The part of the input allowance that earlier messages' files may fill.
 *
 * Earlier files are read again on every turn so the model keeps their context.
 * Past this share an earlier file is left out of the turn, with a line telling
 * the model so, instead of failing the request: the message being sent, and
 * its own files, keep the other half.
 */
export const pastTurnAttachmentTokenBudget = (maxInputTokens: number) =>
  Math.floor(maxInputTokens / 2);

export const PAST_ATTACHMENT_OMITTED_KIND = "earlier attachment, not included";

export const PAST_ATTACHMENT_OMITTED_TEXT =
  "This file was attached to an earlier message and is not included in this turn: " +
  "the earlier files in this conversation already fill the room set aside for them. " +
  "If the answer needs it, say so and ask the user to attach it again.";

/**
 * Same kind as above, for an earlier file that could not be delivered to *this*
 * model (a model without image input, a parser that failed or timed out, an
 * archive or OCR step that refused it). The message being sent is refused for
 * the same causes; an earlier one must not be, or one file the user can no
 * longer see would make every later turn of the conversation fail.
 */
export const PAST_ATTACHMENT_UNDELIVERABLE_TEXT =
  "This file was attached to an earlier message and is not included in this turn: " +
  "it could not be delivered to this model (the model cannot read this kind of file, or the file could not be processed). " +
  "Its contents are unknown to you. Do not describe, summarise, quote, or infer anything about it. " +
  "If the answer needs it, say so and ask the user to attach it again.";

/**
 * What a signed-in account may attach (operator decision 2026-11-18, after a
 * comparison with Claude.ai, Gemini, Perplexity and ChatGPT). Was 5 files of
 * 10 MB and 25 MB a request. Guests keep their own, smaller limits.
 *
 * The request total still bounds what one turn reads into memory: an earlier
 * message's file whose text is already cached (lib/attachmentTextCache.ts) is
 * not read again and does not count towards it.
 */
export const CHAT_MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const CHAT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const CHAT_MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;
