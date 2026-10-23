import { createHash } from "node:crypto";

/** The first live analysis tuple is narrower than the editable Frontier
 * catalog. The conservative input rate includes one-hour cache writes.
 * A changed model, price or context limit needs a new reviewed profile. */
export const AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE = Object.freeze({
  provider: "anthropic",
  modelId: "claude-opus-5-5",
  mode: "api",
  inputTokensCap: 1_000_000,
  outputTokensCap: 128_000,
  inputMicroUsdPerMillion: 8_000_000,
  outputMicroUsdPerMillion: 20_000_000,
  maxReservationMicroUsd: BigInt("10560000"),
});

export const AMUX_V4_CLAUDE_OPUS_55_PRICE_EVIDENCE = Object.freeze({
  source: "https://platform.claude.com/docs/en/models/opus-5-5/overview",
  verifiedAt: "2026-10-04T00:00:00.000Z",
  expiresAt: "2026-11-03T00:00:00.000Z",
  approvedBy: "mposition",
});

export function amuxV4ApprovedCliPriceEvidenceDigest(): string {
  return createHash("sha256").update(JSON.stringify({
    profile: { ...AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE,
      maxReservationMicroUsd:
        AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE.maxReservationMicroUsd.toString() },
    evidence: AMUX_V4_CLAUDE_OPUS_55_PRICE_EVIDENCE,
  })).digest("hex");
}

type PriceRow = {
  provider: string;
  modelId: string;
  mode: string;
  status: string;
  inputTokensCap: number;
  outputTokensCap: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
};

export type AmuxApprovedPriceMode = "api" | "subscription_cli";

/** Only the exact owner-approved profile may be used by this runner. A changed
 * limit or price needs a new runner contract and a separate approval. The v19
 * Max runner uses the same rates as a subscription_cli conversion estimate. */
export function amuxV4ApprovedCliCostProfileMatches(row: PriceRow,
  mode: AmuxApprovedPriceMode = AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE.mode): boolean {
  const profile = AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE;
  return row.provider === profile.provider && row.modelId === profile.modelId &&
    row.mode === mode && row.status === "approved" &&
    row.inputTokensCap === profile.inputTokensCap &&
    row.outputTokensCap === profile.outputTokensCap &&
    row.inputMicroUsdPerMillion === profile.inputMicroUsdPerMillion &&
    row.outputMicroUsdPerMillion === profile.outputMicroUsdPerMillion;
}

/** amux-intake v19 subscription channels (owner decision 2026-10-20): the
 * subscription_cli price of any approved Frontier model, on any of the four
 * CLI channels, is the reviewed Opus 5.5 rates and caps above, recorded as a
 * conservative API-conversion estimate. Provider and model are the row's own;
 * only the numbers are fixed. The v4 API path keeps the function above. */
export function amuxSubscriptionCliCostProfileMatches(row: PriceRow,
  expected: { provider: string; modelId: string }): boolean {
  const profile = AMUX_V4_CLAUDE_OPUS_55_COST_PROFILE;
  return row.provider === expected.provider && row.modelId === expected.modelId &&
    row.mode === "subscription_cli" && row.status === "approved" &&
    row.inputTokensCap === profile.inputTokensCap &&
    row.outputTokensCap === profile.outputTokensCap &&
    row.inputMicroUsdPerMillion === profile.inputMicroUsdPerMillion &&
    row.outputMicroUsdPerMillion === profile.outputMicroUsdPerMillion;
}
