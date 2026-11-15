/** Server-only decisions projected through the offer/capability responses. */
export function researchPreviewFeatures(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.RESEARCH_PREVIEW_ENABLED === "true";
  return {
    pageReading: enabled && env.RESEARCH_PREVIEW_PAGE_READING_ENABLED === "true",
    durableRuns: enabled && env.RESEARCH_PREVIEW_DURABLE_ENABLED === "true",
    nativeStart: enabled && env.RESEARCH_PREVIEW_NATIVE_ENABLED === "true",
  };
}
