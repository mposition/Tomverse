"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useLanguage, type Language } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";

export type MarketingInfoSection = {
  title: string;
  body: string;
  bullets?: string[];
};

export type MarketingInfoCopy = {
  eyebrow: string;
  title: string;
  description: string;
  updated?: string;
  sections: MarketingInfoSection[];
  cta?: {
    label: string;
    href: string;
  };
};

export function MarketingInfoPage({
  content,
}: {
  content: { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>;
}) {
  const { lang } = useLanguage();
  const page = content[lang] ?? content.en;

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-6xl" />

      <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-20">
        <div className="max-w-3xl">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-400">{page.eyebrow}</p>
          <h1 className="mt-4 text-4xl font-black leading-tight sm:text-6xl">{page.title}</h1>
          <p className="mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-300">{page.description}</p>
          {page.updated && <p className="mt-4 text-sm font-semibold text-zinc-500 dark:text-zinc-400">{page.updated}</p>}
        </div>

        <div className="mt-12 grid gap-5">
          {page.sections.map((section) => (
            <article key={section.title} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-900/40">
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
            </article>
          ))}
        </div>

        {page.cta && (
          <Link
            href={page.cta.href}
            className="mt-10 inline-flex h-12 items-center gap-2 rounded-xl bg-blue-600 px-6 text-sm font-black text-white transition hover:bg-blue-500"
          >
            {page.cta.label}
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
      </section>

      <MarketingFooter maxWidth="max-w-6xl" />
    </main>
  );
}
