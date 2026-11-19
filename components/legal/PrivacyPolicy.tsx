"use client";

import Link from "next/link";
import { ProviderDestinationTable } from "@/components/legal/ProviderDestinationTable";
import { ArrowLeft, BarChart3, Bot, Building2, Database, FileUp, ImageIcon, KeyRound, Mail, MapPin, MessageSquare, Mic, Scale, Search, Send, ShieldCheck, Share2, UserRound, Workflow } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { englishLocationNotice } from "@/locales/privacyLocation";
import {
    MarketingFooter,
    MarketingHeader,
} from "@/components/marketing/MarketingChrome";
import { COMMENTS_PRIVACY_NOTICE_CONFIRMED } from "@/lib/privacyNoticeStatus";
import { SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED } from "@/lib/privacyNoticeStatus";
import {
    PROVIDER_DATA_DESTINATIONS,
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

/**
 * How the comment monitor handles a public comment under one of Tomverse's own
 * posts, itemized like the voice notice because the question a commenter or a
 * regulator asks is item-by-item: what is read, what is kept, who receives it,
 * on what basis, for how long (docs/policy/marketing-automation.md section
 * 12.1). Only what the code does is stated; facts not yet confirmed carry an
 * operator-confirmation placeholder in the locale text.
 */
const COMMENTS_ITEMS = [
    "commentsTransfer1",
    "commentsTransfer2",
    "commentsTransfer3",
    "commentsTransfer4",
    "commentsTransfer5",
    "commentsTransfer6",
    "commentsTransfer7",
    "commentsTransfer8",
] as const;

/**
 * What is sent to Cohere for semantic search of knowledge files and account
 * memory, itemized like the voice notice because it is the same kind of
 * overseas transfer (docs/policy/external-conversation-import-and-memory.md
 * sections 9a and 16). The section is shown only once the operator has
 * confirmed the facts its placeholders stand for.
 */
const SEMANTIC_SEARCH_TRANSFER_ITEMS = [
    "semanticSearchTransfer1",
    "semanticSearchTransfer2",
    "semanticSearchTransfer3",
    "semanticSearchTransfer4",
    "semanticSearchTransfer5",
    "semanticSearchTransfer6",
    "semanticSearchTransfer7",
    "semanticSearchTransfer8",
] as const;

/**
 * The GA4 User-ID, itemized for the same reason. It is created and sent only
 * when the notice is published, the switch is on, analytics was explicitly
 * accepted and the visitor is signed in (lib/ga4UserIdPolicy.ts).
 */
const ANALYTICS_USER_ID_ITEMS = [
    "analyticsUserId1",
    "analyticsUserId2",
    "analyticsUserId3",
    "analyticsUserId4",
    "analyticsUserId5",
    "analyticsUserId6",
] as const;

const sections = [
    ["collectedTitle", "collected", UserRound],
    ["purposeTitle", "purpose", Database],
    ["locationTitle", "location", MapPin],
    ["providersTitle", "providers", Send],
    // Its own section, right after the provider table: titles, Prompt Refiner,
    // the Auto router, image and location intent and Review's cross-review send
    // part of the input to a provider Tomverse chooses, whichever model the
    // user picked, so "do not choose that model" does not refuse them.
    ["auxiliaryProcessingTitle", "auxiliaryProcessing", Workflow],
    // Its own section rather than a sentence inside "External AI providers":
    // the promise that matters here is what happens to the *recording*, and
    // that is a retention statement, not a transfer one
    // (docs/policy/voice-input.md §11.4).
    ["voiceInputTitle", "voiceInput", Mic],
    ["attachmentsTitle", "attachments", FileUp],
    // Prompts and photos to edit go to image providers (docs/policy/image-generation.md).
    ["imageGenerationTitle", "imageGeneration", ImageIcon],
    ["externalImportTitle", "externalImport", FileUp],
    ["memoryTitle", "memory", Database],
    ["assistantProfilesTitle", "assistantProfiles", Bot],
    // Requests from coding tools and what is kept of them (docs/policy/external-api.md section 6).
    ["externalApiTitle", "externalApi", KeyRound],
    // Its own section: the semantic search sends the question and candidate
    // passages to a search provider, which is a transfer the assistant-profile
    // and memory paragraphs do not describe. Hidden, with the calls, until the
    // operator confirms its three open facts.
    ["semanticSearchTitle", "semanticSearch", Search],
    // Its own section rather than a line inside "Retention": what a reader
    // needs to know is which mail they can switch off and what is stored to
    // honour that, and the one record that outlives the account is the part a
    // retention sentence would bury (Q12, docs/ops/q12-privacy-email-disclosure-draft.md).
    //
    // Above analytics because a mail preference is a processing purpose rather
    // than a measurement one, and below the features whose data it describes.
    ["emailTitle", "email", Mail],
    // Its own section: it concerns people who comment on Tomverse's posts,
    // whether or not they have an account, so it is not a line under a feature
    // an account holder uses (docs/policy/marketing-automation.md section 12.1).
    ["commentsTitle", "comments", MessageSquare],
    // The non-AI companies that host, store and bill (APP 1.4(f)-(g)).
    ["serviceProvidersTitle", "serviceProviders", Building2],
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
    const destinations = PROVIDER_DATA_DESTINATIONS;
    // The comment-monitoring and semantic-search sections are shown only once
    // their operator-confirmation placeholders are resolved
    // (lib/privacyNoticeStatus.ts).
    const visibleSections = sections.filter(
        ([, bodyKey]) => bodyKey !== "comments" || COMMENTS_PRIVACY_NOTICE_CONFIRMED
    ).filter(
        ([, bodyKey]) => bodyKey !== "semanticSearch" || SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED
    );
    const showProviderTable = destinations.length > 0;

    return (
        <main className="min-h-screen overflow-y-auto bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
            <MarketingHeader
                maxWidth="max-w-7xl"
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
                    {visibleSections.map(([titleKey, bodyKey, Icon]) => (
                        <section
                            key={titleKey}
                            id={bodyKey === "rights" ? "account-deletion" : undefined}
                            className="grid scroll-mt-24 gap-4 py-7 md:grid-cols-[180px_1fr]"
                        >
                            <h2 className="flex self-start items-center gap-2 text-sm font-semibold">
                                <Icon className="h-4 w-4 text-blue-500" />
                                {t(`privacyPolicy.${titleKey}`)}
                            </h2>
                            {/*
                                min-w-0: without it this grid item takes the
                                720px min-width of the provider table as its own
                                minimum, so the whole section -- paragraphs and
                                list included -- grew past a 320px viewport and
                                its sentences were cut off instead of wrapping.
                                With it, only the table scrolls.
                            */}
                            <div className="min-w-0 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                                {bodyKey === "location" && lang === "en" ? (
                                    <div className="space-y-5" data-testid="privacy-location-sections">
                                        {englishLocationNotice.map(group => (
                                            <div key={group.title}>
                                                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{group.title}</h3>
                                                {"items" in group ? (
                                                    <ul className="mt-2 list-disc space-y-2 pl-5">
                                                        {group.items.map(item => <li key={item}>{item}</li>)}
                                                    </ul>
                                                ) : (
                                                    <div className="mt-2 space-y-3">
                                                        {group.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                ) : bodyKey === "location" ? t("privacyPolicy.location").split("\n\n").map((paragraph, index) => (<p key={paragraph} className={index ? "mt-4" : undefined}>{paragraph}</p>)) : <p>{t(`privacyPolicy.${bodyKey}`)}</p>}
                                {bodyKey === "rights" && (
                                    <div className="mt-5 space-y-3">
                                        <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{t("auth.deleteAccount")}</h3>
                                        <p>{t("privacyPolicy.deletionRequest")}</p>
                                        <a href="mailto:support@tomverse.app?subject=Tomverse%20account%20and%20data%20deletion%20request" className="inline-flex items-center gap-2 font-semibold text-blue-600 underline underline-offset-4 dark:text-blue-400">
                                            <Mail className="h-4 w-4" aria-hidden="true" />
                                            {t("auth.deleteAccount")} · support@tomverse.app
                                        </a>
                                        <p>{t("privacyPolicy.deletionSubscriptions")}</p>
                                    </div>
                                )}
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
                                    </>
                                )}
                                {bodyKey === "comments" && (
                                    <>
                                        <h3 className="mt-5 font-semibold text-zinc-900 dark:text-zinc-100">
                                            {t("privacyPolicy.commentsTransferTitle")}
                                        </h3>
                                        <ul className="mt-2 list-disc space-y-1.5 pl-5">
                                            {COMMENTS_ITEMS.map((itemKey) => (
                                                <li key={itemKey}>
                                                    {t(`privacyPolicy.${itemKey}`)}
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                                {bodyKey === "semanticSearch" && (
                                    <>
                                        <h3 className="mt-5 font-semibold text-zinc-900 dark:text-zinc-100">
                                            {t("privacyPolicy.semanticSearchTransferTitle")}
                                        </h3>
                                        <ul className="mt-2 list-disc space-y-1.5 pl-5">
                                            {SEMANTIC_SEARCH_TRANSFER_ITEMS.map((itemKey) => (
                                                <li key={itemKey}>
                                                    {t(`privacyPolicy.${itemKey}`)}
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                                {bodyKey === "analytics" && (
                                    <>
                                        <h3 className="mt-5 font-semibold text-zinc-900 dark:text-zinc-100">
                                            {t("privacyPolicy.analyticsUserIdTitle")}
                                        </h3>
                                        <ul className="mt-2 list-disc space-y-1.5 pl-5">
                                            {ANALYTICS_USER_ID_ITEMS.map((itemKey) => (
                                                <li key={itemKey}>
                                                    {t(`privacyPolicy.${itemKey}`)}
                                                </li>
                                            ))}
                                        </ul>
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
                            {bodyKey === "providers" && showProviderTable ? (
                                <div className="min-w-0 text-sm leading-7 text-zinc-600 md:col-span-2 dark:text-zinc-300">
                                    <ProviderDestinationTable rows={destinations} t={t} />
                                </div>
                            ) : null}
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
