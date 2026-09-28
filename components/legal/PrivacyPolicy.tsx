"use client";

import Link from "next/link";
import { ArrowLeft, BarChart3, Bot, Database, FileUp, Mail, Mic, Scale, Send, ShieldCheck, Share2, UserRound } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
    MarketingFooter,
    MarketingHeader,
} from "@/components/marketing/MarketingChrome";
import {
    PROVIDER_DATA_DESTINATIONS,
    disclosableDataDestinations,
    type ContentGeography,
    type ProviderDataDestination,
    type RetentionFact,
} from "@/lib/providerDataDestinations";

/**
 * The eight things Korea's PIPA art. 28-8(2) requires an overseas-transfer
 * notice to state, each on its own line.
 *
 * Rendered as a list rather than folded into the Voice paragraph because the
 * question a reader or a regulator asks is item-by-item — which country, who
 * receives it, how to refuse — and a prose sentence long enough to carry all
 * eight answers none of them where they can be found
 * (docs/policy/voice-input.md §11.4).
 */
const VOICE_TRANSFER_ITEMS = [
    "voiceInputTransfer1",
    "voiceInputTransfer2",
    "voiceInputTransfer3",
    "voiceInputTransfer4",
    "voiceInputTransfer5",
    "voiceInputTransfer6",
    "voiceInputTransfer7",
    "voiceInputTransfer8",
] as const;

/**
 * What Tomverse itself controls about a chat turn, in the same itemized
 * shape as the voice notice.
 *
 * Country, the recipient's legal name, and retention are the table below,
 * and only when every enrolled provider is disclosable. One unproven row
 * takes the whole table off the page, so a live provider is never omitted.
 */
const PROVIDER_TRANSFER_ITEMS = [
    "providerTransfer1",
    "providerTransfer2",
    "providerTransfer3",
    "providerTransfer4",
    "providerTransfer5",
    "providerTransfer6",
    "providerTransfer7",
] as const;

const PROVIDER_LABELS: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
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

function ProviderDestinationTable({
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
            <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-left">
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
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

const sections = [
    ["collectedTitle", "collected", UserRound],
    ["purposeTitle", "purpose", Database],
    ["providersTitle", "providers", Send],
    // Its own section rather than a sentence inside "External AI providers":
    // the promise that matters here is what happens to the *recording*, and
    // that is a retention statement, not a transfer one
    // (docs/policy/voice-input.md §11.4).
    ["voiceInputTitle", "voiceInput", Mic],
    ["attachmentsTitle", "attachments", FileUp],
    ["externalImportTitle", "externalImport", FileUp],
    ["memoryTitle", "memory", Database],
    ["assistantProfilesTitle", "assistantProfiles", Bot],
    // Its own section rather than a line inside "Retention": what a reader
    // needs to know is which mail they can switch off and what is stored to
    // honour that, and the one record that outlives the account is the part a
    // retention sentence would bury (Q12, docs/ops/q12-privacy-email-disclosure-draft.md).
    //
    // Above analytics because a mail preference is a processing purpose rather
    // than a measurement one, and below the features whose data it describes.
    ["emailTitle", "email", Mail],
    ["analyticsTitle", "analytics", BarChart3],
    ["retentionTitle", "retention", Database],
    ["sharingTitle", "sharing", Share2],
    ["rightsTitle", "rights", Scale],
    ["securityTitle", "security", ShieldCheck],
    ["changesTitle", "changes", Scale],
] as const;

export function PrivacyPolicy() {
    const { t, lang } = useLanguage();
    const localizedContentAvailable = lang === "en" || lang === "ko" || lang === "zh";
    const destinations = disclosableDataDestinations();
    const showProviderTable =
        destinations.length > 0 &&
        destinations.length === PROVIDER_DATA_DESTINATIONS.length;

    return (
        <main className="min-h-screen overflow-y-auto bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <MarketingHeader
                maxWidth="max-w-4xl"
                localizedContentAvailable={localizedContentAvailable}
            />

            <article
                lang={localizedContentAvailable ? lang : "en"}
                className="mx-auto max-w-4xl px-5 py-12"
            >
                <div className="border-b border-zinc-200 pb-8 dark:border-zinc-800">
                    <h1 className="text-3xl font-bold">{t("privacyPolicy.title")}</h1>
                    <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t("privacyPolicy.effective")}</p>
                    <p className="mt-6 max-w-3xl text-base leading-7 text-zinc-600 dark:text-zinc-300">
                        {t("privacyPolicy.intro")}
                    </p>
                </div>

                <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {sections.map(([titleKey, bodyKey, Icon]) => (
                        <section
                            key={titleKey}
                            className="grid gap-4 py-7 md:grid-cols-[180px_1fr]"
                        >
                            <h2 className="flex items-center gap-2 text-sm font-semibold">
                                <Icon className="h-4 w-4 text-blue-500" />
                                {t(`privacyPolicy.${titleKey}`)}
                            </h2>
                            <div className="text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                                <p>{t(`privacyPolicy.${bodyKey}`)}</p>
                                {bodyKey === "providers" && (
                                    <>
                                        <h3 className="mt-5 font-semibold text-zinc-900 dark:text-zinc-100">
                                            {t("privacyPolicy.providerTransferTitle")}
                                        </h3>
                                        <ul className="mt-2 list-disc space-y-1.5 pl-5">
                                            {PROVIDER_TRANSFER_ITEMS.map((itemKey) => (
                                                <li key={itemKey}>
                                                    {t(`privacyPolicy.${itemKey}`)}
                                                </li>
                                            ))}
                                        </ul>
                                        {showProviderTable ? (
                                            <ProviderDestinationTable rows={destinations} t={t} />
                                        ) : null}
                                    </>
                                )}
                                {bodyKey === "voiceInput" && (
                                    <>
                                        <h3 className="mt-5 font-semibold text-zinc-900 dark:text-zinc-100">
                                            {t("privacyPolicy.voiceInputTransferTitle")}
                                        </h3>
                                        <ul className="mt-2 list-disc space-y-1.5 pl-5">
                                            {VOICE_TRANSFER_ITEMS.map((itemKey) => (
                                                <li key={itemKey}>
                                                    {t(`privacyPolicy.${itemKey}`)}
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                            </div>
                        </section>
                    ))}
                </div>

                <Link
                    href="/"
                    className="mt-8 inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                >
                    <ArrowLeft className="h-4 w-4" />
                    {t("privacyPolicy.back")}
                </Link>
            </article>
            <MarketingFooter maxWidth="max-w-4xl" />
        </main>
    );
}
