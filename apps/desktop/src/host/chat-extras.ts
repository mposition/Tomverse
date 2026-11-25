import { z } from "zod";
import { classifyFeedbackFailure, feedbackReferenceFromId, isFeedbackReference } from "../../../../lib/feedbackPolicy";
import { chatExtrasInput, type ChatExtrasInput, type ChatExtrasOutput, type FeedbackOutcome } from "../chat-extras-contract";
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

/** Runs one validated action. The renderer never supplies a path, so it cannot reach any other web API. */
export async function runChatExtras(value: unknown, api: Transport): Promise<ChatExtrasOutput[keyof ChatExtrasOutput]> {
  const input = chatExtrasInput.parse(value);
  switch (input.action) {
    case "feedback":
      return submitFeedback(api, input);
  }
}
