/** Fixed request contracts for the two direct, single-output raster APIs. */
export const SEEDREAM_API_MODEL = "dola-seedream-5-5-261028";
export const RECRAFT_API_MODEL = "recraftv4_pro";
export const STANDARD_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const RECRAFT_SIZE = "2048x2048";
export const CATALOG_IMAGE_SIZES = [...STANDARD_IMAGE_SIZES, RECRAFT_SIZE] as const;

export const DIRECT_RASTER_MODELS = {
  byteplus: {
    apiModelId: SEEDREAM_API_MODEL,
    sizes: STANDARD_IMAGE_SIZES,
    credits: 45,
    outputCostMicroUsd: 20_000,
    pricing: "https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing",
    docs: "https://docs.byteplus.com/en/docs/ModelArk/seedream-5-5",
  },
  recraft: {
    apiModelId: RECRAFT_API_MODEL,
    sizes: [RECRAFT_SIZE],
    credits: 350,
    outputCostMicroUsd: 250_000,
    pricing: "https://www.recraft.ai/docs/api-reference/pricing",
    docs: "https://www.recraft.ai/docs/api-reference/models/recraft-v4",
  },
} as const;

export type DirectRasterProvider = keyof typeof DIRECT_RASTER_MODELS;
export const isDirectRasterProvider = (provider: unknown): provider is DirectRasterProvider =>
  provider === "byteplus" || provider === "recraft";
