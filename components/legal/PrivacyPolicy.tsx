"use client";

import { useRef, useState } from "react";
import { ProviderDestinationTable } from "@/components/legal/ProviderDestinationTable";
import { BarChart3, Bot, Building2, Database, FileUp, ImageIcon, KeyRound, Mail, MapPin, MessageSquare, Mic, Scale, Search, Send, ShieldCheck, Share2, UserRound, Workflow } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { englishLocationNotice } from "@/locales/privacyLocation";
import { LegalDocumentPage } from "@/components/marketing/v2/policy/LegalDocumentPage";
import { fill } from "@/components/marketing/v2/policy/PolicyChrome";
import { policyPageContent } from "@/components/marketing/v2/policy/policyPageContent";
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

/**
 * An itemized notice drawn as the rows of a card. Each item is a "Label: text"
 * sentence; the label (with its own colon) and the rest are printed exactly as
 * written, so a row reads as the same sentence. An item without a short label
 * is printed whole.
 */
function ItemizedNotice({ titleKey, itemKeys, t }: { titleKey: string; itemKeys: readonly string[]; t: (key: string) => string }) {
    return (
        <div className="legal-dl">
            <h3 className="dl-head">{t(`privacyPolicy.${titleKey}`)}</h3>
            <ul className="legal-items">
                {itemKeys.map((itemKey) => {
                    const text = t(`privacyPolicy.${itemKey}`);
                    const labelled = /^([^:：\n]{1,60}?[:：])(\s*)([\s\S]+)$/.exec(text);
                    return labelled ? (
                        <li key={itemKey}><b>{labelled[1]}</b>{labelled[2]}{labelled[3]}</li>
                    ) : (
                        <li key={itemKey} className="plain">{text}</li>
                    );
                })}
            </ul>
        </div>
    );
}

/**
 * The provider table with a search box. Searching only hides the rows that do
 * not contain the query: every row is still rendered, and says what it said
 * before. A language change remounts it (`key`), which clears the search.
 */
function SearchableProviderTable({ rows, t, copy }: {
    rows: typeof PROVIDER_DATA_DESTINATIONS;
    t: (key: string) => string;
    copy: { label: string; placeholder: string; empty: string; count: string };
}) {
    const tableRef = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState("");
    const [shown, setShown] = useState<number>(rows.length);
    const search = (value: string) => {
        setQuery(value);
        const needle = value.trim().toLowerCase();
        let count = 0;
        tableRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr").forEach((row) => {
            const match = !needle || (row.textContent ?? "").toLowerCase().includes(needle);
            row.hidden = !match;
            if (match) count += 1;
        });
        setShown(count);
    };
    return (
        <div className="min-w-0 legal-table" ref={tableRef}>
            <div className="prov-tools">
                <label>
                    <Search className="legal-icon" aria-hidden="true" />
                    <span className="sr-only">{copy.label}</span>
                    <input
                        type="search"
                        value={query}
                        onChange={(event) => search(event.target.value)}
                        placeholder={copy.placeholder}
                        data-testid="privacy-provider-search"
                    />
                </label>
            </div>
            <ProviderDestinationTable rows={rows} t={t} />
            {shown === 0 ? <p className="prov-empty">{copy.empty}</p> : null}
            <p className="sr-only" role="status">{query.trim() ? fill(copy.count, shown) : ""}</p>
        </div>
    );
}

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
    const copy = policyPageContent[lang];
    // The rights section keeps the anchor it had before every section got one.
    const sectionId = (bodyKey: string) => (bodyKey === "rights" ? "account-deletion" : bodyKey);

    return (
        <LegalDocumentPage
            document="privacy"
            contentLang={localizedContentAvailable ? lang : "en"}
            localizedContentAvailable={localizedContentAvailable}
            eyebrow={copy.privacyEyebrow}
            title={t("privacyPolicy.title")}
            lead={t("privacyPolicy.intro")}
            date={t("privacyPolicy.effective")}
            sections={visibleSections.map(([titleKey, bodyKey]) => ({ id: sectionId(bodyKey), title: t(`privacyPolicy.${titleKey}`) }))}
            actions={[{ href: "/", label: t("privacyPolicy.back") }, { href: "/support", label: copy.support }]}
        >
            {visibleSections.map(([titleKey, bodyKey, Icon], index) => (
                <section
                    key={titleKey}
                    id={sectionId(bodyKey)}
                    className="legal-sec"
                    aria-labelledby={`${sectionId(bodyKey)}-title`}
                >
                    <h2 id={`${sectionId(bodyKey)}-title`}>
                        <span aria-hidden="true"><Icon className="legal-icon" />{String(index + 1).padStart(2, "0")}</span>
                        {t(`privacyPolicy.${titleKey}`)}
                    </h2>
                    {/*
                        min-w-0: the provider table below is wider than a
                        phone; without it the section's sentences would take
                        the table's minimum width instead of wrapping. With it,
                        only the table scrolls.
                    */}
                    <div className="min-w-0 legal-text">
                        {bodyKey === "location" && lang === "en" ? (
                            <div className="legal-groups" data-testid="privacy-location-sections">
                                {englishLocationNotice.map(group => (
                                    <div key={group.title}>
                                        <h3>{group.title}</h3>
                                        {"items" in group ? (
                                            <ul className="bullets">
                                                {group.items.map(item => <li key={item}>{item}</li>)}
                                            </ul>
                                        ) : (
                                            <div>
                                                {group.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ) : bodyKey === "location" ? t("privacyPolicy.location").split("\n\n").map((paragraph) => (<p key={paragraph}>{paragraph}</p>)) : <p>{t(`privacyPolicy.${bodyKey}`)}</p>}
                        {bodyKey === "rights" && (
                            <>
                                <h3>{t("auth.deleteAccount")}</h3>
                                <p>{t("privacyPolicy.deletionRequest")}</p>
                                <a href="mailto:support@tomverse.app?subject=Tomverse%20account%20and%20data%20deletion%20request" className="legal-mail">
                                    <Mail className="legal-icon" aria-hidden="true" />
                                    {t("auth.deleteAccount")} · support@tomverse.app
                                </a>
                                <p>{t("privacyPolicy.deletionSubscriptions")}</p>
                            </>
                        )}
                        {bodyKey === "providers" && <ItemizedNotice titleKey="providerTransferTitle" itemKeys={PROVIDER_TRANSFER_ITEMS} t={t} />}
                        {bodyKey === "comments" && <ItemizedNotice titleKey="commentsTransferTitle" itemKeys={COMMENTS_ITEMS} t={t} />}
                        {bodyKey === "semanticSearch" && <ItemizedNotice titleKey="semanticSearchTransferTitle" itemKeys={SEMANTIC_SEARCH_TRANSFER_ITEMS} t={t} />}
                        {bodyKey === "analytics" && <ItemizedNotice titleKey="analyticsUserIdTitle" itemKeys={ANALYTICS_USER_ID_ITEMS} t={t} />}
                        {bodyKey === "voiceInput" && <ItemizedNotice titleKey="voiceInputTransferTitle" itemKeys={VOICE_TRANSFER_ITEMS} t={t} />}
                    </div>
                    {bodyKey === "providers" && showProviderTable ? (
                        <SearchableProviderTable key={lang} rows={destinations} t={t} copy={copy.providerSearch} />
                    ) : null}
                </section>
            ))}
        </LegalDocumentPage>
    );
}
