import { KEY_PLACEHOLDER, type ExternalApiModelCapabilities } from "@/lib/externalApiCatalogCore";
import { anthropicBaseUrl } from "@/lib/externalApiCodingTools";

/**
 * Which tool belongs to which of the two external APIs, and the values each
 * app asks for (owner decision 2026-11-21; docs/policy/external-api.md,
 * "Client setup"). Pure, so the settings tab, the key page and the tests read
 * one list. Menu names move between app versions: the guides carry only the
 * values to enter -- address, model id, key.
 */

export const EXTERNAL_API_GUIDE_SURFACES = ["general", "coding"] as const;
export type ExternalApiGuideSurface = (typeof EXTERNAL_API_GUIDE_SURFACES)[number];

export type ExternalApiPlatform =
    | "aside"
    | "brave-leo"
    | "raycast"
    | "browseros"
    | "other"
    | "tomverse-cli"
    | "claude-code"
    | "codex"
    | "cursor"
    | "vscode"
    | "jetbrains";

/** The tools each API serves, in the order they are offered. */
export const EXTERNAL_API_PLATFORMS: Record<ExternalApiGuideSurface, readonly ExternalApiPlatform[]> = {
    general: ["aside", "brave-leo", "raycast", "browseros", "other"],
    coding: ["tomverse-cli", "claude-code", "codex", "cursor", "vscode", "jetbrains"],
};

/** Product names, which are not translated. `other` is a localized label the caller adds. */
export const EXTERNAL_API_PLATFORM_NAMES: Record<Exclude<ExternalApiPlatform, "other">, string> = {
    aside: "Aside",
    "brave-leo": "Brave Leo",
    raycast: "Raycast",
    browseros: "BrowserOS",
    "tomverse-cli": "Tomverse CLI",
    "claude-code": "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    vscode: "VS Code",
    jetbrains: "JetBrains",
};

export const externalApiPlatformSurface = (platform: ExternalApiPlatform): ExternalApiGuideSurface =>
    EXTERNAL_API_PLATFORMS.coding.includes(platform) ? "coding" : "general";

export const isExternalApiPlatform = (value: unknown): value is ExternalApiPlatform =>
    typeof value === "string" &&
    [...EXTERNAL_API_PLATFORMS.general, ...EXTERNAL_API_PLATFORMS.coding].includes(value as ExternalApiPlatform);

/** The two address forms of one API: OpenAI format and Anthropic format. */
export const externalApiAddresses = (openAiBaseUrl: string) => ({
    openAi: openAiBaseUrl,
    anthropic: anthropicBaseUrl(openAiBaseUrl),
});

/**
 * Brave Leo (Settings > Leo > Bring your own model). It wants the whole
 * endpoint path, unlike most apps, and handles text in and out only.
 */
export const braveLeoConfig = (baseUrl: string, modelId: string, apiKey: string = KEY_PLACEHOLDER) =>
    [`Server endpoint: ${baseUrl}/chat/completions`, `Model request name: ${modelId}`, `API Key: ${apiKey}`].join("\n");

/** BrowserOS (chrome://browseros/settings > "OpenAI Compatible"). */
export const browserOsConfig = (baseUrl: string, modelId: string, apiKey: string = KEY_PLACEHOLDER) =>
    [`Base URL: ${baseUrl}`, `Model ID: ${modelId}`, `API Key: ${apiKey}`].join("\n");

/** JetBrains AI Assistant, OpenAI-compatible provider (no Anthropic format). */
export const jetBrainsConfig = (codingBaseUrl: string, apiKey: string = KEY_PLACEHOLDER) =>
    [`URL: ${codingBaseUrl}`, `API Key: ${apiKey}`].join("\n");

const yamlString = (value: string) => JSON.stringify(value);

/**
 * Raycast `~/.config/raycast/ai/providers.yaml`. `base_url` stops at `/v1`
 * (Raycast adds `/chat/completions`) and the model list is required. Tools
 * need an `abilities.tools` flag here plus a top-level `tools` block, which
 * the person adds from Raycast's guide.
 */
export const raycastProvidersYaml = (
    baseUrl: string,
    models: readonly ExternalApiModelCapabilities[],
    apiKey: string = KEY_PLACEHOLDER
) =>
    [
        "providers:",
        "  - id: tomverse",
        "    name: Tomverse",
        `    base_url: ${baseUrl}`,
        "    api_keys:",
        `      tomverse: ${yamlString(apiKey)}`,
        "    models:",
        ...models.flatMap((model) => [
            `      - id: ${yamlString(model.id)}`,
            `        name: ${yamlString(`${model.name} (Tomverse)`)}`,
            "        provider: tomverse",
            `        context: ${model.contextWindowTokens}`,
            "        abilities:",
            "          tools:",
            "            supported: true",
            ...(model.vision ? ["          vision:", "            supported: true"] : []),
        ]),
    ].join("\n");

/** The label an API shows on a request row; null is a request recorded before the column existed. */
export const externalApiSurfaceKey = (surface: string | null | undefined): ExternalApiGuideSurface | null =>
    surface === "coding" || surface === "general" ? surface : null;

/**
 * The models a tool's configuration carries, and the ones its checkboxes show
 * ticked -- one list, so the copied text and the screen cannot disagree. Each
 * API keeps its own selection over its own models. What was ticked and is no
 * longer offered is dropped; an empty result falls back to Smart Adaptive when
 * the list has it, else the first model, so a copied configuration is never
 * empty.
 */
export const effectiveModelPick = (
    models: readonly Pick<ExternalApiModelCapabilities, "id">[],
    picked: readonly string[] | null
): string[] => {
    const offered = new Set(models.map((model) => model.id));
    const kept = (picked ?? []).filter((id) => offered.has(id));
    if (kept.length) return kept;
    const fallback = models.find((model) => model.id === "smart-adaptive") ?? models[0];
    return fallback ? [fallback.id] : [];
};
