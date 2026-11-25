import { z } from "zod";
import type { AiProvider } from "../../../lib/models";
import type { RuntimeImageProvider } from "../../../lib/runtimeImageProviders";

export const codeExecutionMode = z.enum(["tomverse_api", "provider_cli"]);
export type CodeExecutionMode = z.infer<typeof codeExecutionMode>;

export const providerClis = {
  openai: "Codex",
  anthropic: "Claude Code",
  google: "Antigravity",
  xai: "Grok Build",
  qwen: "Qwen Code",
  moonshot: "Kimi Code",
  mistral: "Mistral Vibe",
  minimax: "MiniMax Code",
  deepseek: "DeepSeek Harness",
  zhipu: "ZCode Agent",
} as const;

export type CliProvider = keyof typeof providerClis;
export const cliProviders = Object.keys(providerClis) as CliProvider[];
export const cliProvider = z.enum(cliProviders);
export const cliFilePath = z.string().trim().min(1).max(4096);
export const cliPathInput = z.object({ provider: cliProvider, path: cliFilePath }).strict();

export type CliPathCheck =
  | { status: "pathVerified"; version: string }
  | { status: "versionUnverified" | "invalidPath" | "fileMissing" | "wrongFile" | "windowsShim" | "checkFailed" | "unsupportedPlatform" };
export type SavedCliPath = { path: string } & (
  { status: "pathVerified"; version: string } | { status: "checkRequired" | "versionUnverified" }
);
export type CliPaths = Partial<Record<CliProvider, SavedCliPath>>;

export type CliBillingSource = "provider_subscription" | "provider_api" | "unknown";
export type CliAccount =
  | { status: "signedIn"; billingSource: CliBillingSource }
  | { status: "signInRequired" | "signInExpired" | "accountUnknown" | "networkBlocked"; billingSource: "unknown" };
export const unknownCliAccount = { status: "accountUnknown", billingSource: "unknown" } as const satisfies CliAccount;
export type IsolatedAcpAccountProvider = "google" | "xai" | "qwen" | "moonshot" | "mistral" | "minimax";
export const supportsIsolatedCliAccount = (provider: CliProvider): provider is "openai" | "anthropic" | IsolatedAcpAccountProvider =>
  provider === "openai" || provider === "anthropic" || provider === "google" || provider === "xai" ||
  provider === "qwen" || provider === "moonshot" || provider === "mistral" || provider === "minimax";

const cliProtocolProviders = ["openai", "anthropic", "google", "xai", "qwen", "moonshot", "mistral", "minimax", "deepseek", "zhipu"] as const satisfies readonly CliProvider[];
export const cliUsesReleaseArchive = (provider: CliProvider) => provider === "qwen" || provider === "mistral" || provider === "deepseek";
export const cliUsesInstallationFolder = (provider?: CliProvider) => provider === "minimax" || provider === "zhipu";
export type CliProtocolProvider = (typeof cliProtocolProviders)[number];
export const isCliProtocolProvider = (provider: CliProvider): provider is CliProtocolProvider =>
  cliProtocolProviders.some((candidate) => candidate === provider);
export type CliProtocolModel = { id: string; name: string; efforts: string[] };
export type CliProtocolCheck =
  | { status: "verified"; protocol: "codex_app_server" | "claude_control"; models: CliProtocolModel[]; catalogComplete: boolean }
  | { status: "verified"; protocol: "acp" | "zcode_protocol"; protocolVersion: 1; models: null }
  | { status: "unavailable" | "failed" | "networkBlocked" | "cancelled" };

export const codeProviders = {
  ...providerClis,
  cohere: null,
  groq: null,
  perplexity: null,
  deepinfra: null,
  together: null,
  openrouter: null,
  sail: null,
  fal: null,
  bfl: null,
  byteplus: null,
  recraft: null,
  ideogram: null,
} as const satisfies Record<AiProvider | RuntimeImageProvider, string | null>;

export const tomverseApiExecution = { executionMode: "tomverse_api", billingSource: "tomverse_credits" } as const;
export const codexFixtureExecution = { executionMode: "provider_cli", provider: "openai", cli: "Codex", billingSource: "unknown" } as const;
export const claudeFixtureExecution = { executionMode: "provider_cli", provider: "anthropic", cli: "Claude Code", billingSource: "unknown" } as const;
export const qwenFixtureExecution = { executionMode: "provider_cli", provider: "qwen", cli: "Qwen Code", billingSource: "unknown" } as const;
export const kimiFixtureExecution = { executionMode: "provider_cli", provider: "moonshot", cli: "Kimi Code", billingSource: "unknown" } as const;
export const vibeFixtureExecution = { executionMode: "provider_cli", provider: "mistral", cli: "Mistral Vibe", billingSource: "unknown" } as const;
export const deepSeekFixtureExecution = { executionMode: "provider_cli", provider: "deepseek", cli: "DeepSeek Harness", billingSource: "unknown" } as const;
export const zCodeFixtureExecution = { executionMode: "provider_cli", provider: "zhipu", cli: "ZCode Agent", billingSource: "unknown" } as const;
export const miniMaxFixtureExecution = { executionMode: "provider_cli", provider: "minimax", cli: "MiniMax Code", billingSource: "unknown" } as const;
export const grokFixtureExecution = { executionMode: "provider_cli", provider: "xai", cli: "Grok Build", billingSource: "unknown" } as const;
export const antigravityFixtureExecution = { executionMode: "provider_cli", provider: "google", cli: "Antigravity", billingSource: "unknown" } as const;
export const nativeFixtureProvider = z.enum(["openai", "anthropic", "qwen", "moonshot", "mistral", "deepseek", "zhipu", "minimax", "xai", "google"]);
export type NativeFixtureProvider = z.infer<typeof nativeFixtureProvider>;

type CodeRoute = typeof tomverseApiExecution | { executionMode: "provider_cli"; provider: CliProvider; cli: string } | { executionMode: null };

// Registration describes vendor support. The API catalog supplies eligibility;
// provider CLI readiness will come from the connected adapter's own catalog.
export function codeRouteFor(preference: CodeExecutionMode, model: { id: string; provider: string } | undefined): CodeRoute {
  if (!model) return { executionMode: null };
  if (preference === "tomverse_api") return tomverseApiExecution;
  if (model.id === "smart-adaptive" || !Object.hasOwn(codeProviders, model.provider)) return { executionMode: null };
  const cli = codeProviders[model.provider as keyof typeof codeProviders];
  return cli === null ? tomverseApiExecution : { executionMode: "provider_cli", provider: model.provider as CliProvider, cli };
}
