import assert from "node:assert/strict";
import test from "node:test";
import {
    digestExternalApiKey,
    EXTERNAL_API_KEY_PREFIX_PATTERN,
    externalApiKeyExpiry,
    externalApiKeyState,
    generateExternalApiKey,
    normalizeExternalApiCreditCap,
    normalizeExternalApiKeyName,
    parseExternalApiBearer,
} from "../lib/externalApiKeyCore.ts";
import {
    asideProviderConfig,
    externalApiEnabled,
    externalApiModelCapabilities,
    externalApiPlanAllowed,
    externalApiUserAllowed,
    isExternalApiServableModel,
    KEY_PLACEHOLDER,
    SMART_ADAPTIVE_MODEL_ID,
    smartAdaptiveCapabilities,
    smartAdaptiveRouterEnabled,
    toOpenAiModelEntry,
    vscodeCustomEndpointConfig,
} from "../lib/externalApiCatalogCore.ts";

test("keys are high-entropy, prefixed, and stored only as a digest", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
        const { key, keyPrefix, secretDigest } = generateExternalApiKey();
        assert.match(keyPrefix, EXTERNAL_API_KEY_PREFIX_PATTERN);
        assert.ok(key.startsWith(`${keyPrefix}_`));
        assert.equal(key.length, keyPrefix.length + 1 + 43);
        assert.match(secretDigest, /^[0-9a-f]{64}$/);
        assert.equal(secretDigest, digestExternalApiKey(key));
        assert.ok(!secretDigest.includes(key.slice(keyPrefix.length + 1)));
        seen.add(key);
    }
    assert.equal(seen.size, 200);
});

test("bearer parsing never treats a malformed header as absent", () => {
    const { key } = generateExternalApiKey();
    assert.deepEqual(parseExternalApiBearer(null), { kind: "missing" });
    assert.deepEqual(parseExternalApiBearer("  "), { kind: "missing" });
    assert.equal(parseExternalApiBearer(`Bearer ${key}`).kind, "key");
    assert.equal(parseExternalApiBearer(`bearer   ${key}`).kind, "key");
    for (const bad of [key, `Basic ${key}`, `Bearer ${key} extra`, "Bearer sk-openai-style", `Bearer ${key}x`, "Bearer tvk_short_abc"]) {
        assert.equal(parseExternalApiBearer(bad).kind, "malformed", bad);
    }
});

test("names, caps and expiry are normalised or refused", () => {
    assert.equal(normalizeExternalApiKeyName("  My   laptop "), "My laptop");
    assert.equal(normalizeExternalApiKeyName(""), null);
    assert.equal(normalizeExternalApiKeyName("x".repeat(81)), null);
    assert.equal(normalizeExternalApiKeyName("bad\u0000name"), null);
    assert.equal(normalizeExternalApiCreditCap(null), null);
    assert.equal(normalizeExternalApiCreditCap(500), 500);
    for (const bad of [0, -1, 1.5, 1_000_001, "5"]) assert.equal(normalizeExternalApiCreditCap(bad), undefined);
    const now = new Date("2026-11-17T00:00:00Z");
    assert.equal(externalApiKeyExpiry(null, now), null);
    assert.equal(externalApiKeyExpiry(30, now).toISOString(), "2026-12-17T00:00:00.000Z");
    assert.equal(externalApiKeyExpiry(3, now), undefined);
    assert.equal(externalApiKeyState({ revokedAt: null, expiresAt: null }, now), "active");
    assert.equal(externalApiKeyState({ revokedAt: null, expiresAt: now }, now), "expired");
    assert.equal(externalApiKeyState({ revokedAt: now, expiresAt: null }, now), "revoked");
});

const baseModel = {
    id: "fixture",
    name: "Fixture",
    apiModel: "fixture-upstream",
    provider: "openai",
    icon: "",
    bestFor: "",
    minimumPlan: "Pro",
    usageClass: "standard",
    enabled: true,
    status: "enabled",
    contextWindowTokens: 400_000,
    inputCapabilities: { image: true, nativePdf: false },
};

test("exposure needs the switch, the account, the registry and the plan", () => {
    assert.equal(externalApiEnabled({}), false);
    assert.equal(externalApiEnabled({ EXTERNAL_API_ENABLED: "TRUE" }), false);
    assert.equal(externalApiEnabled({ EXTERNAL_API_ENABLED: "true" }), true);
    assert.equal(externalApiUserAllowed({}, "u1"), false);
    assert.equal(externalApiUserAllowed({ EXTERNAL_API_ALLOWED_USER_IDS: "u2, u1" }, "u1"), true);
    assert.equal(externalApiUserAllowed({ EXTERNAL_API_ALLOWED_USER_IDS: "*" }, "anyone"), true);
    // Paid plans only, whatever the allowlist says.
    assert.equal(externalApiPlanAllowed("Free"), false);
    assert.equal(externalApiPlanAllowed("Pro"), true);
    assert.equal(externalApiPlanAllowed("Max"), true);
    assert.equal(externalApiPlanAllowed(undefined), false, "an unknown tier is not a paid plan");
    // The catalogue is the only list: no second, operator-kept list of ids.
    assert.equal(isExternalApiServableModel(baseModel, "Pro"), true);
    assert.equal(isExternalApiServableModel(baseModel, "Free"), false, "plan");
    assert.equal(isExternalApiServableModel({ ...baseModel, enabled: false }, "Pro"), false);
    assert.equal(isExternalApiServableModel({ ...baseModel, status: "disabled" }, "Pro"), false);
    assert.equal(isExternalApiServableModel({ ...baseModel, catalogDeleted: true }, "Pro"), false);
    assert.equal(isExternalApiServableModel({ ...baseModel, usageClass: "deep-research" }, "Max"), false);
});

test("client configs carry the real model facts and never a stored secret", () => {
    const caps = externalApiModelCapabilities(baseModel, { maxInputTokens: 200_000, maxOutputTokens: 16_000, creditWeight: 2 });
    assert.equal(caps.contextWindowTokens, 216_000, "bounded by what this API accepts");
    assert.equal(caps.vision, true);
    const entry = toOpenAiModelEntry(caps);
    assert.equal(entry.id, "fixture");
    assert.equal(entry.tomverse.max_output_tokens, 16_000);
    const aside = asideProviderConfig("https://tomverse.app/api/v1", [caps]);
    const provider = aside.providers.tomverse;
    assert.equal(provider.api, "openai-completions");
    assert.equal(provider.authHeader, true);
    assert.equal(provider.apiKey, KEY_PLACEHOLDER);
    assert.deepEqual(provider.models[0].input, ["text", "image"]);
    assert.equal(provider.models[0].maxTokens, 16_000);
    assert.equal(asideProviderConfig("u", [caps], "tvk_x").providers.tomverse.apiKey, "tvk_x");
    const vscode = vscodeCustomEndpointConfig("https://tomverse.app/api/v1", [caps]);
    assert.equal(vscode[0].vendor, "customendpoint");
    assert.match(vscode[0].apiKey, /^\$\{input:[A-Za-z]+\}$/);
    assert.equal(vscode[0].models[0].url, "https://tomverse.app/api/v1/chat/completions");
    assert.equal(vscode[0].models[0].maxInputTokens + vscode[0].models[0].maxOutputTokens, caps.contextWindowTokens);
    assert.ok(!JSON.stringify(vscode).includes("tvk_"));
});

test("Smart Adaptive is offered with any model, its router call is off by default, and it advertises the most a candidate offers", () => {
    assert.equal(smartAdaptiveRouterEnabled({}), false);
    assert.equal(smartAdaptiveRouterEnabled({ EXTERNAL_API_SMART_ADAPTIVE_ROUTER_ENABLED: "true" }), true);
    const a = { id: "a", name: "A", provider: "openai", tools: true, vision: true, reasoning: true, contextWindowTokens: 200_000, maxOutputTokens: 64_000, creditWeight: 1 };
    const b = { id: "b", name: "B", provider: "deepseek", tools: true, vision: false, reasoning: false, contextWindowTokens: 128_000, maxOutputTokens: 8_000, creditWeight: 3 };
    assert.equal(smartAdaptiveCapabilities([]), null);
    assert.equal(smartAdaptiveCapabilities([a]).id, SMART_ADAPTIVE_MODEL_ID, "a stable id even with one model");
    const smart = smartAdaptiveCapabilities([a, b]);
    assert.equal(smart.id, SMART_ADAPTIVE_MODEL_ID);
    assert.equal(smart.contextWindowTokens, 200_000, "requests are routed only to a model they fit");
    assert.equal(smart.maxOutputTokens, 8_000, "without the default model, the limit every candidate meets");
    assert.equal(smartAdaptiveCapabilities([a, b], "a").maxOutputTokens, 64_000, "the default model's limit, not the smallest");
    assert.equal(smart.creditWeight, 3, "the most a request can cost");
    assert.equal(smart.vision, true, "images are routed to a model that reads them");
    assert.equal(vscodeCustomEndpointConfig("https://x/api/v1", [smart])[0].models[0].name, "Smart Adaptive (Tomverse)");
});
