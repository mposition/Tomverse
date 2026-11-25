import { DEFAULT_IMAGE_MODEL_ID } from "../../../lib/imageModelRegistry";
import { IMAGE_QUALITY_BY_PRESET } from "../../../lib/imageGenerationPricing";
import type { ChatImageOffer } from "./chat-extras-contract";
import type { ImageCapability } from "./images-contract";

export type ImageOfferQuote = {
  quality: "low" | "medium" | "high";
  models: Array<{ id: string; name: string; credits: number }>;
  credits: number;
};

/**
 * What the chat image turn would charge, read from the same catalogue prices the image workspace shows.
 * The turn is square (or the model's only size) at the preset's quality; any model without a price makes
 * the whole quote unavailable, because Desktop never starts an image it cannot price.
 */
export function imageOfferQuote(capability: ImageCapability | null | undefined, request: ChatImageOffer["request"]): ImageOfferQuote | null {
  if (!capability || request.edit) return null;
  const quality = IMAGE_QUALITY_BY_PRESET[request.preset ?? "standard"];
  const ids = request.modelIds.length ? request.modelIds : [DEFAULT_IMAGE_MODEL_ID];
  const models: ImageOfferQuote["models"] = [];
  for (const id of ids) {
    const model = capability.models.find((entry) => entry.id === id);
    const prices = model?.prices.filter((price) => price.quality === quality) ?? [];
    const price = prices.find(({ size }) => size === "1024x1024") ?? (prices.length === 1 ? prices[0] : undefined);
    if (!model || !price) return null;
    models.push({ id, name: model.name, credits: price.credits });
  }
  return { quality, models, credits: models.reduce((sum, model) => sum + model.credits, 0) };
}
