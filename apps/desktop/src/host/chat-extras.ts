import { z } from "zod";
import { classifyFeedbackFailure, feedbackReferenceFromId, isFeedbackReference } from "../../../../lib/feedbackPolicy";
import { createHash } from "node:crypto";
import {
  chatExtrasInput, quickSummary, reviewExportInput, type ChatExtrasInput, type ChatExtrasOutput, type CompareEstimateOutcome,
  type CompareSummaryOutcome, type FeedbackOutcome, type ImageTurnOutcome, type ItemFeedbackOutcome, type VerifyItemOutcome,
} from "../chat-extras-contract";
import type { AccountSettingsApi } from "./account-settings-api";

type Transport = Pick<AccountSettingsApi, "send">;

async function submitFeedback(api: Transport, input: Extract<ChatExtrasInput, { action: "feedback" }>): Promise<FeedbackOutcome> {
  let response: Response;
  try {
    response = await api.send({
      path: "/api/feedback", method: "POST",
      body: {
        // The same shape the web "report a problem with this answer" button sends.
        type: "bug", message: input.message, messageId: input.messageId, answerSignal: "needs_improvement",
        ...(input.modelId ? { modelId: input.modelId } : {}), path: "/desktop/" + input.product,
        ...(input.emailUpdates ? { emailUpdates: true } : {}),
      },
    });
  } catch {
    return { ok: false, failure: "network" };
  }
  const body = await response.json().catch(() => null) as unknown;
  if (response.ok) {
    const sent = z.object({ feedbackId: z.string().max(64).optional(), reference: z.unknown().optional(),
      emailUpdatesEnabled: z.boolean().optional() }).safeParse(body);
    const data = sent.success ? sent.data : {};
    const reference = isFeedbackReference(data.reference) ? data.reference
      : data.feedbackId ? feedbackReferenceFromId(data.feedbackId) : null;
    return { ok: true, reference, emailUpdatesEnabled: data.emailUpdatesEnabled === true };
  }
  const code = z.object({ code: z.string() }).safeParse(body);
  return { ok: false, failure: classifyFeedbackFailure(response.status, code.success ? code.data.code : null) };
}

const conversationPath = (id: string) => "/api/conversations/" + encodeURIComponent(id);
const errorCode = async (response: Response) => {
  const parsed = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/) }).safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.code : null;
};

async function compareEstimate(api: Transport, conversationId: string): Promise<CompareEstimateOutcome> {
  const response = await api.send({ path: conversationPath(conversationId) + "/compare-summary" });
  if (!response.ok) return { ok: false, code: await errorCode(response) };
  const body = z.object({ available: z.boolean(), estimatedCredits: z.number().nonnegative().optional(), cached: z.boolean().optional() })
    .safeParse(await response.json().catch(() => null));
  if (!body.success) return { ok: false, code: null };
  return { ok: true, available: body.data.available, estimatedCredits: body.data.estimatedCredits ?? 0, cached: body.data.cached === true };
}

async function compareSummary(api: Transport, conversationId: string): Promise<CompareSummaryOutcome> {
  // One non-streaming model call that can take a while; the reviewer chain has its own server limits.
  const response = await api.send({ path: conversationPath(conversationId) + "/compare-summary", method: "POST" }, "application/json", 120_000);
  if (!response.ok) return { ok: false, code: await errorCode(response) };
  const summary = quickSummary.safeParse(await response.json().catch(() => null));
  return summary.success ? { ok: true, summary: summary.data } : { ok: false, code: null };
}

async function verifyItem(api: Transport, input: Extract<ChatExtrasInput, { action: "verifyItem" }>): Promise<VerifyItemOutcome> {
  const response = await api.send({ path: conversationPath(input.conversationId) + "/comparison-reviews/verify-item", method: "POST",
    body: { item: input.item } }, "application/json", 90_000);
  if (!response.ok) return { ok: false };
  const check = z.object({ status: z.enum(["supported", "unsupported", "inconclusive"]), summary: z.string().max(1_000),
    usageCredits: z.number().nonnegative().optional() }).safeParse(await response.json().catch(() => null));
  return check.success ? { ok: true, status: check.data.status, summary: check.data.summary, usageCredits: check.data.usageCredits ?? 0 } : { ok: false };
}

async function itemFeedback(api: Transport, input: Extract<ChatExtrasInput, { action: "itemFeedback" }>): Promise<ItemFeedbackOutcome> {
  const withdraw = input.verdict === null;
  const response = await api.send({ path: conversationPath(input.conversationId) + "/comparison-reviews/item-feedback",
    method: withdraw ? "DELETE" : "PUT",
    body: { reviewId: input.reviewId, reviewItemId: input.reviewItemId, ...(withdraw ? {} : { verdict: input.verdict }) } });
  await response.body?.cancel().catch(() => {});
  return { ok: response.ok };
}

/**
 * Starts the image answer for a saved question. The answer id is the image group's idempotency key, so an outcome
 * that could not be read is asked again under the same id: the image may already be reserved, and a second try
 * recovers that group instead of charging again. A readable refusal (4xx) is final.
 */
export async function startImageTurn(api: Transport, input: Extract<ChatExtrasInput, { action: "imageTurn" }>,
  pause: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<ImageTurnOutcome> {
  const body = {
    sourceUserMessageId: input.sourceUserMessageId, assistantMessageId: input.assistantMessageId, modelId: input.modelId,
    imageModelIds: input.imageModelIds, preset: input.preset,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.edit ? { edit: true } : {}),
    ...(input.routingDecisionId ? { routingDecisionId: input.routingDecisionId } : {}),
  };
  let last: ImageTurnOutcome = { ok: false, code: null };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await pause(attempt * 1_500);
    let response: Response;
    try {
      response = await api.send({ path: conversationPath(input.conversationId) + "/image-turn", method: "POST", body }, "application/json", 60_000);
    } catch {
      continue;
    }
    const data = await response.json().catch(() => null) as unknown;
    if (response.ok) {
      const turn = z.object({ imageTurn: z.object({ groupId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }) }).safeParse(data);
      if (turn.success) return { ok: true, groupId: turn.data.imageTurn.groupId };
    }
    const code = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/) }).safeParse(data);
    last = { ok: false, code: code.success ? code.data.code : null };
    if (response.status < 500 && data !== null) return last;
  }
  return last;
}

/**
 * The saved AI Review as a PDF, Word, TXT or Markdown file. The server renders the report from the stored
 * review, so only the selection travels; the byte count and digest it declares are checked before saving.
 */
export async function reviewExportFile(value: unknown, api: Transport) {
  const input = reviewExportInput.parse(value);
  const response = await api.send({ path: conversationPath(input.conversationId) + "/analysis/export", method: "POST",
    body: { analysis: input.analysis, format: input.format } }, "*/*", 120_000);
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Tomverse could not export the analysis.");
  }
  const declaredBytes = response.headers.get("x-export-bytes") ?? "";
  const declaredDigest = (response.headers.get("x-export-sha256") ?? "").toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!/^[1-9]\d*$/.test(declaredBytes) || bytes.byteLength !== Number(declaredBytes) || bytes.byteLength > 32 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(declaredDigest) || createHash("sha256").update(bytes).digest("hex") !== declaredDigest) {
    throw new Error("The exported analysis did not pass verification.");
  }
  return { bytes, suggestedName: "answer-analysis." + input.format, extension: input.format };
}

/** Runs one validated action. The renderer never supplies a path, so it cannot reach any other web API. */
export async function runChatExtras(value: unknown, api: Transport): Promise<ChatExtrasOutput[keyof ChatExtrasOutput]> {
  const input = chatExtrasInput.parse(value);
  switch (input.action) {
    case "feedback":
      return submitFeedback(api, input);
    case "compareEstimate":
      return compareEstimate(api, input.conversationId);
    case "compareSummary":
      return compareSummary(api, input.conversationId);
    case "verifyItem":
      return verifyItem(api, input);
    case "itemFeedback":
      return itemFeedback(api, input);
    case "imageTurn":
      return startImageTurn(api, input);
  }
}
