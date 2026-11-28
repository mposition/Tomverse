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
} as const;

export type CliProvider = keyof typeof providerClis;
export const cliProviders = Object.keys(providerClis) as CliProvider[];
export const cliProvider = z.enum(cliProviders);
export const cliFilePath = z.string().trim().min(1).max(4096);
export const cliPathInput = z.object({ provider: cliProvider, path: cliFilePath }).strict();

export type CliPathCheck =
  | { status: "pathVerified"; version: string }
  | { status: "versionUnverified" | "userTrusted" | "invalidPath" | "fileMissing" | "wrongFile" | "windowsShim" | "checkFailed" | "unsupportedPlatform" };
export type SavedCliPath = { path: string } & (
  { status: "pathVerified"; version: string } | { status: "checkRequired" | "versionUnverified" | "userTrusted" }
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

const cliProtocolProviders = ["openai", "anthropic", "google", "xai", "qwen", "moonshot", "mistral", "minimax"] as const satisfies readonly CliProvider[];
export const cliUsesReleaseArchive = (provider: CliProvider) => provider === "qwen" || provider === "mistral";
export const cliUsesInstallationFolder = (provider?: CliProvider) => provider === "minimax";
export type CliProtocolProvider = (typeof cliProtocolProviders)[number];

// The scan looks for executables that the pinned release check can verify file by file. Release archives and
// installation folders are chosen by hand.
export const cliScanProviders = cliProviders.filter((provider) => !cliUsesReleaseArchive(provider) && !cliUsesInstallationFolder(provider));
export const isCliScanProvider = (provider: CliProvider) => cliScanProviders.some((candidate) => candidate === provider);
export type CliLogin = "loggedIn" | "loginRequired" | "unknown";
export type CliScanCandidate = {
  /** The file to save: the executable itself, or the native executable a command wrapper starts. */
  path: string;
  /** The command wrapper this executable was found through. */
  via?: string;
  status: "pathVerified" | "versionUnverified";
  version?: string;
  login: CliLogin;
  /** The person trusted this exact file; it is shown as unverified until then. */
  trusted: boolean;
};
export type CliScanEntry = { provider: CliProvider; candidates: CliScanCandidate[]; unresolvedShims: number };
export type CliScan = { providers: CliScanEntry[]; offer: boolean };
export type CliLoginOpen = "opened" | "terminalOff" | "noTask" | "unavailable";
/** Fixed arguments of the official sign-in command. A provider without an entry has no documented command. */
export const cliLoginArguments: Partial<Record<CliProvider, readonly string[]>> = { openai: ["login"], anthropic: ["auth", "login"] };
export const isCliProtocolProvider = (provider: CliProvider): provider is CliProtocolProvider =>
  cliProtocolProviders.some((candidate) => candidate === provider);
export type CliProtocolModel = { id: string; name: string; efforts: string[] };
export type CliProtocolCheck =
  | { status: "verified"; protocol: "codex_app_server" | "claude_control"; models: CliProtocolModel[]; catalogComplete: boolean }
  | { status: "verified"; protocol: "acp"; protocolVersion: 1; models: null }
  | { status: "unavailable" | "failed" | "networkBlocked" | "cancelled" };

export const codeProviders = {
  ...providerClis,
  // Chat models without an official CLI run on the Tomverse API even when the provider CLI route is preferred.
  deepseek: null,
  zhipu: null,
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
/** Claude Code on the person's Z.ai Coding Plan (provider-cli-exec-contract.ts, the `zai` route). */
export const zaiClaudeExecution = { executionMode: "provider_cli", provider: "anthropic", cli: "Z.ai CLI (via Claude Code)", billingSource: "provider_subscription" } as const;
export const miniMaxFixtureExecution = { executionMode: "provider_cli", provider: "minimax", cli: "MiniMax Code", billingSource: "unknown" } as const;
export const grokFixtureExecution = { executionMode: "provider_cli", provider: "xai", cli: "Grok Build", billingSource: "unknown" } as const;
export const antigravityFixtureExecution = { executionMode: "provider_cli", provider: "google", cli: "Antigravity", billingSource: "unknown" } as const;
export const nativeFixtureProvider = z.enum(["openai", "anthropic", "qwen", "moonshot", "mistral", "minimax", "xai", "google"]);
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
