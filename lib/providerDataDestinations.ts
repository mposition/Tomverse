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
 * Every entry is `unproven`. That is not a placeholder: it is the accurate
 * state. No provider's terms have been read and confirmed to answer what a
 * notice prints -- the recipient, where content is stored and where it is
 * processed, training, retention, onward use -- and the owner's contract
 * review is what will supply them. Until then:
 *
 * - **Nothing here renders to a user.** The Privacy page today says data goes
 *   "potentially in a different country", which is the sentence that cannot
 *   name a destination and is exactly what this work exists to replace.
 *   Replacing it with a table whose every row says "not established" is not a
 *   better notice; it is the same absence, louder. The page changes when the
 *   contract review lands.
 * - **Nothing here admits a request.** An `unproven` provider is not a
 *   candidate for traffic carrying a residency constraint.
 * - **Nothing becomes `proven` without an `evidenceRef`.** A destination that
 *   somebody was fairly sure about is the failure this file exists to prevent:
 *   data sent overseas on an assumption does not come back.
 *
 * ## Why this is a report and not yet a gate
 *
 * Every active provider is `unproven`, so a gate here would refuse the whole
 * catalogue on the first run. `npm run report:provider-data-destinations`
 * lists coverage and status without blocking, in the position
 * `report:model-credit-weights` holds for the same reason. It becomes a gate
 * when there is something for it to hold.
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
    /** ISO 3166-1 alpha-2, upper case. `GB`, not the legacy `UK`. */
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
     * Null while unproven. Not the product name: a person asking where their
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
     * alone never makes a route strict. The same holds for another service's
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
     * Null while unproven, and a non-null value is what `proven` means.
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
    unproven("openai"),
    unproven("anthropic"),
    unproven("google"),
    unproven("groq"),
    unproven("xai"),
    unproven("deepseek"),
    unproven("mistral"),
    unproven("moonshot"),
    unproven("minimax"),
    unproven("qwen"),
    unproven("zhipu"),
    unproven("perplexity"),
    unproven("deepinfra"),
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
 * What this answers is the prior question: is there a recorded fact about
 * where this provider takes data. An approval is an act performed *on* such a
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
 * Empty today, deliberately. A notice is a promise, and this is the list of
 * promises that can currently be kept.
 */
export const disclosableDataDestinations = (): readonly ProviderDataDestination[] =>
    PROVIDER_DATA_DESTINATIONS.filter(destinationIsDisclosable);

const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * Codes that look like ISO 3166-1 alpha-2 and are not.
 *
 * `UK` is the one the provider documents use; the code is `GB`. `EU` is
 * an exceptionally reserved code for a grouping, so it belongs in
 * `macroRegions`.
 */
const NOT_COUNTRY_CODES: ReadonlySet<string> = new Set(["UK", "EU", "EL"]);

const geographyProblems = (
    label: string,
    geography: ContentGeography
): string[] => {
    const problems: string[] = [];
    for (const code of geography.countryCodes) {
        if (!COUNTRY_CODE.test(code) || NOT_COUNTRY_CODES.has(code)) {
            problems.push(`${label} country code ${JSON.stringify(code)} is not ISO 3166-1 alpha-2`);
        }
    }
    for (const region of geography.macroRegions) {
        if (COUNTRY_CODE.test(region) && !NOT_COUNTRY_CODES.has(region)) {
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
    if (
        (geography.mode === "UNKNOWN" ||
            geography.mode === "NO_PERSISTENT_CONTENT_STORAGE") &&
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
        if (!COUNTRY_CODE.test(code) || NOT_COUNTRY_CODES.has(code)) {
            problems.push(`recipient country code ${JSON.stringify(code)} is not ISO 3166-1 alpha-2`);
        }
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
