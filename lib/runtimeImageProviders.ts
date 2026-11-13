/**
 * Providers whose image request the code already knows how to send. A model
 * of one of these can be added to the catalogue at runtime as a profile; any
 * other provider needs an adapter first. Dependency-free so the client panels
 * can read the same list the server's profile schema enforces.
 */
export const RUNTIME_IMAGE_PROVIDERS = ["openai", "google", "xai", "fal", "qwen"] as const;
export type RuntimeImageProvider = (typeof RUNTIME_IMAGE_PROVIDERS)[number];

export const isRuntimeImageProvider = (provider: string): provider is RuntimeImageProvider =>
  (RUNTIME_IMAGE_PROVIDERS as readonly string[]).includes(provider);

/** Where the discovery queue sends an image candidate: the catalogue, prefilled. */
export const catalogImageDraftHref = (provider: string, apiModelId: string) =>
  `/admin/models?${new URLSearchParams({ tab: "catalog", draft: "image", model: apiModelId, provider, api: apiModelId })}`;

/** The draft a discovery link asks for (?draft=image&model=&provider=&api=), or null. */
export const discoveryDraftRequest = (search: string) => {
  const params = new URLSearchParams(search);
  const modelId = params.get("model")?.trim() ?? "";
  if (params.get("draft") !== "image" || !modelId) return null;
  const provider = params.get("provider")?.trim() ?? "";
  const apiModelId = params.get("api")?.trim() || modelId;
  return { modelId, provider, apiModelId };
};

/**
 * What a Google direct image request needs, which the generic template left
 * out (2026-11-13: a runtime gemini-nano-banana-2.1 row could not have been
 * called). The request builder serves 1K square only and refuses a profile
 * with no output limit; the API accepts only image/jpeg; 2,048 is the limit
 * the measured bound in GOOGLE_IMAGE_OUTPUT_LIMIT_BOUNDS
 * (lib/imageModelRegistry.ts) holds for, and a Google model is bounded only
 * while its request sends exactly that. Kept here as literals because this
 * module is dependency-free for the client panels.
 */
const GOOGLE_RUNTIME_PROFILE = {
  sizes: ["1024x1024"],
  outputMimeTypes: ["image/jpeg", "image/png"],
  deliveryMimeType: "image/jpeg",
  maxOutputTokens: 2_048,
  provenance: ["synthid"],
} as const;

/**
 * Qwen's request maps 1024x1024 only (lib/qwenImageRequest.ts); a rectangle
 * builds no request and every generation of it would fail after charging.
 */
const QWEN_RUNTIME_SIZES = ["1024x1024"] as const;

/**
 * The starting profile for a runtime image model handed over from the
 * discovery queue. Every field is the operator's to correct; the schema and
 * the judge decide whether it can serve.
 */
export const runtimeImageProfileTemplate = (
  provider: string,
  apiModelId: string,
  // What the add form asks for; empty or missing keeps the default.
  choices: { name?: string; sizes?: readonly string[]; qualities?: readonly string[] } = {}
) => ({
  provider,
  apiModelId,
  // The profile schema caps a display name at 80 characters.
  name: (choices.name?.trim() || apiModelId).slice(0, 80),
  lifecycle: "preview",
  sizes: choices.sizes?.length ? [...choices.sizes] : ["1024x1024"],
  qualities: choices.qualities?.length ? [...choices.qualities] : ["low", "medium", "high"],
  latencyClass: "balanced",
  provenance: [] as string[],
  outputMimeTypes: ["image/png"] as string[],
  ...(provider === "qwen" ? { sizes: [...QWEN_RUNTIME_SIZES] } : {}),
  // A Google request has one shape whatever the form chose.
  ...(provider === "google"
    ? {
        sizes: [...GOOGLE_RUNTIME_PROFILE.sizes],
        outputMimeTypes: [...GOOGLE_RUNTIME_PROFILE.outputMimeTypes],
        deliveryMimeType: GOOGLE_RUNTIME_PROFILE.deliveryMimeType,
        maxOutputTokens: GOOGLE_RUNTIME_PROFILE.maxOutputTokens,
        provenance: [...GOOGLE_RUNTIME_PROFILE.provenance],
      }
    : {}),
});

/** The sizes and qualities a runtime image profile may list (the profile schema's enums). */
export const RUNTIME_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const RUNTIME_IMAGE_QUALITIES = ["low", "medium", "high"] as const;
