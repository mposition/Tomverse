/**
 * Where each provider's own documentation says what its models cost and how
 * large they are, and where a person looks when it says it only to people.
 *
 * ## Why a table rather than two providers
 *
 * The doc-evidence reader was written for OpenAI and Anthropic and named them
 * in its own code. Every other provider therefore produced the same empty
 * analysis: the models API of Zhipu, Perplexity, xAI and the rest answers with
 * an id and little else, so the discovery queue had nothing to say about a
 * candidate beyond its name. On 2026-09-21 that showed as five Zhipu rows with
 * one identical paragraph between them.
 *
 * ## What may be in here
 *
 * **First-party documentation only.** The price this evidence stands next to is
 * one an operator may copy into a registry override, and an aggregator's page
 * is a third party's transcription of a number we would then bill against.
 * Benchmark sites are excluded for a second reason: a score is a claim about
 * quality, and this file carries facts a provider states about its own product.
 *
 * `machineReadable: false` is not an omission. Google, Mistral, DeepSeek,
 * MiniMax and Qwen publish these numbers as rendered HTML for people, and
 * scraping it would put a silently wrong price where an empty field used to be.
 * Those providers carry `humanUrl` and nothing else, and the queue says so.
 *
 * Every host here is also the allowlist the fetcher enforces: a redirect off
 * these hosts is a failure, not a follow.
 */

import type { AiProvider } from "@/lib/models";
import { DEPLOYMENT_ONLY_PROVIDERS } from "@/lib/modelRegistryShared";
import type { DocTableShape } from "@/lib/providerModelDocTables";

export type ProviderModelDocSource = {
    /** The single host this provider's documents are read from. */
    host: string;
    /**
     * A markdown document listing this provider's models with their prices.
     * Null when the provider publishes prices only as rendered HTML.
     */
    pricingUrl: string | null;
    /**
     * The per-model document, when the provider publishes one. Returns null
     * for an id this provider does not document individually.
     */
    modelPageUrl?: (apiModel: string) => string | null;
    /**
     * How this provider writes its numbers. Only meaningful with a
     * `pricingUrl`, and only read by the generic table reader -- OpenAI and
     * Anthropic keep their own parsers.
     */
    tableShape?: DocTableShape;
    /**
     * The column row this provider's standard price table has, normalised, as
     * a person read it from the live page.
     *
     * Every other rule in the reader asks whether something is wrong with a
     * table. This one asks whether it is the table at all, and that is the
     * only one of the two questions with a finite answer: a provider that
     * rewrites its columns stops being readable instead of being read
     * wrongly, and a person re-reads the page.
     */
    expectedPriceHeaders?: readonly string[];
    /** Where a person checks by hand. Always present, even when automated. */
    humanUrl: string;
    /**
     * What a successful read of this provider's documents can establish.
     * Anthropic's pricing page carries prices and no context window, and a
     * sentence promising that the rest will fill in by itself would be false.
     */
    collects: {
        prices: boolean;
        contextWindowTokens: boolean;
        maxOutputTokens: boolean;
        modalities: boolean;
    };
};

const PRICES_ONLY = {
    prices: true,
    contextWindowTokens: false,
    maxOutputTokens: false,
    modalities: false,
} as const;

const NOTHING = {
    prices: false,
    contextWindowTokens: false,
    maxOutputTokens: false,
    modalities: false,
} as const;

/** The bare model identifier a documentation path is built from. */
const documentSlug = (apiModel: string) =>
    apiModel.slice(apiModel.lastIndexOf("/") + 1).trim().toLowerCase();

/**
 * Catalogue providers only. `DEPLOYMENT_ONLY_PROVIDERS` are hosts a deployment
 * may name: an aggregator's page is not a price this scan may place next to a
 * catalogue row, so they are absent here on purpose.
 */
type CatalogueDocumentedProvider = Exclude<
    AiProvider,
    (typeof DEPLOYMENT_ONLY_PROVIDERS)[number]
>;

export const PROVIDER_MODEL_DOC_SOURCES: Record<
    CatalogueDocumentedProvider,
    ProviderModelDocSource
> = {
    openai: {
        host: "developers.openai.com",
        pricingUrl: "https://developers.openai.com/api/docs/pricing.md",
        modelPageUrl: (apiModel) =>
            `https://developers.openai.com/api/docs/models/${documentSlug(apiModel)}.md`,
        humanUrl: "https://developers.openai.com/api/docs/pricing",
        collects: {
            prices: true,
            contextWindowTokens: true,
            maxOutputTokens: true,
            modalities: true,
        },
    },
    anthropic: {
        host: "platform.claude.com",
        pricingUrl: "https://platform.claude.com/docs/en/about-claude/pricing.md",
        humanUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
        collects: PRICES_ONLY,
    },
    zhipu: {
        expectedPriceHeaders: [
            "model | input | cached input | cached input storage | output",
        ],
        host: "docs.z.ai",
        pricingUrl: "https://docs.z.ai/guides/overview/pricing.md",
        // llms.txt on 2026-09-22 lists one page for both Flash SKUs
        // (`/guides/vlm/glm-5.3-flash.md`). The `/guides/llm/` copies answer
        // 307 or 404, and this collector refuses redirects, so the stale path
        // is every read of those two models failing.
        modelPageUrl: (apiModel) => {
            const slug = documentSlug(apiModel);
            if (slug === "glm-5.3-flash" || slug === "glm-5.3-flashx") {
                return "https://docs.z.ai/guides/vlm/glm-5.3-flash.md";
            }
            return `https://docs.z.ai/guides/llm/${slug}.md`;
        },
        tableShape: "columns",
        humanUrl: "https://docs.z.ai/guides/overview/pricing",
        collects: {
            prices: true,
            contextWindowTokens: true,
            maxOutputTokens: true,
            modalities: true,
        },
    },
    xai: {
        // One table carries the context window and both prices, so there is no
        // per-model page to read.
        //
        // Checked live on 2026-09-22: the former /docs/models.md answers 308 to
        // /developers/models.md, and since this collector refuses redirects a
        // stale path here is not a slow drift -- it is every read of this
        // provider failing. The price table now lives on its own page.
        expectedPriceHeaders: [
            "model | context | input / 1m tokens | cached input / 1m tokens | output / 1m tokens",
        ],
        host: "docs.x.ai",
        pricingUrl: "https://docs.x.ai/developers/pricing.md",
        tableShape: "columns",
        humanUrl: "https://docs.x.ai/developers/pricing",
        collects: {
            prices: true,
            contextWindowTokens: true,
            maxOutputTokens: false,
            modalities: false,
        },
    },
    perplexity: {
        // The pricing page's tables price tools and embeddings; the chat models
        // are described in prose.
        host: "docs.perplexity.ai",
        pricingUrl: null,
        humanUrl: "https://docs.perplexity.ai/getting-started/pricing",
        collects: NOTHING,
    },
    groq: {
        expectedPriceHeaders: [
            "model id | speed (t/sec) | price per 1m tokens | rate limits (developer plan) | context window (tokens) | max completion tokens | max file size",
        ],
        host: "console.groq.com",
        // The models table carries the prices; /docs/pricing.md answers 200
        // with a "404 - Page Not Found" body.
        pricingUrl: "https://console.groq.com/docs/models.md",
        tableShape: "combined",
        humanUrl: "https://console.groq.com/docs/models",
        collects: {
            prices: true,
            contextWindowTokens: true,
            maxOutputTokens: true,
            modalities: false,
        },
    },
    moonshot: {
        // Published as MDX: the numbers are props of a <DocTable> component
        // rather than a markdown table.
        host: "platform.moonshot.ai",
        pricingUrl: null,
        humanUrl: "https://platform.moonshot.ai/docs/pricing",
        collects: NOTHING,
    },
    google: {
        host: "ai.google.dev",
        pricingUrl: null,
        humanUrl: "https://ai.google.dev/gemini-api/docs/pricing",
        collects: NOTHING,
    },
    mistral: {
        host: "docs.mistral.ai",
        pricingUrl: null,
        humanUrl: "https://docs.mistral.ai/getting-started/models/models_overview/",
        collects: NOTHING,
    },
    deepseek: {
        host: "api-docs.deepseek.com",
        pricingUrl: null,
        humanUrl: "https://api-docs.deepseek.com/quick_start/pricing",
        collects: NOTHING,
    },
    minimax: {
        host: "platform.minimax.io",
        pricingUrl: null,
        humanUrl: "https://platform.minimax.io/docs/guides/price",
        collects: NOTHING,
    },
    qwen: {
        host: "www.alibabacloud.com",
        pricingUrl: null,
        humanUrl: "https://www.alibabacloud.com/help/en/model-studio/models",
        collects: NOTHING,
    },
};

/** Providers whose documents the scan reads for itself. */
export const machineReadableDocProviders = () =>
    (Object.keys(PROVIDER_MODEL_DOC_SOURCES) as CatalogueDocumentedProvider[]).filter(
        (provider) => PROVIDER_MODEL_DOC_SOURCES[provider].pricingUrl !== null
    );

/** Every host the fetcher may reach, derived so the two cannot drift. */
export const PROVIDER_MODEL_DOC_HOSTS: readonly string[] = Array.from(
    new Set(
        Object.values(PROVIDER_MODEL_DOC_SOURCES)
            .filter((source) => source.pricingUrl !== null)
            .map((source) => source.host)
    )
);

/**
 * Which of the fields an operator is missing this provider's documents would
 * fill in by themselves, and which stay a person's job.
 */
export const docCollectableFields = (
    provider: string
): ProviderModelDocSource["collects"] => {
    const source = (PROVIDER_MODEL_DOC_SOURCES as Record<string, ProviderModelDocSource>)[
        provider
    ];
    return source?.pricingUrl ? source.collects : NOTHING;
};

export const providerDocHumanUrl = (provider: string): string | null =>
    (PROVIDER_MODEL_DOC_SOURCES as Record<string, ProviderModelDocSource>)[provider]
        ?.humanUrl ?? null;
