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
 * state. No provider contract has been read and confirmed to name a recipient
 * entity and a processing region, and the owner's contract review is what will
 * supply them. Until then:
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
     * The regions the data is processed in.
     *
     * Empty while unproven. A region here is a commitment the Privacy page
     * will print and the routing gate will enforce, so an entry belongs only
     * when the contract says it.
     */
    destinationRegions: readonly string[];
    /**
     * The fixed identifier of what lets us say the above.
     *
     * A contract, a DPA, a provider's own published sub-processor page --
     * named so that a later reader can check it rather than trust this file.
     * Null while unproven, and a non-null value is what `proven` means.
     */
    evidenceRef: string | null;
    status: ProviderDestinationStatus;
};

const unproven = (provider: AiProvider): ProviderDataDestination => ({
    provider,
    recipientEntity: null,
    destinationRegions: [],
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
];

export const providerDataDestination = (
    provider: AiProvider
): ProviderDataDestination | null =>
    PROVIDER_DATA_DESTINATIONS.find((entry) => entry.provider === provider) ??
    null;

/**
 * Whether a provider may serve a request that carries a residency constraint.
 *
 * Fail-closed by construction: an absent entry and an unproven one both answer
 * no, and they answer it for the same reason -- nobody can say where the data
 * would go.
 */
export const mayServeConstrainedTraffic = (provider: AiProvider): boolean =>
    providerDataDestination(provider)?.status === "proven";

/**
 * The entries a user-facing notice may print.
 *
 * Empty today, deliberately. A notice is a promise, and this is the list of
 * promises that can currently be kept.
 */
export const disclosableDataDestinations = (): readonly ProviderDataDestination[] =>
    PROVIDER_DATA_DESTINATIONS.filter((entry) => entry.status === "proven");

/**
 * The shape a row has to have before it may be called proven.
 *
 * Returns the reasons it may not, so a caller can say which part is missing
 * rather than only that something is.
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
    if (entry.destinationRegions.length === 0) {
        problems.push("proven without a destinationRegion");
    }
    return problems;
};
