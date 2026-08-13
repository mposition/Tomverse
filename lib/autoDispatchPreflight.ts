/**
 * What the Router needs to know about a turn, before a model is chosen.
 *
 * The chat route's ordering problem in one file. Everything downstream of the
 * model — the credit budget, the context-window fit, the attachment shaping,
 * the provider-context restore — is built from `modelConfig`, so the model has
 * to be known first. But the Router's candidate filter needs the input size to
 * decide which models the turn fits in, and the input size is computed by the
 * loop that does the model-dependent shaping.
 *
 * The way out is to compute, before any of it, the part of the size that does
 * not depend on the model: the text. That is exact for a turn with no
 * attachment, and a turn with an attachment is not routed at all
 * (`attachments_present` in `lib/autoModelSelection.ts`) precisely because
 * this estimate could not be honest about it.
 *
 * ## Why not just over-estimate the attachments
 *
 * Because the only available upper bound is the request limit — four megabytes
 * of base64 per turn — and feeding that to the candidate filter would filter
 * out every model whose window cannot hold a maximal attachment, on every turn
 * that carries a one-page PDF. Auto would answer `no_candidate` for the
 * majority of attachment turns and fall back anyway, having spent the
 * filtering to get there. Refusing the turn honestly is the same outcome
 * without the pretence.
 */

import { estimateRawTextTokens } from "@/lib/chatTokenEstimate";

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
