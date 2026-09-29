/**
 * Where a provider takes personal data, and what lets us say so.
 *
 * ## One list, two readers
 *
 * The Privacy page's per-provider notice and the routing layer's residency
 * gate ask the same question -- who receives this, in which region, on what
 * basis -- and they must not answer it from two tables. A notice that says one
 * thing while the gate does another is wrong in the direction that cannot be
 * taken back: the person has already been told.
 *
 * So this is the single source, and both read it.
 *
 * ## What is here now, and what is not
 *
 * Sixteen rows are `proven`. The owner confirmed the reviewed rows on
 * 2026-09-28, including MiniMax: the account page has no training switch,
 * and the owner accepted the privacy-policy sentence as both the training
 * answer (no) and the ban on sale and advertising. A field the contract
 * does not pin stays `NOT_SPECIFIED`. The Privacy page lists every row,
 * and only while every enrolled row is disclosable. One unproven row
 * takes the whole table off the page.
 *
 * - **An unproven row still does not render.** A partial table would leave
 *   that provider out of the notice.
 * - **Nothing here admits a request.** Proven is a disclosure fact. It does
 *   not cut traffic or change a host.
 * - **Nothing becomes `proven` without an `evidenceRef`.** A destination that
 *   somebody was fairly sure about is the failure this file exists to prevent:
 *   data sent overseas on an assumption does not come back.
 *
 * ## Why this stays a report
 *
 * Every enrolled row is proven today. The report stays a report: a provider
 * added later without a reviewed row is an enrolment miss the test already
 * names, and refusing live traffic for it would be a separate decision.
 * `npm run report:provider-data-destinations` lists coverage without blocking.
 *
 * Pure: no database, no clock, no network.
 */

import type { AiProvider } from "@/lib/models";

/**
 * Whether we can name where this provider takes the data.
 *
 * Two values, and no third for "probably". The distinction the routing gate
 * needs is binary -- may a constrained request go here -- and a middle value
 * would be read as a yes by whoever needed one.
 */
export type ProviderDestinationStatus = "proven" | "unproven";

/**
 * What kind of statement a geography is.
 *
 * The vocabulary is the provider-privacy handoff's (v2.0, section 3), so that
 * a contract reviewer and this file use one set of words. The six are not
 * degrees of one thing:
 *
 * - `COMMITTED_LOCATIONS` -- the contract binds the provider to these.
 * - `DISCLOSED_POSSIBLE_LOCATIONS` -- the provider says data *may* go to
 *   these, as a sub-processor list does. The set a request could visit, not
 *   the set a given request did.
 * - `NOT_PINNED` -- reviewed, and the provider does not hold it to a place.
 * - `NOT_SPECIFIED` -- reviewed, and the applicable terms do not say.
 * - `NO_PERSISTENT_CONTENT_STORAGE` -- reviewed, and content is not stored.
 *   Storage only: something that is not kept still has to be processed
 *   somewhere.
 * - `UNKNOWN` -- nobody has looked. Not the same as `NOT_SPECIFIED`, which
 *   is the answer somebody got by looking.
 *
 * "Not stored" and "stored, place unknown" are the pair a notice most easily
 * collapses, and they are opposite answers to the question a person asks.
 */
export type ContentGeographyMode =
    | "UNKNOWN"
    | "COMMITTED_LOCATIONS"
    | "DISCLOSED_POSSIBLE_LOCATIONS"
    | "NOT_PINNED"
    | "NOT_SPECIFIED"
    | "NO_PERSISTENT_CONTENT_STORAGE";

/**
 * Where customer content sits, or is worked on, for one of the two scopes.
 *
 * Storage and processing are separate fields because they are separate
 * answers: a provider can keep content in one country and run inference
 * wherever it has capacity. Filling one from the other is an inference the
 * handoff forbids, and it is wrong in the direction a notice cannot take
 * back.
 */
export type ContentGeography = {
    mode: ContentGeographyMode;
    /**
     * Meant as ISO 3166-1 alpha-2, upper case -- `GB`, not the legacy `UK`.
     * Only the shape is checked (`COUNTRY_CODE`), not the ISO list.
     */
    countryCodes: readonly string[];
    /**
     * Groupings a contract names instead of countries -- `EEA`, `EU`,
     * `INTERNATIONAL`. Kept apart from `countryCodes` so that a list of
     * countries is never padded with something that is not a country.
     */
    macroRegions: readonly string[];
    evidenceRef: string | null;
};

/** The five things a provider may keep, which the handoff keeps apart. */
export type RetentionComponent =
    | "content"
    | "safetyLogs"
    | "inMemoryCache"
    | "persistentFeatureState"
    | "systemMetadata";

export const RETENTION_COMPONENTS: readonly RetentionComponent[] = [
    "content",
    "safetyLogs",
    "inMemoryCache",
    "persistentFeatureState",
    "systemMetadata",
];

/**
 * How one of them is kept.
 *
 * `maxDays: null` is "not known", never zero days. `NOT_APPLICABLE` is a
 * reviewed answer -- this provider has no such thing -- and not a way to
 * leave a component blank.
 */
export type RetentionBehavior =
    | "UNKNOWN"
    | "NO_PERSISTENT_STORAGE"
    | "TRANSIENT"
    | "BOUNDED"
    | "CUSTOMER_CONTROLLED"
    | "NOT_SPECIFIED"
    | "NOT_APPLICABLE";

export type RetentionFact = {
    behavior: RetentionBehavior;
    maxDays: number | null;
    evidenceRef: string | null;
};

/**
 * A yes or no a notice has to print, with what lets us print it.
 *
 * `null` is "not established". It is not false.
 */
export type ReviewedAnswer = {
    value: boolean | null;
    evidenceRef: string | null;
};

export type ZeroDataRetentionMode =
    | "UNKNOWN"
    | "NOT_SUPPORTED"
    | "ZDR"
    | "CONTRACTUAL_NO_CONTENT_STORAGE";

export type ProviderDataDestination = {
    provider: AiProvider;
    /**
     * The legal entity that receives the data.
     *
     * Null until somebody has established it, and never named without the
     * row's `evidenceRef`, whatever the status. Not the product name: a person asking where their
     * message went is asking who holds it, and a brand is not an answer to
     * that.
     */
    recipientEntity: string | null;
    /**
     * Where that entity is. Not where the content is stored or processed:
     * copying a recipient's country into either is another inference the
     * handoff forbids.
     */
    recipientCountryCodes: readonly string[];
    customerContentStorage: ContentGeography;
    processing: ContentGeography;
    /**
     * The storage geography again, as the flat list the earlier shape had.
     *
     * An alias and nothing more: `destinationShapeProblems()` refuses a row
     * where it differs from `customerContentStorage`. It was once described
     * as the regions data is *processed* in, which is the conflation the
     * split above exists to end. Nor is it every country a notice has to
     * name -- processing and the recipient's own country are separate.
     */
    destinationRegions: readonly string[];
    /** Whether customer content is used to train the provider's models. */
    trainsOnCustomerContent: ReviewedAnswer;
    retention: Readonly<Record<RetentionComponent, RetentionFact>>;
    /**
     * Zero data retention as the applicable terms provide it.
     *
     * What a provider offers is not what Tomverse's own account has, so this
     * alone never makes a route strict.
     *
     * A different fact from `customerContentStorage`, and allowed beside any
     * storage mode: that field says where content sits when it is stored,
     * this one says the terms offer a mode in which it is not. The handoff's
     * own reference record for one provider carries both a storage country
     * and a ZDR target. Whether a given route runs under ZDR is the route's
     * configuration, not this row. The same holds for another service's
     * published policy: an aggregator's ZDR list describes that aggregator's
     * agreement with the provider, and calling the same endpoint does not
     * inherit it.
     */
    zeroDataRetention: { mode: ZeroDataRetentionMode; evidenceRef: string | null };
    /**
     * Whether the terms stop the provider, or anyone it passes content to,
     * using customer content for their own commercial ends -- advertising,
     * sale, profiling.
     *
     * Its own question. A no-training clause does not answer it, and neither
     * does being a processor; sub-processing on instruction is a different
     * thing from independent use.
     */
    independentCommercialUseProhibited: ReviewedAnswer;
    /**
     * The fixed identifier of what lets us say the above.
     *
     * A contract, a DPA, a provider's own published sub-processor page --
     * named so that a later reader can check it rather than trust this file.
     * Null until there is one. `proven` requires it, and requires more besides:
     * see `provenDestinationProblems()`. It is also what the recipient
     * entity and country rest on, so naming either without it is refused.
     * Another service's description of its own arrangement with the provider
     * is not one.
     */
    evidenceRef: string | null;
    status: ProviderDestinationStatus;
};

const unknownGeography = (): ContentGeography => ({
    mode: "UNKNOWN",
    countryCodes: [],
    macroRegions: [],
    evidenceRef: null,
});

const unknownRetention = (): RetentionFact => ({
    behavior: "UNKNOWN",
    maxDays: null,
    evidenceRef: null,
});

const unproven = (provider: AiProvider): ProviderDataDestination => ({
    provider,
    recipientEntity: null,
    recipientCountryCodes: [],
    customerContentStorage: unknownGeography(),
    processing: unknownGeography(),
    destinationRegions: [],
    trainsOnCustomerContent: { value: null, evidenceRef: null },
    retention: {
        content: unknownRetention(),
        safetyLogs: unknownRetention(),
        inMemoryCache: unknownRetention(),
        persistentFeatureState: unknownRetention(),
        systemMetadata: unknownRetention(),
    },
    zeroDataRetention: { mode: "UNKNOWN", evidenceRef: null },
    independentCommercialUseProhibited: { value: null, evidenceRef: null },
    evidenceRef: null,
    status: "unproven",
});

const located = (
    mode: "COMMITTED_LOCATIONS" | "DISCLOSED_POSSIBLE_LOCATIONS",
    countryCodes: readonly string[],
    evidenceRef: string,
    macroRegions: readonly string[] = [],
): ContentGeography => ({
    mode,
    countryCodes,
    macroRegions,
    evidenceRef,
});

const unlocated = (
    mode: "NOT_PINNED" | "NOT_SPECIFIED" | "NO_PERSISTENT_CONTENT_STORAGE",
    evidenceRef: string,
): ContentGeography => ({
    mode,
    countryCodes: [],
    macroRegions: [],
    evidenceRef,
});

const kept = (
    behavior: RetentionBehavior,
    evidenceRef: string,
    maxDays: number | null = null,
): RetentionFact => ({ behavior, maxDays, evidenceRef });

const unspecified = (evidenceRef: string): RetentionFact =>
    kept("NOT_SPECIFIED", evidenceRef);

/**
 * Owner confirmation, 2026-09-28. These ten may be printed. A cell the
 * contract does not pin is `NOT_SPECIFIED`, which is a finished answer.
 * Named places stay as the owner recorded them.
 */
const ready = (input: {
    provider: AiProvider;
    recipientEntity: string;
    recipientCountryCodes: readonly string[];
    evidenceRef: string;
    storage: ContentGeography;
    processing: ContentGeography;
    trains: boolean;
    trainsEvidenceRef: string;
    retention: ProviderDataDestination["retention"];
    commercialUseProhibited: boolean;
    commercialEvidenceRef: string;
    zeroDataRetention?: ProviderDataDestination["zeroDataRetention"];
}): ProviderDataDestination => ({
    ...unproven(input.provider),
    recipientEntity: input.recipientEntity,
    recipientCountryCodes: input.recipientCountryCodes,
    customerContentStorage: input.storage,
    processing: input.processing,
    destinationRegions: [...input.storage.countryCodes, ...input.storage.macroRegions],
    trainsOnCustomerContent: { value: input.trains, evidenceRef: input.trainsEvidenceRef },
    retention: input.retention,
    zeroDataRetention: input.zeroDataRetention ?? { mode: "UNKNOWN", evidenceRef: null },
    independentCommercialUseProhibited: {
        value: input.commercialUseProhibited,
        evidenceRef: input.commercialEvidenceRef,
    },
    evidenceRef: input.evidenceRef,
    status: "proven",
});

const GEMINI_TERMS = "https://ai.google.dev/gemini-api/terms";
const GEMINI_ENTITY = "https://cloud.google.com/terms/google-entity";
const GEMINI_USAGE = "https://ai.google.dev/gemini-api/docs/usage-policies";
const GEMINI_DPA = "https://cloud.google.com/terms/data-processing-addendum";
const OPENAI_DATA = "https://developers.openai.com/api/docs/guides/your-data";
const OPENAI_DPA = "https://openai.com/policies/data-processing-addendum/";
const KIMI_OPENPLATFORM_PRIVACY = "https://platform.kimi.ai/docs/agreement/userprivacy";
const DEEPSEEK_PRIVACY = "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html";
const DEEPSEEK_TERMS_OF_USE = "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html";
const DEEPSEEK_OPEN_PLATFORM_TERMS =
    "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html";
const ANTHROPIC_SERVERS =
    "https://privacy.anthropic.com/en/articles/7996890-where-are-your-servers-located-do-you-host-your-models-on-eu-servers";
const ANTHROPIC_RETENTION =
    "https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data";
const GROQ_DATA = "https://console.groq.com/docs/your-data";
const GROQ_DPA = "https://console.groq.com/docs/legal/customer-data-processing-addendum";
const XAI_DPA = "https://x.ai/legal/data-processing-addendum";
const XAI_TERMS = "https://x.ai/legal/terms-of-service-enterprise";
const PERPLEXITY_TERMS = "https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service";
const PERPLEXITY_DPA = "https://www.perplexity.ai/hub/legal/dpa";
const DEEPINFRA_PRIVACY = "https://docs.deepinfra.com/account/data-privacy";
const DEEPINFRA_TERMS = "https://deepinfra.com/terms";
const OPENROUTER_PRIVACY = "https://openrouter.ai/privacy/";
const OPENROUTER_TERMS = "https://openrouter.ai/terms/";
const QWEN_REGIONS = "https://www.alibabacloud.com/help/en/model-studio/regions";
const QWEN_MEMBERSHIP =
    "https://www.alibabacloud.com/help/en/legal/latest/alibaba-cloud-international-website-membership-agreement";
const ZHIPU_PRIVACY = "https://docs.z.ai/legal-agreement/privacy-policy";
const TOGETHER_PRIVACY = "https://www.together.ai/privacy";
const TOGETHER_TERMS = "https://www.together.ai/terms-of-service";
const MISTRAL_TERMS = "https://legal.mistral.ai/terms/commercial-terms-of-service/";
const MISTRAL_DPA = "https://legal.mistral.ai/terms/data-processing-addendum/";
const MISTRAL_STORAGE =
    "https://help.mistral.ai/en/articles/347629-where-do-you-store-my-data-or-my-organization-s-data";
const MISTRAL_TRAINING =
    "https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training";
const MISTRAL_ZDR =
    "https://help.mistral.ai/en/articles/347612-can-i-activate-zero-data-retention-zdr";
const MINIMAX_PRIVACY = "https://platform.minimax.io/protocol/privacy-policy";
const MINIMAX_PAID = "https://platform.minimax.io/protocol/paid-agreement";
const SAIL_DPA = "https://docs.sailresearch.com/dpa";
const SAIL_TERMS = "https://www.sailresearch.com/terms";

/**
 * MiniMax is ready. The account page has no training switch. On 2026-09-28
 * the owner accepted the privacy-policy sentence, which says input personal
 * data is not used to infer characteristics or for training that profiles
 * or targets consumers, as both the training answer and the sale ban.
 */
const minimaxDestination = (): ProviderDataDestination =>
    ready({
        provider: "minimax",
        recipientEntity: "Nanonoble Pte. Ltd.",
        recipientCountryCodes: ["SG"],
        evidenceRef: MINIMAX_PAID,
        storage: unlocated("NOT_SPECIFIED", MINIMAX_PRIVACY),
        processing: unlocated("NOT_SPECIFIED", MINIMAX_PRIVACY),
        trains: false,
        trainsEvidenceRef: MINIMAX_PRIVACY,
        retention: {
            content: unspecified(MINIMAX_PRIVACY),
            safetyLogs: unspecified(MINIMAX_PRIVACY),
            inMemoryCache: unspecified(MINIMAX_PRIVACY),
            persistentFeatureState: unspecified(MINIMAX_PRIVACY),
            systemMetadata: unspecified(MINIMAX_PRIVACY),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: MINIMAX_PRIVACY,
    });

/**
 * DeepSeek is ready. Storage stays `NOT_SPECIFIED`: the consumer privacy
 * policy's China sentence is not API customer-content storage. On
 * 2026-09-28 the chat Data switch was grey, which is off, so training is
 * no. The owner accepted the privacy policy sentence that DeepSeek does not
 * sell personal data or use it for targeted advertising or profiling.
 */
const deepseekDestination = (): ProviderDataDestination =>
    ready({
        provider: "deepseek",
        recipientEntity: "Hangzhou DeepSeek Artificial Intelligence Co., Ltd.",
        recipientCountryCodes: ["CN"],
        evidenceRef: DEEPSEEK_OPEN_PLATFORM_TERMS,
        storage: unlocated("NOT_SPECIFIED", DEEPSEEK_OPEN_PLATFORM_TERMS),
        processing: unlocated("NOT_SPECIFIED", DEEPSEEK_OPEN_PLATFORM_TERMS),
        trains: false,
        trainsEvidenceRef: DEEPSEEK_TERMS_OF_USE,
        retention: {
            content: unspecified(DEEPSEEK_OPEN_PLATFORM_TERMS),
            safetyLogs: unspecified(DEEPSEEK_OPEN_PLATFORM_TERMS),
            inMemoryCache: unspecified(DEEPSEEK_OPEN_PLATFORM_TERMS),
            persistentFeatureState: unspecified(DEEPSEEK_OPEN_PLATFORM_TERMS),
            systemMetadata: unspecified(DEEPSEEK_OPEN_PLATFORM_TERMS),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: DEEPSEEK_PRIVACY,
    });

/**
 * Every provider the catalogue can reach.
 *
 * Enrolment is the point, as it is for `ROUTER_SCORE_SNAPSHOT`: a provider
 * added to `AiProvider` and forgotten here would be one nobody had asked the
 * destination question about, and the report would read a confident zero over
 * a set it had not looked at. `tests/providerDataDestinations.test.mjs` fails
 * when one is missing.
 */
export const PROVIDER_DATA_DESTINATIONS: readonly ProviderDataDestination[] = [
    ready({
        provider: "openai",
        recipientEntity: "OpenAI OpCo, LLC",
        recipientCountryCodes: ["US"],
        evidenceRef: OPENAI_DPA,
        storage: unlocated("NOT_PINNED", OPENAI_DATA),
        processing: unlocated("NOT_PINNED", OPENAI_DATA),
        // 2026-09-28 organization Sharing page: model feedback, evaluation and
        // fine-tuning data, and inputs and outputs were each Disabled.
        trains: false,
        trainsEvidenceRef: OPENAI_DATA,
        retention: {
            content: kept("CUSTOMER_CONTROLLED", OPENAI_DATA),
            safetyLogs: kept("BOUNDED", OPENAI_DATA, 30),
            inMemoryCache: unspecified(OPENAI_DATA),
            persistentFeatureState: kept("CUSTOMER_CONTROLLED", OPENAI_DATA),
            systemMetadata: unspecified(OPENAI_DATA),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: OPENAI_DPA,
    }),
    ready({
        provider: "anthropic",
        recipientEntity: "Anthropic, PBC",
        recipientCountryCodes: ["US"],
        evidenceRef: "https://www.anthropic.com/legal/commercial-terms",
        storage: located("COMMITTED_LOCATIONS", ["US"], ANTHROPIC_SERVERS),
        processing: located("DISCLOSED_POSSIBLE_LOCATIONS", ["US", "AU"], ANTHROPIC_SERVERS, ["EUROPE", "ASIA"]),
        trains: false,
        trainsEvidenceRef: "https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training",
        retention: {
            content: kept("BOUNDED", ANTHROPIC_RETENTION, 30),
            safetyLogs: unspecified(ANTHROPIC_RETENTION),
            inMemoryCache: unspecified(ANTHROPIC_RETENTION),
            persistentFeatureState: unspecified(ANTHROPIC_RETENTION),
            systemMetadata: unspecified(ANTHROPIC_RETENTION),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: "https://privacy.anthropic.com/en/articles/9267385-does-anthropic-act-as-a-data-processor-or-controller",
    }),
    ready({
        provider: "google",
        recipientEntity: "Google Asia Pacific Pte. Ltd.; Google Australia Pty Ltd.",
        recipientCountryCodes: ["SG", "AU"],
        evidenceRef: GEMINI_ENTITY,
        storage: unlocated("NOT_PINNED", GEMINI_TERMS),
        processing: unlocated("NOT_PINNED", GEMINI_TERMS),
        // 2026-09-28 AI Studio billing: the Tomverse project is Gemini API
        // paid tier 1 with a billing account linked. Paid terms do not use
        // those prompts to improve products.
        trains: false,
        trainsEvidenceRef: GEMINI_TERMS,
        retention: {
            content: kept("TRANSIENT", GEMINI_TERMS),
            safetyLogs: kept("BOUNDED", GEMINI_USAGE, 55),
            inMemoryCache: kept("TRANSIENT", GEMINI_TERMS),
            persistentFeatureState: unspecified(GEMINI_TERMS),
            systemMetadata: unspecified(GEMINI_TERMS),
        },
        // Owner accepted the processor addendum: customer data is processed
        // on instruction, and the CCPA section forbids sale and ad sharing.
        commercialUseProhibited: true,
        commercialEvidenceRef: GEMINI_DPA,
    }),
    ready({
        provider: "groq",
        recipientEntity: "Groq LLC",
        recipientCountryCodes: ["US"],
        evidenceRef: "https://console.groq.com/docs/legal/services-agreement",
        storage: located("COMMITTED_LOCATIONS", ["US"], GROQ_DATA),
        processing: unlocated("NOT_PINNED", GROQ_DATA),
        trains: false,
        trainsEvidenceRef: GROQ_DPA,
        retention: {
            content: kept("NO_PERSISTENT_STORAGE", GROQ_DATA),
            safetyLogs: kept("BOUNDED", GROQ_DATA, 30),
            inMemoryCache: unspecified(GROQ_DATA),
            persistentFeatureState: unspecified(GROQ_DATA),
            systemMetadata: unspecified(GROQ_DATA),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: GROQ_DPA,
    }),
    ready({
        provider: "xai",
        recipientEntity: "SpaceXAI LLC",
        recipientCountryCodes: ["US"],
        evidenceRef: XAI_DPA,
        storage: unlocated("NOT_SPECIFIED", XAI_DPA),
        processing: located("DISCLOSED_POSSIBLE_LOCATIONS", ["US", "GB"], "https://x.ai/legal/subprocessor-list"),
        trains: false,
        trainsEvidenceRef: XAI_TERMS,
        retention: {
            content: kept("BOUNDED", XAI_TERMS, 30),
            safetyLogs: unspecified(XAI_DPA),
            inMemoryCache: unspecified(XAI_DPA),
            persistentFeatureState: unspecified(XAI_DPA),
            systemMetadata: unspecified(XAI_DPA),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: XAI_DPA,
    }),
    deepseekDestination(),
    ready({
        provider: "mistral",
        recipientEntity: "Mistral AI",
        recipientCountryCodes: ["FR"],
        evidenceRef: MISTRAL_TERMS,
        storage: located("COMMITTED_LOCATIONS", [], MISTRAL_STORAGE, ["EU"]),
        processing: unlocated("NOT_PINNED", MISTRAL_STORAGE),
        // 2026-09-28 admin Privacy page: "Allow the use of your API calls to
        // train Mistral's AI models" was off, and Labs models were off.
        trains: false,
        trainsEvidenceRef: MISTRAL_TRAINING,
        retention: {
            content: unspecified(MISTRAL_ZDR),
            safetyLogs: unspecified(MISTRAL_DPA),
            inMemoryCache: unspecified(MISTRAL_DPA),
            persistentFeatureState: unspecified(MISTRAL_DPA),
            systemMetadata: unspecified(MISTRAL_DPA),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: MISTRAL_DPA,
    }),
    ready({
        provider: "moonshot",
        recipientEntity: "MOONSHOT AI PTE. LTD.",
        recipientCountryCodes: ["SG"],
        evidenceRef: KIMI_OPENPLATFORM_PRIVACY,
        storage: located("COMMITTED_LOCATIONS", ["SG"], KIMI_OPENPLATFORM_PRIVACY),
        processing: located("DISCLOSED_POSSIBLE_LOCATIONS", ["SG"], KIMI_OPENPLATFORM_PRIVACY),
        trains: true,
        trainsEvidenceRef: KIMI_OPENPLATFORM_PRIVACY,
        retention: {
            content: unspecified(KIMI_OPENPLATFORM_PRIVACY),
            safetyLogs: unspecified(KIMI_OPENPLATFORM_PRIVACY),
            inMemoryCache: unspecified(KIMI_OPENPLATFORM_PRIVACY),
            persistentFeatureState: unspecified(KIMI_OPENPLATFORM_PRIVACY),
            systemMetadata: unspecified(KIMI_OPENPLATFORM_PRIVACY),
        },
        commercialUseProhibited: false,
        commercialEvidenceRef: KIMI_OPENPLATFORM_PRIVACY,
    }),
    minimaxDestination(),
    ready({
        provider: "qwen",
        recipientEntity: "Alibaba Cloud (Singapore) Private Limited",
        recipientCountryCodes: ["SG"],
        evidenceRef: QWEN_MEMBERSHIP,
        storage: located("COMMITTED_LOCATIONS", ["SG"], QWEN_REGIONS),
        processing: unlocated("NOT_PINNED", QWEN_REGIONS),
        trains: false,
        trainsEvidenceRef: QWEN_MEMBERSHIP,
        retention: {
            content: unspecified(QWEN_REGIONS),
            safetyLogs: unspecified(QWEN_REGIONS),
            inMemoryCache: unspecified(QWEN_REGIONS),
            persistentFeatureState: unspecified(QWEN_REGIONS),
            systemMetadata: unspecified(QWEN_REGIONS),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: QWEN_MEMBERSHIP,
    }),
    ready({
        provider: "zhipu",
        recipientEntity: "JINGSHENG HENGXING TECHNOLOGY PTE.LTD",
        recipientCountryCodes: ["SG"],
        evidenceRef: "https://docs.z.ai/legal-agreement/terms-of-use",
        storage: unlocated("NO_PERSISTENT_CONTENT_STORAGE", ZHIPU_PRIVACY),
        processing: located("DISCLOSED_POSSIBLE_LOCATIONS", ["SG"], ZHIPU_PRIVACY),
        trains: false,
        trainsEvidenceRef: ZHIPU_PRIVACY,
        retention: {
            content: kept("NO_PERSISTENT_STORAGE", ZHIPU_PRIVACY),
            safetyLogs: unspecified(ZHIPU_PRIVACY),
            inMemoryCache: unspecified(ZHIPU_PRIVACY),
            persistentFeatureState: unspecified(ZHIPU_PRIVACY),
            systemMetadata: unspecified(ZHIPU_PRIVACY),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: ZHIPU_PRIVACY,
        zeroDataRetention: { mode: "CONTRACTUAL_NO_CONTENT_STORAGE", evidenceRef: ZHIPU_PRIVACY },
    }),
    ready({
        provider: "perplexity",
        recipientEntity: "Perplexity AI, Inc.",
        recipientCountryCodes: ["US"],
        evidenceRef: PERPLEXITY_TERMS,
        storage: unlocated("NOT_SPECIFIED", PERPLEXITY_DPA),
        processing: unlocated("NOT_PINNED", PERPLEXITY_TERMS),
        trains: false,
        trainsEvidenceRef: PERPLEXITY_TERMS,
        retention: {
            content: unspecified(PERPLEXITY_DPA),
            safetyLogs: unspecified(PERPLEXITY_DPA),
            inMemoryCache: unspecified(PERPLEXITY_DPA),
            persistentFeatureState: unspecified(PERPLEXITY_DPA),
            systemMetadata: unspecified(PERPLEXITY_DPA),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: PERPLEXITY_DPA,
    }),
    ready({
        provider: "deepinfra",
        recipientEntity: "Deep Infra Inc.",
        recipientCountryCodes: ["US"],
        evidenceRef: DEEPINFRA_TERMS,
        storage: unlocated("NO_PERSISTENT_CONTENT_STORAGE", DEEPINFRA_PRIVACY),
        processing: located("DISCLOSED_POSSIBLE_LOCATIONS", ["US"], "https://deepinfra.com/"),
        trains: false,
        trainsEvidenceRef: DEEPINFRA_PRIVACY,
        retention: {
            content: kept("NO_PERSISTENT_STORAGE", DEEPINFRA_PRIVACY),
            safetyLogs: unspecified(DEEPINFRA_TERMS),
            inMemoryCache: kept("TRANSIENT", DEEPINFRA_PRIVACY),
            persistentFeatureState: unspecified(DEEPINFRA_TERMS),
            systemMetadata: unspecified(DEEPINFRA_TERMS),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: DEEPINFRA_TERMS,
        zeroDataRetention: { mode: "CONTRACTUAL_NO_CONTENT_STORAGE", evidenceRef: DEEPINFRA_TERMS },
    }),
    ready({
        provider: "together",
        recipientEntity: "Together Computer, Inc.",
        recipientCountryCodes: ["US"],
        evidenceRef: TOGETHER_TERMS,
        storage: unlocated("NOT_SPECIFIED", TOGETHER_PRIVACY),
        processing: unlocated("NOT_SPECIFIED", TOGETHER_PRIVACY),
        // 2026-09-28 organization Privacy: prompt storage, third-party
        // passthrough, and training were each No. The privacy policy calls
        // that choice zero data retention and bars secondary use.
        trains: false,
        trainsEvidenceRef: TOGETHER_PRIVACY,
        retention: {
            content: kept("CUSTOMER_CONTROLLED", TOGETHER_PRIVACY),
            safetyLogs: unspecified(TOGETHER_PRIVACY),
            inMemoryCache: unspecified(TOGETHER_PRIVACY),
            persistentFeatureState: kept("CUSTOMER_CONTROLLED", TOGETHER_PRIVACY),
            systemMetadata: unspecified(TOGETHER_PRIVACY),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: TOGETHER_PRIVACY,
        zeroDataRetention: { mode: "ZDR", evidenceRef: TOGETHER_PRIVACY },
    }),
    ready({
        provider: "openrouter",
        recipientEntity: "OpenRouter, Inc.",
        recipientCountryCodes: ["US"],
        evidenceRef: OPENROUTER_TERMS,
        storage: unlocated("NOT_SPECIFIED", OPENROUTER_PRIVACY),
        processing: unlocated("NOT_SPECIFIED", OPENROUTER_PRIVACY),
        trains: false,
        trainsEvidenceRef: OPENROUTER_PRIVACY,
        retention: {
            content: kept("CUSTOMER_CONTROLLED", OPENROUTER_TERMS),
            safetyLogs: unspecified(OPENROUTER_PRIVACY),
            inMemoryCache: unspecified(OPENROUTER_TERMS),
            persistentFeatureState: kept("CUSTOMER_CONTROLLED", OPENROUTER_TERMS),
            systemMetadata: unspecified(OPENROUTER_PRIVACY),
        },
        commercialUseProhibited: false,
        commercialEvidenceRef: OPENROUTER_PRIVACY,
    }),
    ready({
        provider: "sail",
        recipientEntity: "Sail Research Co.",
        recipientCountryCodes: ["US"],
        evidenceRef: SAIL_TERMS,
        storage: unlocated("NOT_SPECIFIED", SAIL_DPA),
        processing: unlocated("NOT_SPECIFIED", SAIL_DPA),
        trains: false,
        trainsEvidenceRef: SAIL_DPA,
        retention: {
            content: kept("BOUNDED", SAIL_DPA, 2),
            safetyLogs: unspecified(SAIL_DPA),
            inMemoryCache: kept("TRANSIENT", SAIL_DPA),
            persistentFeatureState: unspecified(SAIL_DPA),
            systemMetadata: unspecified(SAIL_DPA),
        },
        commercialUseProhibited: true,
        commercialEvidenceRef: SAIL_DPA,
        zeroDataRetention: { mode: "NOT_SUPPORTED", evidenceRef: SAIL_TERMS },
    }),
];

export const providerDataDestination = (
    provider: AiProvider
): ProviderDataDestination | null =>
    PROVIDER_DATA_DESTINATIONS.find((entry) => entry.provider === provider) ??
    null;

/**
 * Whether this provider's destination is established at all.
 *
 * **Not a routing permission.** Whether a request may be served is decided by
 * `endpointMayServeConstrainedTraffic` in `lib/deploymentIdentity.ts`, from an
 * approval in force at that moment. Two functions answering "may this go
 * here?" from different sources is how a notice and a gate come to disagree,
 * and the disagreement is only discovered after somebody has been told.
 *
 * What this answers is the prior question: could a notice print this
 * provider's row -- proven, complete, and saying nothing it cannot mean
 * (`destinationIsDisclosable()`). An approval is an act performed *on* such a
 * fact, so a provider that has none cannot be approved -- but a provider that
 * has one is not thereby approved either.
 *
 * Fail-closed: an absent entry and an unproven one both answer no, for the
 * same reason -- nobody can say where the data would go.
 */
export const providerDestinationIsEstablished = (
    provider: AiProvider
): boolean => {
    const entry = providerDataDestination(provider);
    return entry !== null && destinationIsDisclosable(entry);
};

/**
 * The entries a user-facing notice may print.
 *
 * The Privacy page prints this list only when its length equals the
 * enrolment. A shorter list would leave a live provider out of the notice.
 */
export const disclosableDataDestinations = (): readonly ProviderDataDestination[] =>
    PROVIDER_DATA_DESTINATIONS.filter(destinationIsDisclosable);

/**
 * The shape of a country code: two upper-case letters.
 *
 * Shape only. This is not checked against the ISO 3166-1 list, so an
 * unassigned pair such as `XX` passes; the problem messages say "two-letter
 * country code" rather than claim an ISO check that does not happen.
 */
const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * Pairs that have the shape and are wrong in every field.
 *
 * `UK` is how provider documents write the United Kingdom; the code is
 * `GB`. `EL` is the EU's own code for Greece; the code is `GR`. Neither is
 * a grouping either, so neither is accepted as a macro region.
 */
const MISWRITTEN_COUNTRY_CODES: ReadonlySet<string> = new Set(["UK", "EL"]);

/**
 * Pairs that have the shape and name a grouping, not a country.
 *
 * Refused as a country code and accepted as a macro region, which is where a
 * contract that says "the EU" belongs.
 */
const GROUPING_CODES: ReadonlySet<string> = new Set(["EU"]);

const countryCodeProblem = (label: string, code: string): string | null =>
    COUNTRY_CODE.test(code) &&
    !MISWRITTEN_COUNTRY_CODES.has(code) &&
    !GROUPING_CODES.has(code)
        ? null
        : `${label} country code ${JSON.stringify(code)} is not a two-letter country code`;

const geographyProblems = (
    label: string,
    geography: ContentGeography
): string[] => {
    const problems: string[] = [];
    for (const code of geography.countryCodes) {
        const problem = countryCodeProblem(label, code);
        if (problem) problems.push(problem);
    }
    for (const region of geography.macroRegions) {
        if (region.trim() === "") {
            problems.push(`${label} macro region is blank`);
        } else if (MISWRITTEN_COUNTRY_CODES.has(region)) {
            problems.push(`${label} macro region ${JSON.stringify(region)} is a miswritten country code`);
        } else if (COUNTRY_CODE.test(region) && !GROUPING_CODES.has(region)) {
            problems.push(`${label} macro region ${JSON.stringify(region)} is a country code`);
        }
    }
    const located =
        geography.countryCodes.length > 0 || geography.macroRegions.length > 0;
    if (
        (geography.mode === "COMMITTED_LOCATIONS" ||
            geography.mode === "DISCLOSED_POSSIBLE_LOCATIONS") &&
        !located
    ) {
        problems.push(`${label} names locations but lists none`);
    }
    // Only the two location modes carry locations. NOT_PINNED and
    // NOT_SPECIFIED say the terms hold the provider to no place; a list of the
    // places it may use is DISCLOSED_POSSIBLE_LOCATIONS, and writing that list
    // under NOT_PINNED would print a set of countries as though it were none.
    if (
        geography.mode !== "COMMITTED_LOCATIONS" &&
        geography.mode !== "DISCLOSED_POSSIBLE_LOCATIONS" &&
        located
    ) {
        problems.push(`${label} is ${geography.mode} but lists locations`);
    }
    if (geography.mode !== "UNKNOWN" && !geography.evidenceRef) {
        problems.push(`${label} is ${geography.mode} without an evidenceRef`);
    }
    return problems;
};

const sameMembers = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length &&
    [...left].sort().join("\u0000") === [...right].sort().join("\u0000");

/**
 * What is wrong with a row whatever its status.
 *
 * These are contradictions rather than gaps: a row can be unproven and still
 * say something it cannot mean, and an unproven row is read by the report.
 */
export const destinationShapeProblems = (
    entry: ProviderDataDestination
): readonly string[] => {
    const problems: string[] = [
        ...geographyProblems("storage", entry.customerContentStorage),
        ...geographyProblems("processing", entry.processing),
    ];
    for (const code of entry.recipientCountryCodes) {
        const problem = countryCodeProblem("recipient", code);
        if (problem) problems.push(problem);
    }
    // Every other answer carries its own reference. Who receives the data,
    // and where they are, rest on the row's own: naming either without it is
    // the "somebody was fairly sure" this file exists to refuse.
    if (
        (entry.recipientEntity !== null || entry.recipientCountryCodes.length > 0) &&
        !entry.evidenceRef
    ) {
        problems.push("the recipient is named without an evidenceRef");
    }
    if (entry.processing.mode === "NO_PERSISTENT_CONTENT_STORAGE") {
        problems.push("processing cannot be NO_PERSISTENT_CONTENT_STORAGE; that is a storage answer");
    }
    if (
        !sameMembers(entry.destinationRegions, [
            ...entry.customerContentStorage.countryCodes,
            ...entry.customerContentStorage.macroRegions,
        ])
    ) {
        problems.push("destinationRegions is the storage alias and differs from customerContentStorage");
    }
    for (const component of RETENTION_COMPONENTS) {
        const fact = entry.retention[component];
        if (fact.maxDays !== null && !(Number.isInteger(fact.maxDays) && fact.maxDays >= 0)) {
            problems.push(`retention.${component}.maxDays is not a whole number of days`);
        }
        if (fact.behavior === "UNKNOWN" && fact.maxDays !== null) {
            problems.push(`retention.${component} is UNKNOWN but has a maxDays`);
        }
        if (fact.behavior !== "UNKNOWN" && !fact.evidenceRef) {
            problems.push(`retention.${component} is ${fact.behavior} without an evidenceRef`);
        }
    }
    if (entry.trainsOnCustomerContent.value !== null && !entry.trainsOnCustomerContent.evidenceRef) {
        problems.push("trainsOnCustomerContent is answered without an evidenceRef");
    }
    if (
        entry.independentCommercialUseProhibited.value !== null &&
        !entry.independentCommercialUseProhibited.evidenceRef
    ) {
        problems.push("independentCommercialUseProhibited is answered without an evidenceRef");
    }
    if (entry.zeroDataRetention.mode !== "UNKNOWN" && !entry.zeroDataRetention.evidenceRef) {
        problems.push(`zeroDataRetention is ${entry.zeroDataRetention.mode} without an evidenceRef`);
    }
    return problems;
};

/**
 * The shape a row has to have before it may be called proven.
 *
 * Returns the reasons it may not, so a caller can say which part is missing
 * rather than only that something is.
 *
 * Proven means a notice may print the row, so it requires what a notice has
 * to say (handoff section 15): who receives the data and where they are,
 * where content is stored and where it is processed -- each a reviewed
 * answer, which may be "not pinned" or "not specified" but may not be
 * "nobody looked" -- whether it trains on it, how each kind of thing is
 * kept, and whether anyone may use it for their own ends. Zero data
 * retention is not required: it is what a strict route needs, and a
 * standard route discloses retention instead of avoiding it.
 */
export const provenDestinationProblems = (
    entry: ProviderDataDestination
): readonly string[] => {
    if (entry.status !== "proven") return [];
    const problems: string[] = [];
    if (!entry.evidenceRef) {
        problems.push("proven without an evidenceRef");
    }
    if (!entry.recipientEntity) {
        problems.push("proven without a recipientEntity");
    }
    if (entry.recipientCountryCodes.length === 0) {
        problems.push("proven without a recipient country");
    }
    if (entry.customerContentStorage.mode === "UNKNOWN") {
        problems.push("proven without a reviewed storage geography");
    }
    if (entry.processing.mode === "UNKNOWN") {
        problems.push("proven without a reviewed processing geography");
    }
    if (entry.trainsOnCustomerContent.value === null) {
        problems.push("proven without a training answer");
    }
    for (const component of RETENTION_COMPONENTS) {
        if (entry.retention[component].behavior === "UNKNOWN") {
            problems.push(`proven without a reviewed retention.${component}`);
        }
    }
    if (entry.independentCommercialUseProhibited.value === null) {
        problems.push("proven without an independent-commercial-use answer");
    }
    return problems;
};

/**
 * Proven, and saying nothing it cannot mean.
 *
 * Both readers go through this: a row that calls itself proven while failing
 * either check answers no, rather than the status field alone deciding.
 */
export function destinationIsDisclosable(entry: ProviderDataDestination): boolean {
    return (
        entry.status === "proven" &&
        provenDestinationProblems(entry).length === 0 &&
        destinationShapeProblems(entry).length === 0
    );
}
