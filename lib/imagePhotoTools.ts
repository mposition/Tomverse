/**
 * Photo tools: provider calls that are priced and settled like an image model
 * but generate nothing. Each takes one photo and returns the same pixels with
 * the background cleared. Dependency-free, so pricing, the registry, the
 * adapter and the Studio route read one table.
 *
 * Two removers, because what to keep is a matter of taste and the two differ
 * (owner decision 2026-11-26, after both ran on the same nine photos): Recraft
 * keeps the objects beside the subject, Bria keeps the main subject alone.
 * Studio shows both and the user picks.
 *
 * Every tool has one option, 1024x1024 medium, and is default off behind its
 * own switch, so either provider can be stopped without the other.
 *
 *   - Recraft removeBackground: $0.01 per request (10 API units, pricing page
 *     read 2026-11-26; nine dev requests the same day each reported 10 units).
 *     Worst case 10,000 + the 5,000 prompt budget every option carries =
 *     15,000 micro-USD, floor 17; 20 credits is 750 per credit.
 *   - Bria RMBG 3.0 through fal (bria/rmbg-3): "$0.018 per image" (model page,
 *     read 2026-11-26; Bria's own API lists the same price). Worst case
 *     18,000 + 5,000 = 23,000 micro-USD, floor 26; 26 credits is 885 per credit.
 */
export const IMAGE_PHOTO_TOOL_SIZE = "1024x1024";

export const RECRAFT_BACKGROUND_REMOVAL = {
  modelId: "recraft-remove-background",
  provider: "recraft",
  name: "Recraft Background Remover",
  credits: 20,
  outputCostMicroUsd: 10_000,
  switch: "IMAGE_RECRAFT_BACKGROUND_REMOVAL_ENABLED",
  verifiedAt: "2026-11-26",
  pricing: "https://www.recraft.ai/docs/api-reference/pricing",
  docs: "https://www.recraft.ai/docs/api-reference/tools/remove-background",
} as const;

export const FAL_BRIA_BACKGROUND_REMOVAL = {
  // The fal endpoint id, sent as the request path.
  modelId: "bria/rmbg-3",
  provider: "fal",
  name: "Bria RMBG 3.0",
  credits: 26,
  outputCostMicroUsd: 18_000,
  switch: "IMAGE_FAL_BRIA_BACKGROUND_REMOVAL_ENABLED",
  verifiedAt: "2026-11-26",
  pricing: "https://fal.ai/models/bria/rmbg-3",
  docs: "https://fal.ai/models/bria/rmbg-3/api",
} as const;

/** In the order Studio shows them: the faster one first. */
export const IMAGE_PHOTO_TOOL_CONTRACTS = [RECRAFT_BACKGROUND_REMOVAL, FAL_BRIA_BACKGROUND_REMOVAL] as const;
export type ImagePhotoToolContract = (typeof IMAGE_PHOTO_TOOL_CONTRACTS)[number];

export const imagePhotoToolContract = (modelId: unknown): ImagePhotoToolContract | null =>
  IMAGE_PHOTO_TOOL_CONTRACTS.find(tool => tool.modelId === modelId) ?? null;
