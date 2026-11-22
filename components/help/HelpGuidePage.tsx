"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, Sparkles } from "lucide-react";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/MarketingChrome";
import { HELP_CATEGORIES, guidesInCategory, helpGuideMeta } from "@/lib/helpCentre/catalog";
import { helpActionHref, helpGuideHref, helpHubHref } from "@/lib/helpCentre/links";
import { HELP_ATTACHMENT_FORMAT_GUIDES, helpAttachmentFormats } from "@/lib/helpCentre/attachmentFormats";
import shotHotspots from "@/lib/helpCentre/shots.json";
import type { HelpHotspot, HelpLocaleCopy } from "@/lib/helpCentre/types";
import type { Language } from "@/lib/language";
import { HelpConversation, useHelpAssistantAvailability, useHelpConversation } from "./HelpAssistant";
import { helpGuideSummaries } from "./HelpCentreHub";

/** Screenshots exist for these languages; the rest use the English ones. */
const SHOT_LANGUAGES: ReadonlySet<Language> = new Set(["ko", "en"]);
/** Measured by scripts/capture-help-centre-shots.mjs from the live element. */
const SHOT_HOTSPOTS = new Map(Object.entries(shotHotspots as Record<string, HelpHotspot>));

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

/** Supported formats from CHAT_ATTACHMENT_FORMATS, never from guide copy. */
function AttachmentFormatList({ ui }: { ui: HelpLocaleCopy["ui"] }) {
  const formats = helpAttachmentFormats();
  return (
    <section className="mt-8 rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800" aria-labelledby="help-attachment-formats" data-testid="help-attachment-formats">
      <h2 id="help-attachment-formats" className="text-lg font-black">{ui.formatsTitle}</h2>
      <dl className="mt-3 space-y-2 text-sm leading-6">
        {formats.groups.map((entry) => (
          <div key={entry.group} className="sm:flex sm:gap-3">
            <dt className="shrink-0 font-semibold sm:w-56">{ui.formatGroups[entry.group]}</dt>
            <dd className="text-zinc-600 [overflow-wrap:anywhere] dark:text-zinc-400">{entry.entries.join(", ")}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {fill(ui.formatsSignedInLimits, { files: formats.signedInFiles, mb: formats.signedInMegabytes, total: formats.signedInTotalMegabytes })}{" "}
        {fill(ui.formatsGuestLimits, { files: formats.guestFiles, mb: formats.guestMegabytes })}
        {formats.signedInOnly.length > 0
          ? ` ${fill(ui.formatsSignedInOnly, { list: formats.signedInOnly.join(", ") })}`
          : null}
      </p>
    </section>
  );
}

export function HelpGuidePage({ lang, copy, guideId }: { lang: Language; copy: HelpLocaleCopy; guideId: string }) {
  const router = useRouter();
  const ui = copy.ui;
  const meta = helpGuideMeta(guideId)!;
  const words = copy.guides[guideId];
  const category = HELP_CATEGORIES.find((entry) => entry.id === meta.category)!;
  const siblings = guidesInCategory(meta.category);
  const guides = useMemo(() => helpGuideSummaries(copy), [copy]);
  const [active, setActive] = useState(0);
  const availability = useHelpAssistantAvailability();
  const conversation = useHelpConversation(lang, guideId);
  const [question, setQuestion] = useState("");
  const canAsk = availability?.enabled === true && availability.signedIn;

  useEffect(() => {
    const fromHash = () => {
      const match = /^#step-(\d+)$/.exec(window.location.hash);
      const index = match ? Number(match[1]) - 1 : -1;
      if (index >= 0 && index < words.steps.length) setActive(index);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [words.steps.length]);

  const go = (index: number) => {
    setActive(index);
    // Let the router commit the hash before the new URL becomes visible.
    router.replace(`#step-${index + 1}`, { scroll: false });
  };
  const ask = (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim()) return;
    void conversation.ask(question);
    setQuestion("");
  };
  const shotLang = SHOT_LANGUAGES.has(lang) ? lang : "en";
  const stepMeta = meta.steps[active];
  const hotspot = stepMeta?.hotspot ?? (stepMeta?.shot ? SHOT_HOTSPOTS.get(stepMeta.shot) : undefined);
  const next = siblings[siblings.findIndex((entry) => entry.id === guideId) + 1];

  return (
    <main className="min-h-screen bg-white text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader maxWidth="max-w-7xl" />
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[240px_minmax(0,1fr)_300px] lg:py-10">
        <nav aria-label={ui.byFeature} className="order-3 lg:order-1">
          <Link href={helpHubHref(lang)} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-blue-600 dark:text-blue-400">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {ui.backToHelp}
          </Link>
          <p className="mt-4 text-xs font-bold tracking-wide text-zinc-500">{ui.byFeature}</p>
          <ul className="mt-2 space-y-0.5">
            {HELP_CATEGORIES.map((entry) => (
              <li key={entry.id}>
                {entry.id === meta.category ? (
                  <>
                    <span className="flex min-h-10 items-center gap-2.5 rounded-xl bg-zinc-100 px-3 text-sm font-semibold dark:bg-zinc-900">
                      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${entry.dot}`} />
                      {copy.categories[entry.id].title}
                    </span>
                    <ul className="my-1">
                      {siblings.map((sibling) => (
                        <li key={sibling.id}>
                          <Link
                            href={helpGuideHref(lang, sibling.id)}
                            aria-current={sibling.id === guideId ? "page" : undefined}
                            className={`flex min-h-9 items-center pl-8 pr-2 text-sm ${sibling.id === guideId ? "font-bold text-blue-600 dark:text-blue-300" : "text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"}`}
                          >
                            {copy.guides[sibling.id].title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <Link href={`${helpHubHref(lang)}#category-${entry.id}`} className="flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-sm text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-900">
                    <span aria-hidden="true" className={`h-2 w-2 rounded-full ${entry.dot}`} />
                    {copy.categories[entry.id].title}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <article className="order-1 min-w-0 lg:order-2" data-testid="help-guide">
          <p className="text-sm text-zinc-500">
            <Link href={helpHubHref(lang)} className="hover:underline">{ui.breadcrumbHome}</Link>
            <span aria-hidden="true"> › </span>
            {copy.categories[meta.category].title}
          </p>
          <h1 className="mt-2 break-keep text-3xl font-black tracking-tight sm:text-4xl">{words.title}</h1>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-zinc-200 px-3 py-1 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">{fill(ui.stepsAndMinutes, { steps: words.steps.length, minutes: meta.minutes })}</span>
            <span className="rounded-full border border-zinc-200 px-3 py-1 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">{meta.requiresSignIn ? ui.signInRequired : ui.signInNotRequired}</span>
            <span className="rounded-full border border-zinc-200 px-3 py-1 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">{ui.planLabel}: {meta.plan === "paid" ? ui.paidPlans : ui.allPlans}</span>
          </div>
          <p className="mt-4 max-w-3xl break-keep text-base leading-7 text-zinc-600 dark:text-zinc-300">{words.summary}</p>

          <h2 className="sr-only">{ui.stepsSection}</h2>
          <ol className="mt-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]" data-testid="help-guide-steps">
            {words.steps.map((step, index) => (
              <li key={index}>
                <button
                  type="button"
                  onClick={() => go(index)}
                  aria-current={index === active ? "step" : undefined}
                  className={`flex min-h-14 w-full flex-col justify-center rounded-xl border px-3 py-2 text-left text-sm ${index === active ? "border-blue-500 bg-blue-50 dark:bg-blue-500/10" : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"}`}
                >
                  <span className={`flex items-center gap-1 text-[11px] font-bold ${index < active ? "text-emerald-600 dark:text-emerald-400" : index === active ? "text-blue-600 dark:text-blue-300" : "text-zinc-500"}`}>
                    {index < active ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                    {fill(ui.stepLabel, { n: index + 1 })}
                  </span>
                  <span className="mt-0.5 font-medium">{step.title}</span>
                </button>
              </li>
            ))}
          </ol>

          {words.steps.map((step, index) => (
            <section key={index} id={`step-${index + 1}`} hidden={index !== active} aria-label={step.title} className="scroll-mt-24">
              {stepMeta?.shot && index === active ? (
                <div className="relative mt-4 overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800">
                  <a href={`/help/shots/${shotLang}/${stepMeta.shot}.webp`} target="_blank" rel="noopener" className="block">
                    {/* eslint-disable-next-line @next/next/no-img-element -- static capture, sized by the box */}
                    <img src={`/help/shots/${shotLang}/${stepMeta.shot}.webp`} alt={step.title} className="block w-full" loading="lazy" />
                  </a>
                  {hotspot ? (
                    <span
                      aria-hidden="true"
                      className="absolute rounded-xl border-2 border-blue-500 bg-blue-500/10"
                      style={{ left: `${hotspot.x}%`, top: `${hotspot.y}%`, width: `${hotspot.w}%`, height: `${hotspot.h}%` }}
                    >
                      <span className="absolute -left-3 -top-3 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-blue-600 text-xs font-bold text-white">{index + 1}</span>
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-5 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 dark:border-zinc-800 dark:bg-zinc-900/50">
                <p className="text-xs font-bold text-blue-600 dark:text-blue-300">{fill(ui.stepLabel, { n: index + 1 })} / {words.steps.length}</p>
                <h3 className="mt-1 text-lg font-bold">{step.title}</h3>
                <p className="mt-2 break-keep text-[15px] leading-7 text-zinc-700 dark:text-zinc-300">{step.body}</p>
              </div>
            </section>
          ))}
          <div className="mt-4 flex items-center justify-between gap-3">
            <button type="button" onClick={() => go(Math.max(0, active - 1))} disabled={active === 0} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-zinc-300 px-4 text-sm font-semibold disabled:opacity-40 dark:border-zinc-700">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {ui.previous}
            </button>
            <span className="text-sm text-zinc-500">{active + 1} / {words.steps.length}</span>
            {active < words.steps.length - 1 ? (
              <button type="button" onClick={() => go(active + 1)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-blue-600 px-5 text-sm font-bold text-white hover:bg-blue-500">
                {ui.next}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : next ? (
              <Link href={helpGuideHref(lang, next.id)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-blue-600 px-5 text-sm font-bold text-white hover:bg-blue-500">
                {copy.guides[next.id].title}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            ) : (
              <span />
            )}
          </div>

          {HELP_ATTACHMENT_FORMAT_GUIDES.has(guideId) ? <AttachmentFormatList ui={ui} /> : null}

          {words.faq.length > 0 ? (
            <section className="mt-10" aria-labelledby="help-guide-faq">
              <h2 id="help-guide-faq" className="text-xl font-black">{ui.faqTitle}</h2>
              <div className="mt-3 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                {words.faq.map((item) => (
                  <details key={item.q} className="group">
                    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-3 text-[15px] font-medium [&::-webkit-details-marker]:hidden">
                      {item.q}
                      <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400 group-open:rotate-180" aria-hidden="true" />
                    </summary>
                    <p className="pb-4 text-[15px] leading-7 text-zinc-600 dark:text-zinc-400">{item.a}</p>
                  </details>
                ))}
              </div>
            </section>
          ) : null}
        </article>

        <aside className="order-2 space-y-4 lg:order-3">
          {availability?.enabled ? (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60" data-testid="help-guide-ask">
              <p className="flex items-center gap-2 text-sm font-bold">
                <Sparkles className="h-4 w-4 text-blue-500" aria-hidden="true" />
                {ui.stuckTitle}
              </p>
              <p className="mt-1.5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{canAsk ? ui.stuckBody : ui.askSignIn}</p>
              {canAsk ? (
                conversation.exchanges.length === 0 ? (
                  <form onSubmit={ask} className="mt-3 flex gap-2">
                    <label htmlFor="help-guide-question" className="sr-only">{ui.stuckPlaceholder}</label>
                    <input
                      id="help-guide-question"
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      placeholder={ui.stuckPlaceholder}
                      maxLength={2000}
                      className="min-h-11 min-w-0 flex-1 rounded-xl border border-zinc-200 bg-transparent px-3 text-sm outline-none focus:border-blue-500 dark:border-zinc-700"
                    />
                    <button type="submit" disabled={!question.trim() || conversation.pending} className="min-h-11 rounded-xl bg-blue-600 px-3 text-sm font-bold text-white disabled:opacity-40">
                      {ui.askButton}
                    </button>
                  </form>
                ) : (
                  <HelpConversation lang={lang} ui={ui} guides={guides} conversation={conversation} compact />
                )
              ) : (
                <Link href={`/auth/signin?callbackUrl=${encodeURIComponent(helpGuideHref(lang, guideId))}`} className="mt-3 inline-flex min-h-11 items-center rounded-full bg-blue-600 px-4 text-sm font-bold text-white">
                  {ui.askSignInButton}
                </Link>
              )}
            </div>
          ) : null}
          {meta.action ? (
            <div className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
              <p className="text-sm font-bold">{ui.tryItTitle}</p>
              <p className="mt-1.5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{ui.tryItBody}</p>
              <a href={helpActionHref(meta.action, lang)} target="_blank" rel="noopener" className="mt-3 flex min-h-11 items-center justify-center gap-2 rounded-full bg-blue-600 text-sm font-bold text-white hover:bg-blue-500">
                {ui.tryItButton}
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          ) : null}
          <div className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800">
            <p className="flex items-center gap-2 text-sm font-bold">
              <span aria-hidden="true" className={`h-2 w-2 rounded-full ${category.dot}`} />
              {ui.relatedGuides}
            </p>
            <ul className="mt-2">
              {siblings.filter((sibling) => sibling.id !== guideId).map((sibling) => (
                <li key={sibling.id} className="border-t border-zinc-100 first:border-t-0 dark:border-zinc-800">
                  <Link href={helpGuideHref(lang, sibling.id)} className="flex min-h-11 items-center justify-between gap-2 text-sm text-zinc-700 hover:text-blue-600 dark:text-zinc-300 dark:hover:text-blue-400">
                    {copy.guides[sibling.id].title}
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
      <MarketingFooter maxWidth="max-w-7xl" />
    </main>
  );
}
