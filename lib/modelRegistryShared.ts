import {
  AVAILABLE_MODELS,
  getModelBillingProfile,
  getModelUsageProfile,
  type AiModel,
  type AiProvider,
} from "@/lib/models";

export const AI_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "xai",
  "deepseek",
  "mistral",
  "moonshot",
  "minimax",
  "qwen",
  "zhipu",
  "perplexity",
] as const satisfies readonly AiProvider[];

export const PROVIDER_API_CONFIGURATION: Record<
  AiProvider,
  { baseUrl: string; apiKeyEnvName: string; protocol: "native" | "openai-compatible" }
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvName: "OPENAI_API_KEY",
    protocol: "native",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    apiKeyEnvName: "ANTHROPIC_API_KEY",
    protocol: "native",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnvName: "GOOGLE_GENERATIVE_AI_API_KEY",
    protocol: "native",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvName: "GROQ_API_KEY",
    protocol: "openai-compatible",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnvName: "XAI_API_KEY",
    protocol: "openai-compatible",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKeyEnvName: "DEEPSEEK_API_KEY",
    protocol: "openai-compatible",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnvName: "MISTRAL_API_KEY",
    protocol: "openai-compatible",
  },
  moonshot: {
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnvName: "MOONSHOT_API_KEY",
    protocol: "openai-compatible",
  },
  minimax: {
    // The Anthropic-compatible route keeps reasoning blocks separate from
    // user-visible answer text; MiniMax's OpenAI route embeds <think> in it.
    baseUrl: "https://api.minimax.io/anthropic/v1",
    apiKeyEnvName: "MINIMAX_API_KEY",
    protocol: "native",
  },
  qwen: {
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvName: "DASHSCOPE_API_KEY",
    protocol: "openai-compatible",
  },
  zhipu: {
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnvName: "ZHIPU_API_KEY",
    protocol: "openai-compatible",
  },
  perplexity: {
    baseUrl: "https://api.perplexity.ai",
    apiKeyEnvName: "PERPLEXITY_API_KEY",
    protocol: "openai-compatible",
  },
};

/**
 * Every environment variable name a provider's key may be given under, in the
 * order they are consulted. The first is canonical -- it is the name the admin
 * console shows and the one a registry row is allowed to store.
 *
 * There is a list rather than a single name because Google's key has three
 * spellings in the wild, and the code had picked a different subset in each
 * place that asked. `PROVIDER_API_CONFIGURATION` read
 * GOOGLE_GENERATIVE_AI_API_KEY only, so chat went out with no key under any
 * other name. The image adapter accepted GEMINI_API_KEY as well, so image
 * generation worked where chat did not. `PROVIDER_API_KEY_ENV` in
 * lib/providerMonitoring.ts -- which is what /status, conversation titles, AI
 * Review's reviewer filter and provider usage sync all consult to answer "is
 * this provider configured?" -- listed GOOGLE_API_KEY, a name *nothing* reads
 * for a call, and omitted GEMINI_API_KEY, a name one caller does.
 *
 * Both directions of that were wrong and the second is the worse one: a
 * deployment holding only GOOGLE_API_KEY was reported as configured, offered
 * Google reviewers and given Google titles, and every one of those calls left
 * without a key. The release checklist has a manual step for exactly this
 * contradiction ("no per-provider contradiction between /status and
 * /api/models/status ... model picker, provider banner and chat send agree").
 *
 * So the names live here, once, and every reader resolves through them. Like
 * the base URL beside them, they are deliberately hard-coded: a
 * database-controlled environment variable name would turn a compromised
 * operator account into arbitrary server-secret exfiltration.
 */
export const PROVIDER_API_KEY_ENV_NAMES: Record<AiProvider, readonly string[]> =
  {
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    // Google's own documentation, SDK samples and this repository's
    // measurement script each use a different one of these three.
    google: [
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    ],
    groq: ["GROQ_API_KEY"],
    xai: ["XAI_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
    moonshot: ["MOONSHOT_API_KEY"],
    minimax: ["MINIMAX_API_KEY"],
    qwen: ["DASHSCOPE_API_KEY"],
    zhipu: ["ZHIPU_API_KEY"],
    perplexity: ["PERPLEXITY_API_KEY"],
  };

/**
 * The key itself, or `undefined` when no accepted name holds one.
 *
 * Everything that makes a provider call and everything that reports whether a
 * provider is usable must answer from this one function, or the two disagree
 * and the disagreement is invisible until a request fails.
 */
export const resolveProviderApiKey = (
  provider: AiProvider,
  environment: Record<string, string | undefined> = process.env
) =>
  PROVIDER_API_KEY_ENV_NAMES[provider]
    .map((name) => environment[name]?.trim())
    .find((value) => Boolean(value));

export const isProviderApiKeyConfigured = (
  provider: AiProvider,
  environment: Record<string, string | undefined> = process.env
) => Boolean(resolveProviderApiKey(provider, environment));

export const isAiProvider = (value: string): value is AiProvider =>
  (AI_PROVIDERS as readonly string[]).includes(value);

export const normalizeApiBaseUrl = (value: string) => value.trim().replace(/\/$/, "");

export const isApprovedProviderApiBaseUrl = (
  provider: AiProvider,
  value: string | null | undefined
) =>
  normalizeApiBaseUrl(value || "") ===
  PROVIDER_API_CONFIGURATION[provider].baseUrl;

export const isApprovedProviderApiKeyEnvName = (
  provider: AiProvider,
  value: string | null | undefined
) => value === PROVIDER_API_CONFIGURATION[provider].apiKeyEnvName;

const isPrivateIpv4 = (hostname: string) => {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
};

export const isSafeProviderApiBaseUrl = (value: string) => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.search || url.hash) return false;
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe80:") ||
      isPrivateIpv4(hostname)
    ) {
      return false;
    }
    return Boolean(hostname.includes("."));
  } catch {
    return false;
  }
};

/**
 * The static bootstrap catalogue, expressed the way the runtime uses it.
 *
 * This lives in the shared (Prisma-free) module rather than next to
 * `ensureModelRegistrySeeded()` because two callers need it and only one of
 * them may import `server-only`: the runtime bootstrap, and the Admin Console
 * E2E fixture seeder, which recreates the catalogue after truncating the test
 * database. Keeping one definition is what makes the seeded fixture catalogue
 * identical to the one a real deployment bootstraps.
 */
export const staticModelWithRuntimeDefaults = (
  model: AiModel,
  sortOrder: number
): AiModel => {
  const providerConfig = PROVIDER_API_CONFIGURATION[model.provider];
  // Only the token-shaped limits are materialised here. The three price
  // columns are deliberately left as the catalogue declared them -- almost
  // always `undefined` -- because in lib/modelPricing.ts an explicitly
  // present price means "an administrator overrode this model", and it wins
  // over the profile *including its long-context tiers*.
  //
  // Baking the resolved price back in erased three separate things:
  //   * Gemini 3.1 Pro's >200K step (a flat 2/12 replaced the 2/12 -> 4/18
  //     pair, so a long prompt was priced at the short-prompt rate);
  //   * `costSource`, which reported `model_registry_override` for every
  //     model, so the fallback-pricing metrics saw a 0% fallback share even
  //     while unpriced models were being billed at the US$15/US$60 fallback;
  //   * the distinction the pricing contract rests on -- a stored number is
  //     an operator decision, a stored NULL inherits lib/modelPricing.ts.
  const { maxOutputTokens, reservationOutputTokens } =
    getModelBillingProfile(model);
  return {
    ...model,
    apiBaseUrl: providerConfig.baseUrl,
    apiKeyEnvName: providerConfig.apiKeyEnvName,
    creditWeight: getModelUsageProfile(model).credits,
    catalogDeleted: false,
    sortOrder,
    maxOutputTokens,
    reservationOutputTokens,
  };
};

export const STATIC_RUNTIME_MODELS = AVAILABLE_MODELS.map(staticModelWithRuntimeDefaults);

export const staticModelRegistrySeedRows = () =>
  STATIC_RUNTIME_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    apiModel: model.apiModel,
    provider: model.provider,
    apiBaseUrl: model.apiBaseUrl!,
    apiKeyEnvName: model.apiKeyEnvName!,
    icon: model.icon,
    bestFor: model.bestFor,
    minimumPlan: model.minimumPlan,
    usageClass: model.usageClass,
    creditWeight: model.creditWeight!,
    publiclyListed: model.publiclyListed !== false,
    enabled: model.enabled,
    status: model.status,
    operationalReason: model.operationalReason || null,
    userVisibleNote: model.userVisibleNote || null,
    replacementModelId: model.replacementModelId || null,
    catalogDeleted: false,
    reasoning: model.reasoning || null,
    contextWindowTokens: model.contextWindowTokens || null,
    supportsImage: model.inputCapabilities?.image === true,
    supportsNativePdf: model.inputCapabilities?.nativePdf === true,
    maxImages: model.inputCapabilities?.maxImages || null,
    maxBase64ImagePayloadBytes:
      model.inputCapabilities?.maxBase64ImagePayloadBytes || null,
    maxOutputTokens: model.maxOutputTokens || null,
    reservationOutputTokens: model.reservationOutputTokens || null,
    // NULL means "inherit lib/modelPricing.ts", which is what a seed must
    // always mean. A number here is an administrator's custom override and is
    // never written by seeding or reconciliation -- see the comment on
    // staticModelWithRuntimeDefaults and docs/policy/credit-and-cost-limits.md.
    inputUsdPerMillionTokens: model.inputUsdPerMillionTokens ?? null,
    outputUsdPerMillionTokens: model.outputUsdPerMillionTokens ?? null,
    cachedInputPriceMultiplier: model.cachedInputPriceMultiplier ?? null,
    sortOrder: model.sortOrder || 0,
  }));

// Only these human-reviewed lifecycle/API migrations are authoritative over
// an already-existing runtime row. This is intentionally not a general seed
// sync: operator-managed availability, catalogue deletion, ordering and
// unrelated custom metadata remain untouched.
export const STATIC_CATALOG_RECONCILIATION_MODEL_IDS = [
  "gpt-5-6-sol",
  "gpt-5-6-terra",
  "gpt-5-6-luna",
  // Added 2026-08-01 with the Luna default switch. 5.4 mini is NOT being
  // retired here -- it stays enabled, so the `lifecycle` branch below is not
  // taken for it and its enabled/publiclyListed/status are left alone. What
  // this entry reaches is the metadata the switch changed and that has
  // nowhere else to come from: its 128K output cap, its 4,096-token
  // reservation and its published 400K context window.
  //
  // Its price is NOT reconciled. US$0.75/US$4.50 lives in
  // lib/modelPricing.ts and reaches every environment whose row leaves the
  // price columns NULL; the 2026-08-02 migration is what clears the rows an
  // earlier seed had stamped with the old US$0.50/US$1.00 fallback.
  "gpt-5-4-mini",
  "gemini-3-6-flash",
  // Gemini 3.5 Flash was incorrectly left in the 1-credit Standard band even
  // though its published $1.50/$9 rates are slightly dearer than 3.6 Flash.
  // It is now also withdrawn from the public catalogue in favour of the
  // cheaper successor. Reconcile both the corrected Advanced weight and the
  // lifecycle transition without touching administrator-owned price fields.
  "gemini-3-5-flash",
  "gemini-2-5-flash",
  "grok-4",
  "grok-4-3",
  "grok-4-5",
  "grok-3",
  "grok-3-mini",
  "llama-3-1",
  "llama-3-3",
  "llama-4-scout",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-r1",
  "mistral-medium-3-1",
  "claude-fable-5",
  "claude-opus-4-8",
  "codestral",
  "kimi-k3",
  "minimax-m3",
] as const;

const reconciliationModelIds = new Set<string>(
  STATIC_CATALOG_RECONCILIATION_MODEL_IDS
);

export const staticModelRegistryReconciliationRows = () =>
  staticModelRegistrySeedRows()
    .filter((row) => reconciliationModelIds.has(row.id))
    .map((row) => {
      const lifecycle = row.enabled
        ? {}
        : {
            publiclyListed: row.publiclyListed,
            enabled: row.enabled,
            status: row.status,
            operationalReason: row.operationalReason,
            userVisibleNote: row.userVisibleNote,
            replacementModelId: row.replacementModelId,
          };
      return {
        id: row.id,
        data: {
          name: row.name,
          apiModel: row.apiModel,
          bestFor: row.bestFor,
          minimumPlan: row.minimumPlan,
          usageClass: row.usageClass,
          creditWeight: row.creditWeight,
          reasoning: row.reasoning,
          contextWindowTokens: row.contextWindowTokens,
          supportsImage: row.supportsImage,
          supportsNativePdf: row.supportsNativePdf,
          maxImages: row.maxImages,
          maxBase64ImagePayloadBytes: row.maxBase64ImagePayloadBytes,
          maxOutputTokens: row.maxOutputTokens,
          reservationOutputTokens: row.reservationOutputTokens,
          // The three price columns are absent on purpose. Reconciliation
          // runs on every boot, so writing a price here would overwrite an
          // administrator's override on the next deploy, and writing the
          // profile price would defeat NULL-means-inherit: a price change in
          // lib/modelPricing.ts already reaches every environment without a
          // database write. What reconciliation is for is metadata that has
          // nowhere else to come from.
          ...lifecycle,
        },
      };
    });
