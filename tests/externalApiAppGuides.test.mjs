import assert from "node:assert/strict";
import test from "node:test";
import {
    braveLeoConfig,
    browserOsConfig,
    effectiveModelPick,
    EXTERNAL_API_PLATFORMS,
    externalApiAddresses,
    externalApiPlatformSurface,
    externalApiSurfaceKey,
    isExternalApiPlatform,
    jetBrainsConfig,
    raycastProvidersYaml,
} from "../lib/externalApiAppGuides.ts";
import { codingApiBaseUrl } from "../lib/externalApiCodingTools.ts";
import { KEY_PLACEHOLDER } from "../lib/externalApiCatalogCore.ts";

/**
 * Which tool belongs to which API, and the values each new app asks for
 * (docs/policy/external-api.md, "Client setup"; owner decision 2026-11-21).
 */

const GENERAL = "https://tomverse.app/api/v1";
const CODING = codingApiBaseUrl(GENERAL);
const model = (id, extra = {}) => ({
    id,
    name: id,
    provider: "x",
    tools: true,
    vision: false,
    reasoning: false,
    contextWindowTokens: 128000,
    maxOutputTokens: 8000,
    creditWeight: 1,
    protocols: ["chat_completions"],
    ...extra,
});

test("every tool is on exactly one API, in the agreed groups", () => {
    assert.deepEqual(EXTERNAL_API_PLATFORMS.general, ["aside", "brave-leo", "raycast", "browseros", "other"]);
    assert.deepEqual(EXTERNAL_API_PLATFORMS.coding, ["tomverse-cli", "claude-code", "codex", "cursor", "vscode", "jetbrains"]);
    const all = [...EXTERNAL_API_PLATFORMS.general, ...EXTERNAL_API_PLATFORMS.coding];
    assert.equal(new Set(all).size, all.length);
    for (const id of EXTERNAL_API_PLATFORMS.general) assert.equal(externalApiPlatformSurface(id), "general");
    for (const id of EXTERNAL_API_PLATFORMS.coding) assert.equal(externalApiPlatformSurface(id), "coding");
    assert.equal(isExternalApiPlatform("jetbrains"), true);
    assert.equal(isExternalApiPlatform("nope"), false);
});

test("each API has an OpenAI-format and an Anthropic-format address", () => {
    assert.deepEqual(externalApiAddresses(GENERAL), {
        openAi: "https://tomverse.app/api/v1",
        anthropic: "https://tomverse.app/api/anthropic",
    });
    assert.deepEqual(externalApiAddresses(CODING), {
        openAi: "https://tomverse.app/api/code/v1",
        anthropic: "https://tomverse.app/api/code/anthropic",
    });
});

test("Brave Leo takes the full chat completions path", () => {
    const text = braveLeoConfig(GENERAL, "smart-adaptive");
    assert.match(text, /^Server endpoint: https:\/\/tomverse\.app\/api\/v1\/chat\/completions$/m);
    assert.match(text, /^Model request name: smart-adaptive$/m);
    assert.match(text, new RegExp(`^API Key: ${KEY_PLACEHOLDER}$`, "m"));
});

test("BrowserOS takes the base URL without the path", () => {
    const text = browserOsConfig(GENERAL, "smart-adaptive", "tvk_example");
    assert.match(text, /^Base URL: https:\/\/tomverse\.app\/api\/v1$/m);
    assert.match(text, /^API Key: tvk_example$/m);
});

test("Raycast's base_url stops at /v1 and lists the picked models", () => {
    const yaml = raycastProvidersYaml(GENERAL, [model("smart-adaptive", { name: "Smart Adaptive", vision: true }), model("gpt-6-luna")]);
    assert.match(yaml, /^ {4}base_url: https:\/\/tomverse\.app\/api\/v1$/m);
    assert.doesNotMatch(yaml, /chat\/completions/);
    assert.match(yaml, /api_keys:\n {6}tomverse: "<YOUR_TOMVERSE_API_KEY>"/);
    assert.match(yaml, /- id: "smart-adaptive"/);
    assert.match(yaml, /- id: "gpt-6-luna"/);
    assert.match(yaml, /context: 128000/);
    // Vision only where the model has it.
    assert.equal((yaml.match(/vision:/g) ?? []).length, 1);
    assert.equal((yaml.match(/tools:/g) ?? []).length, 2);
});

test("JetBrains takes the coding URL and the key", () => {
    const text = jetBrainsConfig(CODING);
    assert.equal(text, `URL: https://tomverse.app/api/code/v1\nAPI Key: ${KEY_PLACEHOLDER}`);
});

test("a request row's API: coding, general, or not recorded", () => {
    assert.equal(externalApiSurfaceKey("coding"), "coding");
    assert.equal(externalApiSurfaceKey("general"), "general");
    assert.equal(externalApiSurfaceKey(null), null);
    assert.equal(externalApiSurfaceKey(undefined), null);
    assert.equal(externalApiSurfaceKey("other"), null);
});

test("the effective pick is what the boxes show and what the file carries", () => {
    const general = [model("smart-adaptive"), model("gpt-6-luna"), model("general-only")];
    const coding = [model("coding-only"), model("gpt-6-luna")];
    // Nothing ticked: Smart Adaptive when offered, else the first model.
    assert.deepEqual(effectiveModelPick(general, null), ["smart-adaptive"]);
    assert.deepEqual(effectiveModelPick(coding, null), ["coding-only"]);
    assert.deepEqual(effectiveModelPick([], null), []);
    // A tick the other API's list never offered is dropped, not carried over.
    assert.deepEqual(effectiveModelPick(coding, ["general-only"]), ["coding-only"]);
    assert.deepEqual(effectiveModelPick(coding, ["general-only", "gpt-6-luna"]), ["gpt-6-luna"]);
    // Each API's selection is its own.
    const pickedGeneral = ["general-only"];
    assert.deepEqual(effectiveModelPick(general, pickedGeneral), ["general-only"]);
    assert.deepEqual(effectiveModelPick(coding, null), ["coding-only"]);
});
