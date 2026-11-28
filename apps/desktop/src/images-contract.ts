import { z } from "zod";
import { chatId } from "./chat-contract";
import { CATALOG_IMAGE_SIZES } from "../../../lib/directRasterModels";

export const imageSize = z.enum(CATALOG_IMAGE_SIZES);
export const imageQuality = z.enum(["low", "medium", "high"]);
export const imageCapability = z.object({
  maxModels: z.number().int().min(1).max(8),
  models: z.array(z.object({
    id: z.string().min(1).max(120), name: z.string(), provider: z.string(), pricingVersion: z.string().min(1).max(120),
    prices: z.array(z.object({ size: imageSize, quality: imageQuality, credits: z.number().nonnegative() })),
  })),
});
export const imageRequest = z.object({
  prompt: z.string().trim().min(1).max(8_000),
  idempotencyKey: z.uuid(),
  conversationId: chatId.optional(),
  size: imageSize,
  quality: imageQuality,
  models: z.array(z.string().min(1).max(120)).min(1).max(8).refine((ids) => new Set(ids).size === ids.length),
  pricing: z.record(z.string().min(1).max(120), z.string().min(1).max(120)),
}).strict();
export const imageReceipt = z.object({ conversationId: chatId, groupId: chatId });
export const imageGeneration = z.object({
  generationId: chatId, groupId: chatId, targetId: chatId, modelId: z.string(), attemptNumber: z.number().int(),
  prompt: z.string(), status: z.string(), createdAt: z.string(),
  refunded: z.boolean(), publicErrorCode: z.string().nullable(),
});
export const imageHistory = z.object({
  conversationId: chatId,
  generations: z.array(imageGeneration),
});
export const imageGroup = imageHistory.extend({
  groupId: chatId, status: z.string(),
  targets: z.array(z.object({ targetId: chatId, currentGenerationId: chatId.nullable() })),
});
export type ImageCapability = z.infer<typeof imageCapability>;
export type ImageRequest = z.infer<typeof imageRequest>;
export type ImageReceipt = z.infer<typeof imageReceipt>;
export type ImageGenerationResult = { status: "accepted"; receipt: ImageReceipt } | { status: "price-changed" };
export type ImageHistory = z.infer<typeof imageHistory>;
export type ImageGroup = z.infer<typeof imageGroup>;
export type ImageGeneration = z.infer<typeof imageGeneration>;
export type ImageBytes = { mimeType: string; bytes: Uint8Array };
