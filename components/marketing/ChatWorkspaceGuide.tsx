"use client";

import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ExternalLink,
  FileText,
  Folder,
  HelpCircle,
  Lock,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  Share2,
  Sparkles,
  Tag,
} from "lucide-react";
import { useEffect } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { helpCentreHref } from "@/lib/localizedHelpHref";
import {
  trackProductEvent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import {
  chatWorkspaceGuideContent,
  type WorkspaceGuideSection,
} from "./chatWorkspaceGuideContent";

const tourIcons = [
  MessageSquarePlus,
  Lock,
  Search,
  Share2,
  Tag,
  Folder,
  MoreHorizontal,
] as const;

type HelpTopic =
  | "workspace"
  | "project"
  | "labels"
  | "locked"
  | "shared"
  | "ai_review"
  | "credits";

const topicForSection = (sectionId: string): HelpTopic => {
  if (sectionId === "projects") return "project";
  if (sectionId === "states-and-labels" || sectionId === "labels") {
    return "labels";
  }
  if (sectionId === "lock-and-share") return "locked";
  if (sectionId === "ai-review") return "ai_review";
  if (sectionId === "credits-and-plans") return "credits";
  return "workspace";
};

function GuideSection({ section }: { section: WorkspaceGuideSection }) {
  return (
    <section
      id={section.id}
      className="scroll-mt-24 rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-7 dark:border-zinc-800 dark:bg-zinc-900/45"
    >
      <h2 className="text-2xl font-black tracking-tight">{section.title}</h2>
      <p className="mt-3 max-w-4xl text-sm leading-7 text-zinc-600 sm:text-base dark:text-zinc-300">
        {section.description}
      </p>
      <dl className="mt-6 grid gap-3 lg:grid-cols-2">
        {section.items.map((item) => (
          <div
            key={`${section.id}-${item.term}`}
            className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/70"
          >
            <dt className="text-sm font-black text-zinc-950 dark:text-white">
              {item.term}
            </dt>
            <dd className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              {item.detail}
            </dd>
          </div>
        ))}
      </dl>
      {section.note ? (
        <p className="mt-5 rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm font-semibold leading-6 text-blue-950 dark:border-blue-900/70 dark:bg-blue-950/30 dark:text-blue-100">
          {section.note}
        </p>
      ) : null}
    </section>
  );
}

export function ChatWorkspaceGuide() {
  const { lang } = useLanguage();
  const copy = chatWorkspaceGuideContent[lang];

  useEffect(() => {
    trackProductEventOnce(
      "help_article_viewed:chat_workspace",
      "help_article_viewed",
      0,
      {
        help_source: "help_centre",
        help_topic: "workspace",
        help_article_id: "chat_workspace",
      }
    );
  }, []);

  const trackTopic = (topic: HelpTopic) => {
    trackProductEvent("help_opened", 0, {
      help_source: "workspace_guide",
      help_topic: topic,
    });
  };

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-7xl" />

      <article lang={lang} className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-16">
        <Link
          href={helpCentreHref(lang)}
          className="inline-flex items-center gap-2 text-sm font-black text-blue-600 hover:text-blue-500 dark:text-blue-300"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {copy.allHelp}
        </Link>

        <header className="mt-8 max-w-4xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-black uppercase tracking-[0.16em] text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
            <HelpCircle className="h-4 w-4" aria-hidden="true" />
            {copy.eyebrow}
          </div>
          <h1 className="mt-5 text-4xl font-black leading-tight tracking-tight sm:text-6xl">
            {copy.title}
          </h1>
          <p className="mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-300">
            {copy.description}
          </p>
          <p className="mt-4 text-sm font-semibold text-zinc-500 dark:text-zinc-400">
            {copy.updated}
          </p>
        </header>

        <nav
          aria-label={copy.contents}
          className="mt-10 rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/45"
        >
          <p className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">
            {copy.contents}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href="#workspace-tour"
              onClick={() => trackTopic("workspace")}
              className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-bold hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:border-blue-600 dark:hover:text-blue-300"
            >
              {copy.tourTitle}
            </a>
            {copy.sections.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                onClick={() => trackTopic(topicForSection(section.id))}
                className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-bold hover:border-blue-400 hover:text-blue-600 dark:border-zinc-700 dark:bg-zinc-950 dark:hover:border-blue-600 dark:hover:text-blue-300"
              >
                {section.title}
              </a>
            ))}
          </div>
        </nav>

        <section id="workspace-tour" className="mt-8 scroll-mt-24">
          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-3xl border border-zinc-800 bg-zinc-950 p-5 text-white shadow-xl sm:p-7">
              <div className="flex items-center gap-3 border-b border-zinc-800 pb-5">
                <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/tomverse-logo.png" alt="" className="h-full w-full object-cover" />
                </span>
                <span className="font-black">Tomverse AI</span>
                <HelpCircle className="ml-auto h-5 w-5 text-blue-300" aria-hidden="true" />
              </div>
              <div className="mt-5 grid gap-3">
                {copy.tourItems.map((item, index) => {
                  const Icon = tourIcons[index] ?? Bot;
                  return (
                    <a
                      key={item.term}
                      href={`#tour-${index + 1}`}
                      onClick={() => trackTopic(index === 5 ? "project" : index === 4 ? "labels" : "workspace")}
                      className="group flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 transition hover:border-blue-500 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-black">
                        {index + 1}
                      </span>
                      <Icon className="h-4 w-4 shrink-0 text-zinc-400 group-hover:text-blue-300" aria-hidden="true" />
                      <span className="text-sm font-bold">{item.term}</span>
                      <ArrowRight className="ml-auto h-4 w-4 text-zinc-500 group-hover:text-blue-300" aria-hidden="true" />
                    </a>
                  );
                })}
              </div>
            </div>

            <div className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-7 dark:border-zinc-800 dark:bg-zinc-900/45">
              <h2 className="text-2xl font-black tracking-tight">{copy.tourTitle}</h2>
              <p className="mt-3 text-sm leading-7 text-zinc-600 sm:text-base dark:text-zinc-300">
                {copy.tourDescription}
              </p>
              <dl className="mt-6 grid gap-3">
                {copy.tourItems.map((item, index) => (
                  <div
                    key={item.term}
                    id={`tour-${index + 1}`}
                    className="scroll-mt-24 rounded-2xl bg-zinc-50 p-4 dark:bg-zinc-950/70"
                  >
                    <dt className="flex items-center gap-2 text-sm font-black">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-[11px] text-white">
                        {index + 1}
                      </span>
                      {item.term}
                    </dt>
                    <dd className="mt-2 pl-8 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                      {item.detail}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        <div className="mt-8 grid gap-6">
          {copy.sections.map((section) => (
            <div key={section.id}>
              {section.id === "ai-review" ? (
                <div className="mb-6 overflow-hidden rounded-3xl border border-blue-200 bg-blue-50 p-5 sm:p-7 dark:border-blue-900/70 dark:bg-blue-950/20">
                  <div className="flex items-center gap-2 text-blue-700 dark:text-blue-300">
                    <Sparkles className="h-5 w-5" aria-hidden="true" />
                    <h3 className="font-black">{copy.reviewVideoTitle}</h3>
                  </div>
                  <video
                    className="mt-5 aspect-video w-full rounded-2xl border border-zinc-200 bg-zinc-950 object-cover shadow-lg dark:border-zinc-800"
                    controls
                    preload="metadata"
                    poster="/marketing-proof/tomverse-review-workflow-poster.png"
                  >
                    <source src="/marketing-proof/tomverse-review-workflow.webm" type="video/webm" />
                  </video>
                  <p className="mt-3 flex items-start gap-2 text-xs font-semibold leading-5 text-blue-900 dark:text-blue-100">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    {copy.reviewVideoCaption}
                  </p>
                </div>
              ) : null}
              <GuideSection section={section} />
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-3 rounded-3xl bg-zinc-950 p-6 text-white sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div className="flex items-center gap-3">
            <Sparkles className="h-6 w-6 text-blue-300" aria-hidden="true" />
            <span className="text-lg font-black">Tomverse AI</span>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href={helpCentreHref(lang)}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-zinc-700 px-4 text-sm font-black hover:bg-zinc-900"
            >
              {copy.allHelp}
            </Link>
            <Link
              href={`/chat?lang=${encodeURIComponent(lang)}`}
              onClick={() =>
                trackProductEvent("cta_start_click", 0, {
                  cta_location: "chat_workspace_guide",
                })
              }
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black hover:bg-blue-500"
            >
              {copy.openChat}
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </article>

      <MarketingFooter />
    </main>
  );
}
