"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { ChatGptVsClaudeGuide } from "./ChatGptVsClaudeGuide";
import { AiReviewDemo } from "./AiReviewDemo";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { chatWorkspaceGuideHref } from "@/lib/localizedHelpHref";
import { LOCALIZED_SEO_PATHS, localizedPath } from "@/lib/seo";

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
  bullets?: string[];
  link?: MarketingInfoLink;
  links?: MarketingInfoLink[];
};

export type MarketingInfoCopy = {
  eyebrow: string;
  title: string;
  description: string;
  updated?: string;
  introCtaLabel?: string;
  sectionNavLabel?: string;
  sections: MarketingInfoSection[];
  cta?: {
    label: string;
    href: string;
  };
};

export function MarketingInfoPage({
  content,
  template,
}: {
  content: { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>;
  template?: "chatgpt-vs-claude" | "ai-answer-review";
}) {
  const { lang } = useLanguage();
  const localizedPage = content[lang];
  const page = localizedPage ?? content.en;
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
        className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20"
      >
        <div className="max-w-3xl">
          <p className="text-sm font-bold uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{page.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{page.title}</h1>
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
            <div className="mt-12 grid gap-5">
              {page.sections.map((section) => {
                const links = [...(section.link ? [section.link] : []), ...(section.links ?? [])];
                return (
                <article key={section.title} id={section.id} tabIndex={section.id ? -1 : undefined} lang={section.lang} className="scroll-mt-28 rounded-2xl border border-zinc-200 bg-zinc-50 p-6 focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <h2 className="text-xl font-black">{section.title}</h2>
                  <p className="mt-3 text-sm leading-7 text-zinc-600 dark:text-zinc-300">{section.body}</p>
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
