/**
 * Providers whose image request the code already knows how to send. A model
 * of one of these can be added to the catalogue at runtime as a profile; any
 * other provider needs an adapter first. Dependency-free so the client panels
 * can read the same list the server's profile schema enforces.
 */
export const RUNTIME_IMAGE_PROVIDERS = ["openai", "google", "xai", "fal", "qwen", "bfl"] as const;
export type RuntimeImageProvider = (typeof RUNTIME_IMAGE_PROVIDERS)[number];

export const isRuntimeImageProvider = (provider: string): provider is RuntimeImageProvider =>
  (RUNTIME_IMAGE_PROVIDERS as readonly string[]).includes(provider);

/**
 * The provider id a discovery work item names under another spelling. New
 * provider research files a proposal under a slug of the company's name
 * ("Black Forest Labs" -> "black-forest-labs"), while the provider id is short
 * because it is also an env name (IMAGE_PROVIDER_BFL_COST_*), which a hyphen
 * cannot be.
 */
const RUNTIME_IMAGE_PROVIDER_ALIASES: Readonly<Record<string, RuntimeImageProvider>> = {
  "black-forest-labs": "bfl",
};

/** The runtime provider a discovered model belongs to, or null when none has an adapter. */
export const runtimeImageProviderFor = (provider: string): RuntimeImageProvider | null => {
  const key = provider.trim().toLowerCase();
  if (isRuntimeImageProvider(key)) return key;
  return Object.hasOwn(RUNTIME_IMAGE_PROVIDER_ALIASES, key) ? RUNTIME_IMAGE_PROVIDER_ALIASES[key] : null;
};

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
 * xAI's request maps 1K square only, and a Grok Imagine Image 2.x model takes
 * `low` or `medium` (lib/xaiImageRequest.ts). Anything else builds no request,
 * so the starting profile never offers it. Literals because this module is
 * dependency-free; tests/xaiImageRequest.test.mjs holds them to the adapter's.
 */
const XAI_RUNTIME_SIZES = ["1024x1024"] as const;
const XAI_RUNTIME_QUALITIES = ["low", "medium"] as const;

/**
 * BFL's FLUX 3 request maps 1K square only and has no quality setting
 * (lib/bflImageRequest.ts), so one quality: three would sell the same request
 * at three prices. FLUX 3 Image takes no output format and BFL's documented
 * formats are JPEG and PNG; the adapter stores only a type listed here. No
 * provenance is claimed: BFL documents none for FLUX 3.
 */
const BFL_RUNTIME_PROFILE = {
  sizes: ["1024x1024"],
  qualities: ["medium"],
  outputMimeTypes: ["image/jpeg", "image/png"],
} as const;

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
  ...(provider === "bfl"
    ? {
        sizes: [...BFL_RUNTIME_PROFILE.sizes],
        qualities: [...BFL_RUNTIME_PROFILE.qualities],
        outputMimeTypes: [...BFL_RUNTIME_PROFILE.outputMimeTypes],
      }
    : {}),
  ...(provider === "xai"
    ? {
        sizes: [...XAI_RUNTIME_SIZES],
        qualities: (choices.qualities?.length ? choices.qualities : XAI_RUNTIME_QUALITIES).filter((quality) =>
          (XAI_RUNTIME_QUALITIES as readonly string[]).includes(quality)
        ),
      }
    : {}),
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

/**
 * The longest image router note (a profile's routingNote). Capped so every
 * listed model's note fits the router call's prompt budget.
 */
export const IMAGE_ROUTING_NOTE_MAX_CHARS = 400;

/**
 * What an image model is for, in the user's words: the line under its name in
 * the image model list, the way a chat model shows "Fast everyday questions".
 * A key, not text, so the eight locales carry the copy (chat.imageModelUse*).
 */
export const IMAGE_USE_CASES = ["text", "detail", "fast", "edit", "layout", "reference", "value", "general"] as const;
export type ImageUseCase = (typeof IMAGE_USE_CASES)[number];

/** The sizes and qualities a runtime image profile may list (the profile schema's enums). */
export const RUNTIME_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const RUNTIME_IMAGE_QUALITIES = ["low", "medium", "high"] as const;
