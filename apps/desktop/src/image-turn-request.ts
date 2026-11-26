import type { ChatExtrasInput, ChatImageOffer } from "./chat-extras-contract";

/** The image turn the server's Auto judgement asked for, as the request body the web sends for it. */
export function imageTurnFromOffer(offer: ChatImageOffer): Extract<ChatExtrasInput, { action: "imageTurn" }> {
  const { request } = offer;
  return {
    action: "imageTurn", conversationId: offer.conversationId, sourceUserMessageId: offer.sourceUserMessageId,
    assistantMessageId: offer.assistantMessageId, modelId: offer.modelId, imageModelIds: request.modelIds, preset: request.preset,
    ...(request.prompt ? { prompt: request.prompt } : {}), ...(request.edit ? { edit: true as const } : {}),
    ...(request.routingDecisionId ? { routingDecisionId: request.routingDecisionId } : {}),
  };
}
