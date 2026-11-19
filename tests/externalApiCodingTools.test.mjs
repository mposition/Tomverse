import assert from "node:assert/strict";
import test from "node:test";
import {
    anthropicBaseUrl,
    claudeCodeConfig,
    codexConfig,
    codexModelId,
    codingToolModels,
    cursorConfig,
    tomverseCliGuide,
} from "../lib/externalApiCodingTools.ts";
import { KEY_PLACEHOLDER } from "../lib/externalApiCatalogCore.ts";

/**
 * The copyable coding-tool configurations (Settings > API keys). Their shape
 * is the one verified on 2026-11-18 with Claude Code 2.1.278 and Codex 0.146.0
 * against the gateway (docs/policy/external-api.md, "Coding tools").
 */

const model = (id, extra = {}) => ({
    id,
    name: id,
    provider: "x",
    tools: true,
    vision: true,
    reasoning: true,
    contextWindowTokens: 192_000,
    maxOutputTokens: 64_000,
    creditWeight: 6,
    protocols: ["chat_completions"],
    ...extra,
});
const sonnet = model("claude-sonnet-5", { provider: "anthropic", protocols: ["chat_completions", "anthropic_messages"], providerModelId: "claude-sonnet-5" });
const haiku = model("claude-haiku-4-5", { provider: "anthropic", creditWeight: 1, protocols: ["chat_completions", "anthropic_messages"], providerModelId: "claude-haiku-4-5-20251001" });
const luna = model("gpt-5-6-luna", { provider: "openai", maxOutputTokens: 128_000, contextWindowTokens: 256_000, protocols: ["chat_completions", "responses"], providerModelId: "gpt-5.6-luna" });
const gpt55 = model("gpt-5-5", { provider: "openai", protocols: ["chat_completions", "responses"], providerModelId: "gpt-5.5" });
const gpt55Thinking = model("gpt-5-5-thinking", { provider: "openai", protocols: ["chat_completions", "responses"], providerModelId: "gpt-5.5" });
const smart = model("smart-adaptive", { provider: "tomverse", protocols: ["chat_completions"] });
const BASE = "https://tomverse.example/api/v1";

test("Claude Code: Anthropic namespace, every model alias pinned, 5-minute cache, placeholder key", () => {
    assert.equal(anthropicBaseUrl(BASE), "https://tomverse.example/api/anthropic");
    const config = claudeCodeConfig(BASE, sonnet, [sonnet, haiku]);
    const env = Object.fromEntries(config.env);
    assert.equal(env.ANTHROPIC_BASE_URL, "https://tomverse.example/api/anthropic", "Claude Code appends /v1/messages itself");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEY_PLACEHOLDER);
    for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
        assert.equal(env[name], "claude-sonnet-5", name);
    }
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-haiku-4-5", "background work goes to the cheapest offered model");
    assert.equal(env.FORCE_PROMPT_CACHING_5M, "1");
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000");
    const window = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    assert.ok(window >= 100_000 && window <= 1_000_000, "inside Claude Code's accepted range");
    assert.ok(window <= sonnet.contextWindowTokens - sonnet.maxOutputTokens, "compacts before Tomverse's input limit");
    assert.ok(!("ANTHROPIC_API_KEY" in env), "one credential variable");
    const vscode = JSON.parse(config.vscodeSettings);
    assert.equal(vscode["claudeCode.disableLoginPrompt"], true);
    assert.deepEqual(vscode["claudeCode.environmentVariables"].map((entry) => entry.name), config.env.map(([name]) => name));
    assert.match(config.powershell, /^\$env:ANTHROPIC_BASE_URL = "https:\/\/tomverse\.example\/api\/anthropic"$/m);
    assert.match(config.posix, /^export ANTHROPIC_AUTH_TOKEN="<YOUR_TOMVERSE_API_KEY>"$/m);
    // A key passed in (just created) is the only way a secret enters it.
    assert.equal(Object.fromEntries(claudeCodeConfig(BASE, sonnet, [sonnet], "tv_secret").env).ANTHROPIC_AUTH_TOKEN, "tv_secret");
});

test("Codex: a separate provider and profile, no retries, no WebSocket, no hosted web search", () => {
    const config = codexConfig(BASE, luna, [luna, gpt55, gpt55Thinking]);
    for (const line of [
        "[model_providers.tomverse]",
        `base_url = "${BASE}"`,
        'env_key = "TOMVERSE_API_KEY"',
        'wire_api = "responses"',
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "supports_websockets = false",
    ]) {
        assert.ok(config.providerToml.split("\n").includes(line), line);
    }
    assert.ok(!/model_provider =/.test(config.providerToml), "adding the provider changes no default");
    assert.ok(config.profileToml.includes('model_provider = "tomverse"'));
    assert.ok(config.profileToml.includes('model = "gpt-5.6-luna"'), "the provider id, so Codex offers its freeform apply_patch");
    assert.ok(config.profileToml.includes('web_search = "disabled"'));
    assert.ok(config.profileToml.includes('approvals_reviewer = "user"'), "no automatic reviewer on a model the person did not pick");
    assert.ok(config.profileToml.includes('review_model = "gpt-5.6-luna"'));
    assert.ok(config.profileToml.includes("model_context_window = 256000"));
    const compactAt = Number(/model_auto_compact_token_limit = (\d+)/.exec(config.profileToml)[1]);
    assert.ok(compactAt < luna.contextWindowTokens - luna.maxOutputTokens);
    assert.ok(config.defaultToml.startsWith('model_provider = "tomverse"'), "top-level keys before the table");
    assert.match(config.powershellKey, /codex --profile tomverse/);
    for (const text of Object.values(config)) assert.ok(!/tv_[A-Za-z0-9]{8,}/.test(text), "no secret");
    // A provider id shared by two Tomverse models is ambiguous: the Tomverse id is sent.
    assert.equal(codexModelId(gpt55, [luna, gpt55, gpt55Thinking]), "gpt-5-5");
    assert.equal(codexModelId(luna, [luna, gpt55, gpt55Thinking]), "gpt-5.6-luna");
});

test("Cursor and the per-tool model lists", () => {
    const text = cursorConfig(BASE, luna);
    assert.match(text, /Override OpenAI Base URL: https:\/\/tomverse\.example\/api\/v1/);
    assert.match(text, /Custom model: gpt-5-6-luna/);
    assert.match(text, /<YOUR_TOMVERSE_API_KEY>/);
    const lists = codingToolModels([smart, sonnet, haiku, luna]);
    assert.deepEqual(lists.claudeCode.map((m) => m.id), ["claude-sonnet-5", "claude-haiku-4-5"]);
    assert.deepEqual(lists.codex.map((m) => m.id), ["gpt-5-6-luna"]);
    assert.ok(!lists.cursor.some((m) => m.id === "smart-adaptive"), "Agent starts on a fixed model");
    assert.ok(![...lists.claudeCode, ...lists.codex].some((m) => m.id === "smart-adaptive"), "never on a native protocol");
});

test("a request names a model by Tomverse id or by one offered model's provider id, never another model", async () => {
    const { pickRequestedModel } = await import("../lib/externalApiProtocols.ts");
    const entries = [
        { model: { id: "gpt-5-6-luna", apiModel: "gpt-5.6-luna" } },
        { model: { id: "claude-sonnet-5", apiModel: "claude-sonnet-5" } },
        { model: { id: "fast-a", apiModel: "shared-id" } },
        { model: { id: "fast-b", apiModel: "shared-id" } },
    ];
    assert.equal(pickRequestedModel(entries, "gpt-5-6-luna").entry.model.id, "gpt-5-6-luna");
    assert.equal(pickRequestedModel(entries, "gpt-5.6-luna").entry.model.id, "gpt-5-6-luna");
    assert.equal(pickRequestedModel(entries, "claude-sonnet-5").entry.model.id, "claude-sonnet-5");
    assert.deepEqual(pickRequestedModel(entries, "shared-id").ambiguous.map((entry) => entry.model.id), ["fast-a", "fast-b"]);
    assert.equal(pickRequestedModel(entries, "gpt-5.6-sol"), null);
});

test("Tomverse CLI guide: off until published; key in the shell only; endpoint only when not the default", () => {
    assert.equal(tomverseCliGuide({}, "https://tomverse.app/api/v1"), null);
    assert.equal(tomverseCliGuide({ TOMVERSE_CLI_GUIDE_ENABLED: "1" }, "https://tomverse.app/api/v1"), null);
    const guide = tomverseCliGuide({ TOMVERSE_CLI_GUIDE_ENABLED: "true" }, "https://tomverse.app/api/v1");
    assert.equal(guide.install, "npm install -g @tomverse/cli");
    assert.equal(guide.powershell, `$env:TOMVERSE_API_KEY = "${KEY_PLACEHOLDER}"\ntomverse doctor`);
    assert.equal(guide.posix, `export TOMVERSE_API_KEY="${KEY_PLACEHOLDER}"\ntomverse doctor`);
    const staging = tomverseCliGuide({ TOMVERSE_CLI_GUIDE_ENABLED: "true" }, "https://dev.tomverse.app/api/v1");
    assert.match(staging.posix, /tomverse config set endpoint 'https:\/\/dev\.tomverse\.app\/api\/v1'/);
    assert.match(tomverseCliGuide({ TOMVERSE_CLI_GUIDE_ENABLED: "true" }, "https://x.example/api/v1;rm -rf ~").posix, /endpoint 'https:\/\/x\.example\/api\/v1;rm -rf ~'/, "quoted as one argument");
    assert.ok(!/--api-key/.test(staging.posix + staging.powershell), "the key is never a command-line argument");
});
