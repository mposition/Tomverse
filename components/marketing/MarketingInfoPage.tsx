"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, ChevronDown } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { ChatGptVsClaudeGuide } from "./ChatGptVsClaudeGuide";
import { AiReviewDemo } from "./AiReviewDemo";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";
import { LOCALIZED_SEO_PATHS, localizedPath } from "@/lib/seo";
import { useMarketingChatEntry } from "./MarketingChatAvailability";
import { marketingProductEntryHref } from "@/lib/marketingProductEntry";

type MarketingInfoLink = {
  label: string;
  href: string;
  external?: boolean;
};

export type MarketingInfoSection = {
  id?: string;
  lang?: Language;
  title: string;
  body: string;
  bodyLinks?: { text: string; href: string }[];
  formatGroups?: Array<{ label: string; extensions: string[] }>;
  bullets?: string[];
  guestTrialLinks?: { available: string; unavailable: string; chat: string; review: string; models: string };
  link?: MarketingInfoLink;
  links?: MarketingInfoLink[];
  comparisonTable?: { caption: string; headers: string[]; rows: string[][] };
};

export type MarketingInfoCopy = {
  eyebrow: string;
  title: string;
  description: string;
  updated?: string;
  introCtaLabel?: string;
  sectionNavLabel?: string;
  keepWords?: boolean;
  mobileAccordion?: boolean;
  sections: MarketingInfoSection[];
  cta?: {
    label: string;
    href: string;
  };
};

function sectionBody(section: MarketingInfoSection, pageHref: (href: string) => string): ReactNode {
  if (!section.bodyLinks?.length) return section.body;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, link] of section.bodyLinks.entries()) {
    const start = section.body.indexOf(link.text, cursor);
    if (start < 0) continue;
    parts.push(section.body.slice(cursor, start));
    parts.push(<Link key={index} href={pageHref(link.href)} className="font-semibold text-blue-600 underline underline-offset-4 dark:text-blue-300">{link.text}</Link>);
    cursor = start + link.text.length;
  }
  parts.push(section.body.slice(cursor));
  return parts;
}

export function MarketingInfoPage({
  content,
  template,
  readableBody = false,
}: {
  content: { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>;
  template?: "chatgpt-vs-claude" | "ai-answer-review";
  readableBody?: boolean;
}) {
  const { lang } = useLanguage();
  const { guestTrialAvailable, reviewHref } = useMarketingChatEntry();
  const localizedPage = content[lang];
  const page = localizedPage ?? content.en;
  const sectionId = useId();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const pageHref = (href: string) => {
    if (href === "/support/help-centre/chat-workspace") return chatWorkspaceGuideHref(lang);
    if (href.startsWith("/review") || /^\/chat(?=\?|$)/.test(href)) {
      const url = new URL(href.replace(/^\/chat(?=\?|$)/, "/review"), "https://tomverse.app");
      url.searchParams.set("lang", lang);
      return `${url.pathname}${url.search}${url.hash}`;
    }
    const url = href.startsWith("/") ? new URL(href, "https://tomverse.app") : null;
    if (url && LOCALIZED_SEO_PATHS.includes(url.pathname as (typeof LOCALIZED_SEO_PATHS)[number])) {
      return `${localizedPath(lang, url.pathname)}${url.search}${url.hash}`;
    }
    return href;
  };

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader
        maxWidth="max-w-6xl"
        localizedContentAvailable={Boolean(localizedPage)}
      />

      <section
        lang={localizedPage ? lang : "en"}
        className={`mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20 ${page.keepWords ? "break-keep [overflow-wrap:anywhere]" : ""} ${readableBody ? "[overflow-wrap:anywhere]" : ""}`}
      >
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{page.eyebrow}</p>
          <h1 className={`mt-4 text-4xl font-black leading-tight sm:text-6xl ${page.mobileAccordion ? "[overflow-wrap:anywhere]" : ""}`}>{page.title}</h1>
          <p className="mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-300">{page.description}</p>
          {page.introCtaLabel && page.cta ? (
            <Link href={pageHref(page.cta.href)} onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "marketing_info_intro" })}
              data-testid="marketing-info-intro-cta"
              className="mt-6 inline-flex min-h-12 max-w-full items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-blue-500">
              {page.introCtaLabel}<ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
            </Link>
          ) : null}
          {page.updated && <p className="mt-4 text-sm font-semibold text-zinc-500 dark:text-zinc-400">{page.updated}</p>}
        </div>

        {page.sectionNavLabel ? (
          <nav aria-label={page.sectionNavLabel} className="mt-8 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
            <p className="text-sm font-bold">{page.sectionNavLabel}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {page.sections.filter((section) => section.id).map((section) => (
                <a key={section.id} href={`#${section.id}`} className="inline-flex min-h-11 min-w-0 items-center rounded-lg border border-zinc-200 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-zinc-700 dark:text-blue-300 dark:hover:bg-zinc-900">{section.title}</a>
              ))}
            </div>
          </nav>
        ) : null}

        {template === "chatgpt-vs-claude" ? (
          <ChatGptVsClaudeGuide />
        ) : (
          <>
            {template === "ai-answer-review" ? (
              <div className="mt-12">
                <AiReviewDemo showLearnMore={false} />
              </div>
            ) : null}
            <div className={`mt-12 grid ${page.mobileAccordion ? "grid-cols-1 gap-3 sm:gap-5" : "gap-5"}`}>
              {page.sections.map((section, index) => {
                const links = [...(section.link ? [section.link] : []), ...(section.links ?? [])];
                return (
                <article key={section.title} id={section.id} tabIndex={section.id ? -1 : undefined} lang={section.lang} className={`scroll-mt-28 focus-visible:outline-2 focus-visible:outline-blue-600 rounded-2xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40 ${readableBody ? "min-w-0" : ""} ${page.mobileAccordion ? "min-w-0 p-4 [overflow-wrap:anywhere] sm:p-6" : "p-6"}`}>
                  <h2 className="text-xl font-black">
                    {page.mobileAccordion ? <>
                      <span className="hidden sm:inline">{section.title}</span>
                      <button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 sm:hidden"
                        aria-expanded={expandedSections.has(section.title)}
                        aria-controls={`${sectionId}-${index}`}
                        onClick={() => setExpandedSections(previous => {
                          const next = new Set(previous);
                          if (next.has(section.title)) next.delete(section.title);
                          else next.add(section.title);
                          return next;
                        })}>
                        <span className="min-w-0 flex-1">{section.title}</span><ChevronDown aria-hidden="true" className={`h-5 w-5 shrink-0 ${expandedSections.has(section.title) ? "rotate-180" : ""}`} />
                      </button>
                    </> : section.title}
                  </h2>
                  <div id={`${sectionId}-${index}`} className={page.mobileAccordion && !expandedSections.has(section.title) ? "hidden sm:block" : undefined}>
                  <p className={`mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300 ${readableBody ? "max-w-[80ch] sm:text-base" : ""}`}>{sectionBody(section, pageHref)}</p>
                  {section.comparisonTable ? <table className="mt-5 w-full table-fixed border-collapse text-left text-sm leading-6 [overflow-wrap:anywhere]">
                    <caption className="mb-2 text-left font-bold">{section.comparisonTable.caption}</caption>
                    <thead><tr>{section.comparisonTable.headers.map(header => <th key={header} scope="col" className="border-b border-zinc-300 p-2 align-top dark:border-zinc-700">{header}</th>)}</tr></thead>
                    <tbody>{section.comparisonTable.rows.map(row => <tr key={row[0]}>
                      <th scope="row" className="border-b border-zinc-200 p-2 align-top font-semibold dark:border-zinc-800">{row[0]}</th>
                      {row.slice(1).map((cell, index) => <td key={index} className="border-b border-zinc-200 p-2 align-top dark:border-zinc-800">{cell}</td>)}
                    </tr>)}</tbody>
                  </table> : null}
                  {section.guestTrialLinks ? (
                    <div data-testid="faq-guest-trial-links" className="mt-5 space-y-3 text-sm leading-6">
                      <p>{guestTrialAvailable ? section.guestTrialLinks.available : section.guestTrialLinks.unavailable}</p>
                      <div className="flex flex-wrap gap-3">
                        {guestTrialAvailable ? <Link href={marketingProductEntryHref("chat", lang)} className="inline-flex min-h-11 items-center font-bold text-blue-700 underline underline-offset-4 dark:text-blue-300">{section.guestTrialLinks.chat}</Link> : null}
                        <Link href={reviewHref} className="inline-flex min-h-11 items-center font-bold text-blue-700 underline underline-offset-4 dark:text-blue-300">{section.guestTrialLinks.review}</Link>
                        <Link href={localizedPath(lang, "/models")} className="inline-flex min-h-11 items-center font-bold text-blue-700 underline underline-offset-4 dark:text-blue-300">{section.guestTrialLinks.models}</Link>
                      </div>
                    </div>
                  ) : null}
                  {section.formatGroups && <div className="mt-5" data-testid="attachment-format-groups">
                    <ul className="hidden gap-3 text-sm leading-6 text-zinc-700 sm:grid dark:text-zinc-200">
                      {section.formatGroups.map(group => <li key={group.label}><strong>{group.label}:</strong> {group.extensions.join(", ")}</li>)}
                    </ul>
                    <div className="grid gap-3 sm:hidden">
                      {section.formatGroups.map(group => <details key={group.label} data-testid="attachment-format-details" className="min-w-0 rounded-lg border border-zinc-200 p-3 text-sm leading-6 [overflow-wrap:anywhere] dark:border-zinc-700">
                        <summary className="min-h-11 cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600">
                          <span className="font-bold">{group.label}</span>
                          <span className="block">{group.extensions.slice(0, 3).join(", ")}{group.extensions.length > 3 ? ` · +${group.extensions.length - 3}` : ""}</span>
                          <span className="block font-semibold text-blue-700 dark:text-blue-300">See all formats</span>
                        </summary>
                        <p className="mt-2 text-zinc-700 dark:text-zinc-200">{group.extensions.join(", ")}</p>
                      </details>)}
                    </div>
                  </div>}
                  {section.bullets && (
                    <ul className="mt-5 grid gap-3">
                      {section.bullets.map((bullet) => (
                        <li key={bullet} className="flex gap-3 text-sm font-semibold leading-6 text-zinc-700 dark:text-zinc-200">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                          {bullet}
                        </li>
                      ))}
                    </ul>
                  )}
                  {links.length > 0 ? <div className="mt-5 flex flex-wrap gap-x-5 gap-y-3">
                    {links.map(link => <Link
                      key={link.href}
                      href={pageHref(link.href)}
                      target={link.external ? "_blank" : undefined}
                      rel={link.external ? "noopener noreferrer" : undefined}
                      className="inline-flex items-center gap-2 text-sm font-bold text-blue-600 hover:text-blue-500 dark:text-blue-300"
                    >
                      {link.label}
                      <ArrowRight className="h-4 w-4" />
                    </Link>)}
                  </div> : null}
                  </div>
                </article>
                );
              })}
            </div>

            {page.cta && (
              <Link
                href={pageHref(page.cta.href)}
                onClick={() =>
                  trackProductEvent("cta_start_click", 0, {
                    cta_location:
                      template === "ai-answer-review"
                        ? "ai_answer_review_page"
                        : "marketing_info_page",
                  })
                }
                className="mt-10 inline-flex h-12 items-center gap-2 rounded-xl bg-blue-600 px-6 text-sm font-bold text-white transition hover:bg-blue-500"
              >
                {page.cta.label}
                <ArrowRight className="h-4 w-4" />
              </Link>
            )}
          </>
        )}
      </section>

      <MarketingFooter maxWidth="max-w-6xl" />
    </main>
  );
}
