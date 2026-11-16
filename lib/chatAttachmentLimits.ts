/**
 * Extraction ceiling for revising a generated file (lib/generatedArtifactRevision.ts,
 * lib/generatedArtifactWorkbookRevision.ts). A Chat request does not use it.
 */
export const MAX_EXTRACTED_ATTACHMENT_CHARACTERS = 300_000;

/**
 * How much text the parsers may build for one Chat request.
 *
 * Not a product limit. What a turn may send is the input token limit
 * (`CHAT_INPUT_TOKEN_LIMIT`, 128,000 tokens for an account by default) and the
 * model's context window, both checked on the whole conversation later. This
 * sits far above either, so a turn under them never meets it; it only stops a
 * parser from assembling a string no request could carry. The parsers guard
 * their own memory separately (lib/officeSecurity.ts, lib/chatArchiveLimits.ts).
 *
 * The 300,000-character request limit that used to stand here also counted the
 * files of every earlier message again on each turn, so a conversation whose
 * files added up past it refused every later message, new file or not
 * (2026-11-16 report). Operator decision 2026-11-16: drop it.
 */
export const CHAT_ATTACHMENT_PARSE_CHARACTERS = 2_000_000;

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
