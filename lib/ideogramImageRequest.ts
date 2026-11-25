export const IDEOGRAM_MODEL_ID = "ideogram-4-6";
export const IDEOGRAM_SIZE = "1024x1024";
export const IDEOGRAM_OUTPUT_COST_MICRO_USD = { low: 30_000, medium: 60_000, high: 100_000 } as const;
/** The result host and ephemeral image path documented for the v2 API. */
export const isIdeogramAssetUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === "https://ideogram.ai" &&
    !url.username && !url.password && url.pathname.startsWith("/api/images/ephemeral/");
};
