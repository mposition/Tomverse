"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { ArrowRight, ArrowUp, Search, Sparkles } from "lucide-react";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/MarketingChrome";
import { HELP_CATEGORIES, HELP_GUIDES, guidesInCategory } from "@/lib/helpCentre/catalog";
import { helpActionHref, helpGuideHref, helpHubHref } from "@/lib/helpCentre/links";
import { searchHelpGuides } from "@/lib/helpCentre/search";
import type { HelpLocaleCopy } from "@/lib/helpCentre/types";
import type { Language } from "@/lib/language";
import {
  HelpConversation,
  useHelpAssistantAvailability,
  useHelpConversation,
  type HelpGuideSummary,
} from "./HelpAssistant";

export function helpGuideSummaries(copy: HelpLocaleCopy): Map<string, HelpGuideSummary> {
  return new Map(
    HELP_GUIDES.map((guide) => [
      guide.id,
      {
        id: guide.id,
        title: copy.guides[guide.id].title,
        categoryTitle: copy.categories[guide.category].title,
        stepTitles: copy.guides[guide.id].steps.map((step) => step.title),
        action: guide.action ?? null,
      },
    ])
  );
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

export function HelpCentreHub({ lang, copy }: { lang: Language; copy: HelpLocaleCopy }) {
  const ui = copy.ui;
  const guides = useMemo(() => helpGuideSummaries(copy), [copy]);
  const availability = useHelpAssistantAvailability();
  const conversation = useHelpConversation(lang, null);
  const [query, setQuery] = useState("");
  const canAsk = availability?.enabled === true && availability.signedIn;
  const matches = useMemo(() => (query.trim() ? searchHelpGuides(copy, query).slice(0, 6) : []), [copy, query]);
  const popular = HELP_GUIDES.filter((guide) => guide.popular !== undefined).sort((a, b) => a.popular! - b.popular!);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canAsk || !query.trim()) return;
    void conversation.ask(query);
    setQuery("");
  };
  const askSuggestion = (text: string) => {
    if (canAsk) void conversation.ask(text);
  };

  return (
    <main data-testid="help-centre-hub" className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-6xl" />

      <section className="relative overflow-hidden px-4 pb-10 pt-14 sm:px-6 sm:pt-20">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(ellipse_at_top,rgba(96,165,250,0.18),transparent_65%)]" />
        <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
          <p className="text-sm font-bold tracking-wide text-blue-600 dark:text-blue-400">{ui.eyebrow}</p>
          <h1 className="mt-3 break-keep text-4xl font-black leading-tight tracking-tight sm:text-6xl">
            {ui.heroTitleLead}{" "}
            <span className="bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-500 bg-clip-text text-transparent dark:from-cyan-400 dark:via-blue-400 dark:to-purple-400">{ui.heroTitleAccent}</span>
          </h1>
          <p className="mt-4 max-w-2xl break-keep text-base leading-7 text-zinc-600 dark:text-zinc-400 sm:text-lg">{ui.heroSubtitle}</p>

          <form onSubmit={submit} className="mt-8 w-full rounded-[22px] bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-400 p-[1.5px]" data-testid="help-ask-form">
            <div className="rounded-[21px] bg-white px-4 pb-3 pt-4 text-left dark:bg-zinc-900 sm:px-5">
              <div className="flex items-end gap-3">
                <label htmlFor="help-question" className="sr-only">{canAsk ? ui.askPlaceholder : ui.searchPlaceholder}</label>
                <textarea
                  id="help-question"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={2}
                  maxLength={2000}
                  placeholder={canAsk ? ui.askPlaceholder : ui.searchPlaceholder}
                  className="min-h-14 flex-1 resize-none bg-transparent text-base leading-7 outline-none placeholder:text-zinc-400 sm:text-[17px]"
                />
                {canAsk ? (
                  <button type="submit" disabled={conversation.pending || !query.trim()} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-2xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500 disabled:opacity-50 sm:px-5">
                    <span className="hidden sm:inline">{ui.askButton}</span>
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : (
                  <Search className="mb-3 h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {availability === null
                    ? ui.askMetaLead
                    : !availability.enabled
                      ? ui.askUnavailable
                      : availability.signedIn
                        ? ui.askMetaLead
                        : ui.askSignIn}
                </span>
                {availability?.enabled && !availability.signedIn ? (
                  <Link href={`/auth/signin?callbackUrl=${encodeURIComponent(helpHubHref(lang))}`} className="inline-flex min-h-8 items-center font-bold text-blue-600 dark:text-blue-400">
                    {ui.askSignInButton}
                  </Link>
                ) : availability?.enabled ? (
                  <span>{ui.askMetaPrivacy}</span>
                ) : null}
              </div>
            </div>
          </form>

          {matches.length > 0 ? (
            <ul className="mt-3 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white text-left dark:border-zinc-800 dark:bg-zinc-900" data-testid="help-search-results">
              {matches.map((id) => {
                const guide = guides.get(id)!;
                return (
                  <li key={id} className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-800">
                    <Link href={helpGuideHref(lang, id)} className="flex min-h-12 items-center justify-between gap-3 px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                      <span>
                        <span className="block text-[15px] font-semibold">{guide.title}</span>
                        <span className="block text-xs text-zinc-500">{guide.categoryTitle}</span>
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : query.trim() && !canAsk ? (
            <p className="mt-3 text-sm text-zinc-500">{ui.searchEmpty}</p>
          ) : null}

          {/* Example questions only where they can be asked: as a search they
              would match nothing, since search needs every word in a guide. */}
          {canAsk && conversation.exchanges.length === 0 ? (
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {ui.suggestions.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => askSuggestion(suggestion)} className="min-h-10 rounded-full border border-zinc-200 bg-zinc-50 px-4 text-sm text-zinc-700 hover:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}

          <div className="w-full">
            <HelpConversation lang={lang} ui={ui} guides={guides} conversation={conversation} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6" aria-labelledby="help-common-tasks">
        <h2 id="help-common-tasks" className="text-2xl font-black tracking-tight">{ui.commonTasks}</h2>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {popular.map((meta) => {
            const words = copy.guides[meta.id];
            const category = HELP_CATEGORIES.find((entry) => entry.id === meta.category)!;
            return (
              <Link key={meta.id} href={helpGuideHref(lang, meta.id)} data-testid="help-common-task" className="group flex gap-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 hover:border-blue-400 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-blue-500">
                <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${category.dot}`} />
                <span className="min-w-0">
                  <span className="block font-bold">{words.title}</span>
                  <span className="mt-1 block text-sm leading-6 text-zinc-600 dark:text-zinc-400">{words.summary}</span>
                  <span className="mt-2 block text-xs text-zinc-500">{fill(ui.stepsAndMinutes, { steps: meta.steps.length, minutes: meta.minutes })}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6" aria-labelledby="help-by-feature">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="help-by-feature" className="text-2xl font-black tracking-tight">{ui.byFeature}</h2>
          <p className="text-sm text-zinc-500">{fill(ui.guideCount, { count: HELP_GUIDES.length })}</p>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {HELP_CATEGORIES.map((category) => {
            const entries = guidesInCategory(category.id);
            return (
              <div key={category.id} id={`category-${category.id}`} data-testid="help-category" className="scroll-mt-24 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${category.dot}`} />
                  <h3 className="font-bold">{copy.categories[category.id].title}</h3>
                  {entries.some((entry) => entry.isNew) ? (
                    <span className="rounded-md bg-cyan-400 px-1.5 py-0.5 text-[11px] font-bold text-zinc-950">{ui.newBadge}</span>
                  ) : null}
                  <span className="ml-auto text-xs text-zinc-500">{entries.length}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{copy.categories[category.id].description}</p>
                <ul className="mt-3 space-y-0.5">
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <Link href={helpGuideHref(lang, entry.id)} className="flex min-h-9 items-center text-sm text-zinc-700 hover:text-blue-600 dark:text-zinc-300 dark:hover:text-blue-400">
                        <span aria-hidden="true" className="mr-1.5 text-zinc-400">›</span>
                        {copy.guides[entry.id].title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-16 pt-6 sm:px-6">
        <div className="flex flex-col gap-5 rounded-3xl border border-zinc-200 bg-gradient-to-r from-cyan-50 to-purple-50 p-6 dark:border-zinc-800 dark:from-cyan-500/10 dark:to-purple-500/10 sm:p-8 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-xl font-black">{ui.contactTitle}</h2>
            <p className="mt-1.5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{ui.contactBody}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={helpActionHref({ kind: "public", path: "/status" }, lang)} className="inline-flex min-h-11 items-center rounded-full border border-zinc-300 bg-white px-4 text-sm font-semibold dark:border-zinc-700 dark:bg-transparent">{ui.statusButton}</Link>
            <Link href={helpGuideHref(lang, "report-a-problem")} className="inline-flex min-h-11 items-center rounded-full border border-zinc-300 bg-white px-4 text-sm font-semibold dark:border-zinc-700 dark:bg-transparent">{ui.reportButton}</Link>
            <Link href={helpActionHref({ kind: "public", path: "/support" }, lang)} className="inline-flex min-h-11 items-center rounded-full bg-blue-600 px-5 text-sm font-bold text-white hover:bg-blue-500">{ui.contactButton}</Link>
          </div>
        </div>
      </section>

      <MarketingFooter maxWidth="max-w-6xl" />
    </main>
  );
}
