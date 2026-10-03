/** No live CLI/model/egress tuple has passed the isolated S0 and owner
 * approval gate. S0 candidate endpoints in ideaLocalIsolatedCliRunner are
 * deliberately not copied here. The analysis supervisor must check this
 * catalog before it consumes a claim. */
export const AMUX_V4_APPROVED_ANALYSIS_CLI_CATALOG = Object.freeze([]);

export function amuxV4ApprovedAnalysisCliForModel(modelId) {
  if (typeof modelId !== "string") return null;
  return AMUX_V4_APPROVED_ANALYSIS_CLI_CATALOG.find((entry) =>
    entry.modelId === modelId) ?? null;
}
