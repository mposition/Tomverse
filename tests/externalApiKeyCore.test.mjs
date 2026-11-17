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
    externalApiModelIds,
    externalApiUserAllowed,
    isExternalApiServableModel,
    KEY_PLACEHOLDER,
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

test("exposure needs the switch, the account, the operator list, the registry and the plan", () => {
    assert.equal(externalApiEnabled({}), false);
    assert.equal(externalApiEnabled({ EXTERNAL_API_ENABLED: "TRUE" }), false);
    assert.equal(externalApiEnabled({ EXTERNAL_API_ENABLED: "true" }), true);
    assert.equal(externalApiUserAllowed({}, "u1"), false);
    assert.equal(externalApiUserAllowed({ EXTERNAL_API_ALLOWED_USER_IDS: "u2, u1" }, "u1"), true);
    assert.equal(externalApiUserAllowed({ EXTERNAL_API_ALLOWED_USER_IDS: "*" }, "anyone"), true);
    const listed = externalApiModelIds({ EXTERNAL_API_MODEL_IDS: "fixture, fixture,other" });
    assert.deepEqual(listed, ["fixture", "other"]);
    assert.equal(isExternalApiServableModel(baseModel, "Pro", listed), true);
    assert.equal(isExternalApiServableModel(baseModel, "Free", listed), false, "plan");
    assert.equal(isExternalApiServableModel(baseModel, "Pro", []), false, "not listed");
    assert.equal(isExternalApiServableModel({ ...baseModel, enabled: false }, "Pro", listed), false);
    assert.equal(isExternalApiServableModel({ ...baseModel, status: "disabled" }, "Pro", listed), false);
    assert.equal(isExternalApiServableModel({ ...baseModel, catalogDeleted: true }, "Pro", listed), false);
    assert.equal(isExternalApiServableModel({ ...baseModel, usageClass: "deep-research" }, "Max", listed), false);
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
