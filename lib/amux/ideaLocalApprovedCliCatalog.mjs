import { planAmuxV4AnalysisCliInvocation } from "./ideaLocalCliContract.mjs";

/** Exact tuple approved by mposition after the isolated Ubuntu S0 on
 * 2026-10-04. This is CLI admission only: the app's audited Frontier catalog,
 * price version, budget hold and live switches remain independent gates. */
export const AMUX_V4_APPROVED_ANALYSIS_CLI_CATALOG = Object.freeze([
  Object.freeze({ provider: "anthropic", modelId: "claude-opus-5-5",
    reasoningEffort: "high", egressHosts: Object.freeze(["api.anthropic.com"]) }),
]);

export function amuxV4ApprovedAnalysisCliForModel(modelId) {
  if (typeof modelId !== "string") return null;
  return AMUX_V4_APPROVED_ANALYSIS_CLI_CATALOG.find((entry) =>
    entry.modelId === modelId) ?? null;
}

/** Codex 0.155.1 does not attest the served model in JSONL. Until that
 * changes, a Codex candidate must not consume a claim or a budget hold. */
export function amuxV4CanClaimAnalysisCli(entry, modelId) {
  return entry?.provider === "anthropic" &&
    entry.modelId === modelId &&
    planAmuxV4AnalysisCliInvocation({ provider: entry.provider,
      modelId: entry.modelId, reasoningEffort: entry.reasoningEffort }) !== null &&
    Array.isArray(entry.egressHosts) && entry.egressHosts.length > 0 &&
    entry.egressHosts.every((host) => typeof host === "string" &&
      /^[a-z0-9.-]{1,253}$/.test(host));
}
