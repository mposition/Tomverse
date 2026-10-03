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

/** Codex 0.155.1 does not attest the served model in JSONL. Until that
 * changes, a Codex candidate must not consume a claim or a budget hold. */
export function amuxV4CanClaimAnalysisCli(entry, modelId) {
  return entry?.provider === "anthropic" &&
    entry.modelId === modelId && entry.modelId === "claude-opus-5-5" &&
    entry.reasoningEffort === "high" &&
    Array.isArray(entry.egressHosts) && entry.egressHosts.length > 0 &&
    entry.egressHosts.every((host) => typeof host === "string" &&
      /^[a-z0-9.-]{1,253}$/.test(host));
}
