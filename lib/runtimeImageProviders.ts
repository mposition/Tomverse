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
  provenance: [],
  outputMimeTypes: ["image/png"],
});

/** The sizes and qualities a runtime image profile may list (the profile schema's enums). */
export const RUNTIME_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const RUNTIME_IMAGE_QUALITIES = ["low", "medium", "high"] as const;
