/**
 * What the Router needs to know about a turn, before a model is chosen.
 *
 * The chat route's ordering problem in one file. Everything downstream of the
 * model -- the credit budget, the context-window fit, the attachment shaping,
 * the provider-context restore -- is built from `modelConfig`, so the model
 * has to be known first. But the Router's candidate filter needs the input
 * size to decide which models the turn fits in, and the input size is computed
 * by the loop that does the model-dependent shaping.
 *
 * The way out is to compute, before any of it, what the size is *for each
 * candidate*. Text is model-independent and exact. Attachments are neither:
 * a PDF costs a flat allowance on a model that reads it natively and its
 * extracted text on a model that does not, so there is no single number, and
 * `lib/routerCandidates.ts` takes a per-model callback instead.
 *
 * ## Why the sizes are measured rather than taken
 *
 * The client knows how big the files are -- it uploaded them -- and
 * `app/api/chat/preflight` already accepts a declared size for its own
 * estimate. Routing must not: a declared size is a claim, and a client that
 * understated one would steer the Router to a model whose window the real
 * content does not fit. The user would then get a context-window error for a
 * model they did not choose. So the size comes from object storage, and an
 * attachment that cannot be measured is not routed.
 *
 * ## What "cannot be measured" covers
 *
 * An attachment with no object key, one outside the caller's own prefix, and
 * one the store cannot answer for. The ownership rule is the important one:
 * a probe that measured any key would be an object-size oracle over the whole
 * bucket. Guests never reach here at all -- the cohort excludes them -- which
 * is why one prefix is enough.
 */

import {
  estimatePreflightAttachmentTokens,
  type AttachmentTokenDescriptor,
} from "@/lib/chatAttachmentTokens";
import { estimateRawTextTokens } from "@/lib/chatTokenEstimate";
import type { AiModel } from "@/lib/models";

/** The shape the chat payload validator has already guaranteed. */
export type PreflightMessage = {
  role?: unknown;
  content?: unknown;
  attachments?: unknown;
};

/**
 * Whether any message in the turn carries an attachment.
 *
 * Deliberately structural rather than a count: an empty array is not an
 * attachment, and a payload that carries the key with nothing in it is the
 * ordinary shape a client sends.
 */
export const turnCarriesAttachments = (
  messages: readonly PreflightMessage[]
): boolean =>
  messages.some(
    (message) => Array.isArray(message?.attachments) && message.attachments.length > 0
  );

/**
 * The turn's text, concatenated, for the task profile.
 *
 * The Router reads this to classify the turn; nothing keeps it. Only the last
 * user message is used, matching what the shadow path profiles — a profile
 * built from the whole transcript would describe the conversation rather than
 * the request, and the model is chosen for the request.
 */
export const profileTextFor = (messages: readonly PreflightMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    return typeof message.content === "string" ? message.content : "";
  }
  return "";
};

export type PreflightEstimate = {
  /** Input tokens the turn will send, before any model-specific shaping. */
  estimatedInputTokens: number;
  /**
   * False when the turn carries an attachment, i.e. when the figure above is
   * a lower bound rather than the size. Nothing may route on an inexact one.
   */
  exact: boolean;
};

/**
 * The turn's input size, as far as it can be known without a model.
 *
 * Every message counts, not just the last: the whole transcript is sent, so
 * the window has to hold it. The per-message floor of one token mirrors the
 * accumulator in the chat route — an empty message still costs the provider
 * its role framing — so the two figures cannot disagree about a turn that
 * contains one.
 */
export const preflightInputEstimate = (
  messages: readonly PreflightMessage[]
): PreflightEstimate => {
  let estimatedInputTokens = 0;
  for (const message of messages) {
    const text = typeof message?.content === "string" ? message.content : "";
    estimatedInputTokens += Math.max(1, estimateRawTextTokens(text));
  }
  return {
    estimatedInputTokens,
    exact: !turnCarriesAttachments(messages),
  };
};

export type MeasuredAttachments =
  | { measurable: true; descriptors: readonly AttachmentTokenDescriptor[] }
  | {
      measurable: false;
      reason: "unresolved" | "not_own_object" | "unmeasurable";
    };

/** One attachment as the request layer has already resolved it. */
export type ResolvedTurnAttachment = {
  mediaType: string;
  /** Bytes, as measured in storage when the upload was finalised. */
  size: number;
  /** Private storage key, so the caller's own prefix can be re-checked here. */
  objectKey: string;
};

/**
 * Every attachment in the turn, as `{ mediaType, size }`, or a refusal.
 *
 * All or nothing on purpose. A partial measurement would let the Router choose
 * a model on the strength of the files it could see, and the one it could not
 * is exactly the one likely to be a scanned PDF that does not fit.
 *
 * Takes what the request layer resolved rather than reading the request. The
 * sizes are the ones storage reported when the upload was finalised, so no
 * HEAD request is made here at all -- which also settles the object-size
 * oracle this function used to have to defend against by hand: there is no
 * key from a client to measure. The prefix check stays as the second line: a
 * row that somehow named a key outside its owner's storage is refused rather
 * than measured.
 */
export const measureTurnAttachments = (
  attachments: readonly ResolvedTurnAttachment[],
  ownObjectPrefix: string | null
): MeasuredAttachments => {
  const descriptors: AttachmentTokenDescriptor[] = [];
  for (const attachment of attachments) {
    if (!attachment.objectKey) {
      return { measurable: false, reason: "unresolved" };
    }
    if (!ownObjectPrefix || !attachment.objectKey.startsWith(ownObjectPrefix)) {
      return { measurable: false, reason: "not_own_object" };
    }
    if (!Number.isFinite(attachment.size) || attachment.size <= 0) {
      return { measurable: false, reason: "unmeasurable" };
    }
    descriptors.push({
      mediaType: attachment.mediaType,
      size: attachment.size,
    });
  }
  return { measurable: true, descriptors };
};

/**
 * The per-model attachment cost the candidate filter asks for.
 *
 * A thin wrapper over `estimatePreflightAttachmentTokens`, which already knows
 * that a natively-readable file is a flat allowance and everything else is its
 * extracted text. Named here so the chat route hands the filter a function
 * rather than assembling one inline, and so the zero case -- no attachments,
 * every model free -- is one place rather than a conditional at the call site.
 */
export const attachmentTokensForModel =
  (descriptors: readonly AttachmentTokenDescriptor[]) =>
  (model: AiModel): number =>
    descriptors.length === 0
      ? 0
      : estimatePreflightAttachmentTokens(model, [...descriptors]);
