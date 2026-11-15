import { destinationIsDisclosable, type ContentGeography, type ProviderDataDestination, type RetentionFact } from "@/lib/providerDataDestinations";

const PROVIDER_LABELS: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    cohere: "Cohere",
    google: "Google",
    groq: "Groq",
    xai: "xAI",
    deepseek: "DeepSeek",
    mistral: "Mistral",
    moonshot: "Moonshot",
    minimax: "MiniMax",
    qwen: "Qwen",
    zhipu: "Zhipu",
    perplexity: "Perplexity",
    deepinfra: "DeepInfra",
    together: "Together",
    openrouter: "OpenRouter",
    sail: "Sail",
};

function placeName(code: string, t: (key: string) => string): string {
    const key = `privacyPolicy.place${code}`;
    const label = t(key);
    return label === key ? code : label;
}

function geographyLabel(geo: ContentGeography, t: (key: string) => string): string {
    const modeKey = {
        UNKNOWN: "privacyPolicy.geoNotSpecified",
        COMMITTED_LOCATIONS: "privacyPolicy.geoCommitted",
        DISCLOSED_POSSIBLE_LOCATIONS: "privacyPolicy.geoDisclosedPossible",
        NOT_PINNED: "privacyPolicy.geoNotPinned",
        NOT_SPECIFIED: "privacyPolicy.geoNotSpecified",
        NO_PERSISTENT_CONTENT_STORAGE: "privacyPolicy.geoNoPersistentContent",
    }[geo.mode];
    const places = [...geo.countryCodes, ...geo.macroRegions].map((code) => placeName(code, t));
    const mode = t(modeKey);
    return places.length > 0 ? `${mode}: ${places.join(", ")}` : mode;
}

function retentionLabel(fact: RetentionFact, t: (key: string) => string): string {
    if (fact.behavior === "BOUNDED" && fact.maxDays !== null) {
        return t("privacyPolicy.retentionBounded").replaceAll("{days}", String(fact.maxDays));
    }
    const key = {
        UNKNOWN: "privacyPolicy.retentionNotSpecified",
        NO_PERSISTENT_STORAGE: "privacyPolicy.retentionNoPersistent",
        TRANSIENT: "privacyPolicy.retentionTransient",
        BOUNDED: "privacyPolicy.retentionNotSpecified",
        CUSTOMER_CONTROLLED: "privacyPolicy.retentionCustomerControlled",
        NOT_SPECIFIED: "privacyPolicy.retentionNotSpecified",
        NOT_APPLICABLE: "privacyPolicy.retentionNotSpecified",
    }[fact.behavior];
    return t(key);
}

export function ProviderDestinationTable({
    rows,
    t,
}: {
    rows: readonly ProviderDataDestination[];
    t: (key: string) => string;
}) {
    const headers = [
        "colProvider",
        "colRecipient",
        "colStorage",
        "colProcessing",
        "colTraining",
        "colRetention",
        "colCommercialUse",
    ] as const;
    return (
        <div className="mt-6">
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                {t("privacyPolicy.providerTableTitle")}
            </h3>
            <p className="mt-2">{t("privacyPolicy.providerTableIntro")}</p>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                {t("privacyPolicy.providerTableScrollHint")}
            </p>
            {/*
                The table is wider than a phone, so it is the only part of this
                section that scrolls sideways. A scroll container needs to be
                focusable and named or a keyboard-only reader cannot reach the
                columns past "Storage" (WCAG 2.1.1), the same treatment the plan
                comparison table gets on the pricing page.
            */}
            <div
                className="mt-3 overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400"
                role="region"
                aria-label={t("privacyPolicy.providerTableTitle")}
                tabIndex={0}
            >
                <table className="w-full min-w-[720px] table-fixed border-collapse text-left [overflow-wrap:anywhere]">
                    <caption className="sr-only">{t("privacyPolicy.providerTableTitle")}</caption>
                    <thead>
                        <tr className="border-b border-zinc-200 dark:border-zinc-800">
                            {headers.map((key) => (
                                <th key={key} scope="col" className="py-2 pr-3 font-semibold text-zinc-900 dark:text-zinc-100">
                                    {t(`privacyPolicy.${key}`)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.provider} className="border-b border-zinc-100 align-top dark:border-zinc-900">
                                <th scope="row" className="py-3 pr-3 font-semibold text-zinc-900 dark:text-zinc-100">
                                    {PROVIDER_LABELS[row.provider] ?? row.provider}
                                    {row.evidenceRef ? (
                                        <a
                                            href={row.evidenceRef}
                                            className="mt-1 block font-normal text-blue-600 underline dark:text-blue-400"
                                            rel="noopener noreferrer"
                                            target="_blank"
                                        >
                                            {t("privacyPolicy.providerSource")}
                                        </a>
                                    ) : null}
                                </th>
                                {destinationIsDisclosable(row) ? <>
                                <td className="py-3 pr-3">
                                    {row.recipientEntity}
                                    {row.recipientCountryCodes.length > 0 ? (
                                        <span className="mt-1 block">
                                            {row.recipientCountryCodes.map((code) => placeName(code, t)).join(", ")}
                                        </span>
                                    ) : null}
                                </td>
                                <td className="py-3 pr-3">{geographyLabel(row.customerContentStorage, t)}</td>
                                <td className="py-3 pr-3">{geographyLabel(row.processing, t)}</td>
                                <td className="py-3 pr-3">
                                    {row.trainsOnCustomerContent.value === true
                                        ? t("privacyPolicy.trainsYes")
                                        : row.trainsOnCustomerContent.value === false
                                          ? t("privacyPolicy.trainsNo")
                                          : null}
                                </td>
                                <td className="py-3 pr-3">{retentionLabel(row.retention.content, t)}</td>
                                <td className="py-3 pr-3">
                                    {row.independentCommercialUseProhibited.value === true
                                        ? t("privacyPolicy.commercialProhibited")
                                        : row.independentCommercialUseProhibited.value === false
                                          ? t("privacyPolicy.commercialAllowed")
                                          : null}
                                </td>
                                </> : (
                                    <td colSpan={6} className="py-3 pr-3">
                                        {row.recipientEntity ? <p>{row.recipientEntity}</p> : null}
                                        <p>{t("privacyPolicy.providerUnverifiedNotice")}</p>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
