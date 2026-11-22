import {
    KEY_PLACEHOLDER,
    nativeSmartAdaptiveCapabilities,
    SMART_ADAPTIVE_MODEL_ID,
    type ExternalApiModelCapabilities,
} from "@/lib/externalApiCatalogCore";
import { DEFAULT_MODEL_ID } from "@/lib/models";

/**
 * Copyable configurations for the coding tools that run their own agent on a
 * Tomverse key: Claude Code (Anthropic Messages), Codex (Responses) and Cursor
 * (Chat Completions through Cursor's backend). Pure; built from the models
 * this account can run on each protocol, so a configuration never names a
 * model the gateway would refuse. See docs/policy/external-api.md, "Coding
 * tools".
 *
 * Verified 2026-11-18 on Windows with Claude Code 2.1.278 and Codex 0.146.0.
 * The key is a placeholder unless the caller passes the one just created.
 */

/**
 * The coding API's base from the general API's: `https://host/api/v1` ->
 * `https://host/api/code/v1` (owner decision 2026-11-21). Claude Code, Codex,
 * Cursor, VS Code (Copilot Chat's custom endpoint) and the tomverse CLI are
 * configured with it; Aside and other apps keep the general base.
 */
export const codingApiBaseUrl = (generalBaseUrl: string) =>
    /\/api\/v1$/.test(generalBaseUrl)
        ? generalBaseUrl.replace(/\/api\/v1$/, "/api/code/v1")
        : `${new URL(generalBaseUrl).origin}/api/code/v1`;

/**
 * The Anthropic base beside an OpenAI-compatible one (Claude Code adds /v1):
 * `.../api/v1` -> `.../api/anthropic`, `.../api/code/v1` -> `.../api/code/anthropic`.
 */
export const anthropicBaseUrl = (openAiBaseUrl: string) => openAiBaseUrl.replace(/\/v1$/, "/anthropic");

const byCredits = (models: readonly ExternalApiModelCapabilities[]) =>
    [...models].sort((a, b) => a.creditWeight - b.creditWeight || a.id.localeCompare(b.id));

/**
 * The input window a coding tool should plan for: what this API accepts for
 * input, with headroom for the gateway's conservative estimate, so the tool
 * compacts before Tomverse would refuse the request as too long.
 */
const plannedInputWindow = (model: ExternalApiModelCapabilities) =>
    Math.floor(Math.max(1, model.contextWindowTokens - model.maxOutputTokens) * 0.9);

export type ClaudeCodeConfig = {
    env: [string, string][];
    powershell: string;
    posix: string;
    vscodeSettings: string;
};

/**
 * Claude Code: environment variables for one shell session (nothing written
 * to the person's own Claude settings), and the official VS Code extension's
 * `claudeCode.environmentVariables`. Every model alias Claude Code may use --
 * main, Opus/Sonnet/Haiku defaults, subagents -- is pinned to a Tomverse model
 * so no request asks for one the gateway does not offer.
 */
export const claudeCodeConfig = (
    openAiBaseUrl: string,
    main: ExternalApiModelCapabilities,
    available: readonly ExternalApiModelCapabilities[],
    apiKey: string = KEY_PLACEHOLDER
): ClaudeCodeConfig => {
    // Claude Code's background work (titles, summaries) goes to the Haiku
    // alias: the cheapest fixed Anthropic model, never Smart Adaptive, so it
    // makes no router call and never takes the main conversation's pin. (Smart
    // Adaptive is offered here only alongside at least one fixed model.)
    const small = byCredits(available.filter((model) => model.id !== SMART_ADAPTIVE_MODEL_ID))[0] ?? main;
    const window = Math.min(1_000_000, Math.max(100_000, plannedInputWindow(main)));
    const env: [string, string][] = [
        ["ANTHROPIC_BASE_URL", anthropicBaseUrl(openAiBaseUrl)],
        ["ANTHROPIC_AUTH_TOKEN", apiKey],
        ["ANTHROPIC_MODEL", main.id],
        ["ANTHROPIC_DEFAULT_OPUS_MODEL", main.id],
        ["ANTHROPIC_DEFAULT_SONNET_MODEL", main.id],
        ["ANTHROPIC_DEFAULT_HAIKU_MODEL", small.id],
        ["CLAUDE_CODE_SUBAGENT_MODEL", main.id],
        ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", String(main.maxOutputTokens)],
        ["CLAUDE_CODE_AUTO_COMPACT_WINDOW", String(window)],
        // The cache premium Tomverse reserves is for the 5-minute cache.
        ["FORCE_PROMPT_CACHING_5M", "1"],
        ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"],
    ];
    return {
        env,
        powershell: env.map(([name, value]) => `$env:${name} = "${value}"`).join("\n") + "\nclaude",
        posix: env.map(([name, value]) => `export ${name}="${value}"`).join("\n") + "\nclaude",
        vscodeSettings: JSON.stringify(
            {
                "claudeCode.disableLoginPrompt": true,
                "claudeCode.environmentVariables": env.map(([name, value]) => ({ name, value })),
            },
            null,
            2
        ),
    };
};

export type CodexConfig = {
    /** Appended to ~/.codex/config.toml: the provider only, no default changed. */
    providerToml: string;
    /** ~/.codex/tomverse.config.toml: selected with `codex --profile tomverse`. */
    profileToml: string;
    /** For a tool that reads only config.toml (e.g. the IDE extension). */
    defaultToml: string;
    powershellKey: string;
    posixKey: string;
};

/**
 * The model id Codex should send: the provider's own id when it names exactly
 * one runnable model (Codex keys its tool set -- the freeform apply_patch --
 * on it), otherwise the Tomverse id. The gateway accepts both. Smart Adaptive
 * has no provider id: Codex 0.146 then sends its generic function tools
 * (shell_command, update_plan, ...; no freeform tool), which every OpenAI
 * model takes, whichever one the gateway picks (captured 2026-11-19).
 */
export const codexModelId = (
    model: ExternalApiModelCapabilities,
    available: readonly ExternalApiModelCapabilities[]
) =>
    model.providerModelId && available.filter((entry) => entry.providerModelId === model.providerModelId).length === 1
        ? model.providerModelId
        : model.id;

/**
 * Codex: a custom Responses provider with its own key variable, no retries,
 * no WebSocket and no hosted web search (a separately billed provider tool the
 * gateway refuses). Compaction stays local, as for any custom provider.
 */
export const codexConfig = (
    openAiBaseUrl: string,
    model: ExternalApiModelCapabilities,
    available: readonly ExternalApiModelCapabilities[]
): CodexConfig => {
    const provider = [
        "[model_providers.tomverse]",
        'name = "Tomverse"',
        `base_url = "${openAiBaseUrl}"`,
        'env_key = "TOMVERSE_API_KEY"',
        'wire_api = "responses"',
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "supports_websockets = false",
    ].join("\n");
    const modelId = codexModelId(model, available);
    const selection = [
        'model_provider = "tomverse"',
        `model = "${modelId}"`,
        // Approvals go to the person. Codex's automatic approval reviewer is a
        // separate agent on Codex's own reviewer model (`codex-auto-review` in
        // the bundled catalogue), which Tomverse does not offer; /review runs on
        // the chosen model. Both keys accepted by Codex 0.146 and 0.169.
        'approvals_reviewer = "user"',
        `review_model = "${modelId}"`,
        'web_search = "disabled"',
        `model_context_window = ${model.contextWindowTokens}`,
        `model_auto_compact_token_limit = ${plannedInputWindow(model)}`,
    ].join("\n");
    return {
        providerToml: provider,
        profileToml: selection,
        defaultToml: `${selection}\n\n${provider}`,
        powershellKey: `$env:TOMVERSE_API_KEY = "${KEY_PLACEHOLDER}"\ncodex --profile tomverse`,
        posixKey: `export TOMVERSE_API_KEY="${KEY_PLACEHOLDER}"\ncodex --profile tomverse`,
    };
};

/**
 * Cursor: the OpenAI key and base-URL override in Cursor Settings > Models.
 * Cursor sends these requests from its own backend, so the base URL must be
 * public HTTPS; a localhost URL cannot work.
 */
export const cursorConfig = (openAiBaseUrl: string, model: ExternalApiModelCapabilities, apiKey: string = KEY_PLACEHOLDER) =>
    [`OpenAI API Key: ${apiKey}`, `Override OpenAI Base URL: ${openAiBaseUrl}`, `Custom model: ${model.id}`].join("\n");

/**
 * One native protocol's models, Smart Adaptive first and scoped to that
 * protocol's provider (nativeSmartAdaptiveCapabilities): Claude Code routes
 * among Anthropic models, Codex among OpenAI models.
 */
const nativeToolModels = (models: readonly ExternalApiModelCapabilities[], protocol: "anthropic_messages" | "responses") => {
    const fixed = models.filter((model) => model.id !== SMART_ADAPTIVE_MODEL_ID && model.protocols?.includes(protocol));
    const smart = models.find((model) => model.id === SMART_ADAPTIVE_MODEL_ID && model.protocols?.includes(protocol));
    // With only the Smart Adaptive entry to hand (which tools a model serves),
    // it stands as it is. Its default, and whether it is offered at all, leave
    // frontier and apex models out (routerPickOnly), as the gateway does.
    const native = smart && (fixed.length ? nativeSmartAdaptiveCapabilities(fixed, DEFAULT_MODEL_ID) : smart);
    // Smart Adaptive also routes to models no client names directly (frontier,
    // apex): the most a request costs is over those too, on this protocol only.
    const ceiling = smart?.creditWeightByProtocol?.[protocol];
    const scoped = native && ceiling !== undefined ? { ...native, creditWeight: Math.max(native.creditWeight, ceiling) } : native;
    return scoped ? [scoped, ...fixed] : fixed;
};

/** The models each tool can use: its protocol's, in the order offered. */
export const codingToolModels = (models: readonly ExternalApiModelCapabilities[]) => ({
    claudeCode: nativeToolModels(models, "anthropic_messages"),
    codex: nativeToolModels(models, "responses"),
    // Smart Adaptive first: Cursor Chat, Agent and Stop were verified with it
    // on production (2026-11-20, docs/policy/external-api.md 10.5).
    cursor: [
        ...models.filter((model) => model.id === SMART_ADAPTIVE_MODEL_ID && (model.protocols?.includes("chat_completions") ?? true)),
        ...models.filter((model) => (model.protocols?.includes("chat_completions") ?? true) && model.id !== SMART_ADAPTIVE_MODEL_ID),
    ],
});

/**
 * The Tomverse CLI (apps/tomverse-cli): what Settings shows once the CLI is
 * published. Off by default (TOMVERSE_CLI_GUIDE_ENABLED) so the page never
 * tells anyone to install something that is not released yet. `install` is
 * the npm command (macOS, Linux, or anywhere Node.js 22 is present) and
 * `installWindows` the winget one; the installers (.msi, .pkg, .deb, .rpm) are
 * on the install page, /developers/cli (components/marketing/v2/cli). The key
 * goes into an environment variable for the current shell only; the CLI also
 * asks for it, hidden, when it is not set. The CLI is a coding API client:
 * its endpoint is the coding API's base (apps/tomverse-cli/src/config.ts).
 */
export const TOMVERSE_CLI_DEFAULT_ENDPOINT = "https://tomverse.app/api/code/v1";

export const tomverseCliGuide = (env: Record<string, string | undefined>, codingBaseUrl: string) => {
    if (env.TOMVERSE_CLI_GUIDE_ENABLED !== "true") return null;
    // Single-quoted for both shells, so the URL is one argument whatever it contains.
    const quoted = `'${codingBaseUrl.replaceAll("'", "")}'`;
    const endpoint = codingBaseUrl === TOMVERSE_CLI_DEFAULT_ENDPOINT ? [] : [`tomverse config set endpoint ${quoted}`];
    return {
        install: "npm install -g @tomverse/cli",
        installWindows: "winget install Tomverse.CLI",
        powershell: [`$env:TOMVERSE_API_KEY = "${KEY_PLACEHOLDER}"`, ...endpoint, "tomverse doctor"].join("\n"),
        posix: [`export TOMVERSE_API_KEY="${KEY_PLACEHOLDER}"`, ...endpoint, "tomverse doctor"].join("\n"),
    };
};
