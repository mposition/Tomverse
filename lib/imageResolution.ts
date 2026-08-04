import type { ImageSize } from "@/lib/imageGenerationPricing";

// The two-axis size model (docs/policy/image-generation.md section 12.1).
//
// `ImageSize` mixes two things that stopped being the same thing the moment a
// second provider appeared: the *product option* the user picks, and OpenAI's
// literal `WxH` request string. Google sells 0.5K/1K/2K/4K across fourteen
// aspect ratios and its 1K landscape is not 1536x1024; xAI takes `resolution`
// and `aspect_ratio` as separate fields. Neither can be reached by string
// substitution on a pixel pair.
//
// So the product chooses a **tier plus an aspect ratio**, and each provider
// translates that into whatever shape it wants. This module is that
// vocabulary and those translations, and nothing else -- it is pure, has no
// provider client in it, and does not decide what is for sale.
//
// What has NOT changed, deliberately:
//   * the price table is still keyed by the legacy `ImageSize` string;
//   * the stored `ImageGeneration.size` column still holds that string;
//   * the sold option set is exactly the three it was.
// Those move with a migration and a pricing version, not with a vocabulary.
// Existing rows are history and are never rewritten (section 12.1).

export type ImageResolutionTier = "0.5k" | "1k" | "2k" | "4k";

/**
 * Aspect ratios the product offers today. Deliberately the three the current
 * catalogue sells rather than every ratio a provider accepts: an option with
 * no verified price is not an option, and widening this list is a pricing
 * change.
 */
export type ImageAspectRatio = "1:1" | "3:2" | "2:3";

export type ImageResolutionOption = {
  tier: ImageResolutionTier;
  aspectRatio: ImageAspectRatio;
};

/**
 * The legacy `ImageSize` string each sold option corresponds to.
 *
 * Only 1K has entries, because 1K is all the catalogue sells. A 2K option has
 * no legacy string at all -- that is the point: when 2K ships it ships with
 * its own storage and pricing representation rather than being squeezed into
 * a pixel pair that means something else.
 */
const LEGACY_SIZE_BY_OPTION: Record<
  ImageResolutionTier,
  Partial<Record<ImageAspectRatio, ImageSize>>
> = {
  "0.5k": {},
  "1k": {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
  },
  "2k": {},
  "4k": {},
};

const OPTION_BY_LEGACY_SIZE: Record<ImageSize, ImageResolutionOption> = {
  "1024x1024": { tier: "1k", aspectRatio: "1:1" },
  "1536x1024": { tier: "1k", aspectRatio: "3:2" },
  "1024x1536": { tier: "1k", aspectRatio: "2:3" },
};

/**
 * The option a stored or requested legacy size means.
 *
 * Total over `ImageSize`, so history reads back without a fallback: every row
 * ever written carries one of these three strings, and a lookup that could
 * miss would turn an old record into an unknown one.
 */
export const optionForLegacyImageSize = (
  size: ImageSize
): ImageResolutionOption => OPTION_BY_LEGACY_SIZE[size];

/**
 * The legacy string an option maps to, or null when it has none.
 *
 * Null is not an error to paper over: it means this option cannot be priced or
 * stored yet, and the caller must refuse rather than pick the nearest pixel
 * pair. Charging a 1K price for a 2K image is exactly the failure this
 * returns null to prevent.
 */
export const legacyImageSizeForOption = (
  option: ImageResolutionOption
): ImageSize | null => LEGACY_SIZE_BY_OPTION[option.tier][option.aspectRatio] ?? null;

/**
 * OpenAI's Images API takes the pixel pair, which is why it is the provider
 * whose request shape the legacy type was built around.
 */
export const openAiSizeForOption = (
  option: ImageResolutionOption
): ImageSize | null => legacyImageSizeForOption(option);

/** xAI's two request fields. Its tiers are named, not sized. */
export const xaiRequestForOption = (
  option: ImageResolutionOption
): { resolution: string; aspectRatio: string } | null => {
  // Only the tiers xAI documents, and only the ratios the product sells.
  if (option.tier !== "1k" && option.tier !== "2k") return null;
  return { resolution: option.tier, aspectRatio: option.aspectRatio };
};

/**
 * Google takes a tier name and an aspect ratio too, but supports a different
 * tier set per model, so the model's own advertised tiers decide -- this only
 * shapes the request once that check has passed.
 */
export const googleRequestForOption = (
  option: ImageResolutionOption
): { imageSize: string; aspectRatio: string } => ({
  imageSize: option.tier.toUpperCase(),
  aspectRatio: option.aspectRatio,
});

/** Every option the catalogue can currently price and store. */
export const SELLABLE_IMAGE_OPTIONS: readonly ImageResolutionOption[] = [
  { tier: "1k", aspectRatio: "1:1" },
  { tier: "1k", aspectRatio: "3:2" },
  { tier: "1k", aspectRatio: "2:3" },
];
