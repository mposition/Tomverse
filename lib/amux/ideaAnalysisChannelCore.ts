/**
 * AMUX intake v19 analysis channels (owner decision 2026-10-20). `provider`
 * names the CLI execution channel, not the model vendor: GitHub Copilot and
 * Cursor take the model name their own CLI accepts (for example `gpt-5` or
 * `claude-sonnet-4.5`). Every channel signs in with a subscription account.
 *
 * The database repeats these lists in its CHECK constraints and the claim mode
 * guard (prisma/migrations/20261020090000_amux_v19_subscription_channels);
 * tests/amuxIdeaAnalysisChannelCore.test.mjs keeps the two in step.
 */
export const AMUX_IDEA_ANALYSIS_PROVIDERS =
  ["openai", "anthropic", "github-copilot", "cursor"] as const;
export type AmuxIdeaAnalysisProvider = (typeof AMUX_IDEA_ANALYSIS_PROVIDERS)[number];

export const isAmuxIdeaAnalysisProvider = (value: unknown): value is AmuxIdeaAnalysisProvider =>
  typeof value === "string" &&
  (AMUX_IDEA_ANALYSIS_PROVIDERS as readonly string[]).includes(value);

/** The v4 manual analysis path and its hold ledger still run only these two. */
export const AMUX_V4_ANALYSIS_PROVIDERS = ["openai", "anthropic"] as const;
export type AmuxV4AnalysisProvider = (typeof AMUX_V4_ANALYSIS_PROVIDERS)[number];

export const isAmuxV4AnalysisProvider = (value: unknown): value is AmuxV4AnalysisProvider =>
  typeof value === "string" &&
  (AMUX_V4_ANALYSIS_PROVIDERS as readonly string[]).includes(value);

/** The subscription sign-in each channel's launcher verifies. A v19
 * subscription (max_shadow) claim records it as `maxAuthProfile`, and the
 * database refuses a claim whose profile is not its channel's. */
export const AMUX_SUBSCRIPTION_AUTH_PROFILES: Readonly<Record<AmuxIdeaAnalysisProvider, string>> =
  Object.freeze({
    openai: "codex-chatgpt",
    anthropic: "claude-max-oauth",
    "github-copilot": "copilot-github",
    cursor: "cursor-login",
  });

export function amuxSubscriptionAuthProfile(provider: unknown): string | null {
  return isAmuxIdeaAnalysisProvider(provider) ? AMUX_SUBSCRIPTION_AUTH_PROFILES[provider] : null;
}

/** Display names only; stored and compared values are the provider IDs. */
export const AMUX_IDEA_ANALYSIS_PROVIDER_LABELS: Readonly<Record<AmuxIdeaAnalysisProvider, string>> =
  Object.freeze({
    openai: "OpenAI (Codex CLI)",
    anthropic: "Anthropic (Claude CLI)",
    "github-copilot": "GitHub Copilot (Copilot CLI)",
    cursor: "Cursor (Cursor CLI)",
  });
