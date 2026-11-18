import { KEY_PLACEHOLDER, type ExternalApiModelCapabilities } from "@/lib/externalApiCatalogCore";

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

/** `https://host/api/v1` -> `https://host/api/anthropic` (Claude Code adds /v1). */
export const anthropicBaseUrl = (openAiBaseUrl: string) => openAiBaseUrl.replace(/\/api\/v1$/, "/api/anthropic");

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
    const small = byCredits(available)[0] ?? main;
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
 * on it), otherwise the Tomverse id. The gateway accepts both.
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

/** The models each tool can use: its protocol's, in the order offered. */
export const codingToolModels = (models: readonly ExternalApiModelCapabilities[]) => ({
    claudeCode: models.filter((model) => model.protocols?.includes("anthropic_messages")),
    codex: models.filter((model) => model.protocols?.includes("responses")),
    // Cursor's Agent is verified with a fixed model first; Smart Adaptive is
    // offered on Chat Completions but not recommended here until verified.
    cursor: models.filter((model) => (model.protocols?.includes("chat_completions") ?? true) && model.id !== "smart-adaptive"),
});
