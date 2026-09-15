"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  FileArchive,
  FileText,
  LockKeyhole,
  MessageSquare,
  MousePointerClick,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import {
  MarketingFooter,
  MarketingHeader,
} from "@/components/marketing/MarketingChrome";
import {
  assistantKnowledgeCreateHref,
  assistantKnowledgeGuideCaptionLabel,
  assistantKnowledgeGuideCaptionPath,
  assistantKnowledgeGuideContentLanguage,
  ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH,
  assistantKnowledgeGuideVideoPath,
  assistantKnowledgeSignInHref,
} from "@/lib/assistantKnowledgeGuide";
import type { AssistantKnowledgeSupademoEmbeds } from "@/lib/assistantKnowledgeSupademoCore";
import {
  trackProductEvent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import { assistantKnowledgeGuideContent } from "./assistantKnowledgeGuideContent";

const stepIcons = [Bot, FileText, MessageSquare] as const;

export function AssistantKnowledgeGuide({
  packageImportAvailable,
  supademoEmbeds,
}: {
  packageImportAvailable: boolean;
  supademoEmbeds: AssistantKnowledgeSupademoEmbeds;
}) {
  const { lang } = useLanguage();
  const { status } = useSession();
  const contentLanguage = assistantKnowledgeGuideContentLanguage(lang);
  const copy = assistantKnowledgeGuideContent[contentLanguage];
  const [demoSelection, setDemoSelection] = useState({
    contentLanguage,
    step: 0,
  });
  const demoStep =
    demoSelection.contentLanguage === contentLanguage
      ? demoSelection.step
      : 0;
  const selected = copy.steps[demoStep];
  const Icon = stepIcons[demoStep];
  const authenticated = status === "authenticated";
  const ctaHref = authenticated
    ? assistantKnowledgeCreateHref(lang)
    : assistantKnowledgeSignInHref(lang);
  const videoPath = assistantKnowledgeGuideVideoPath(lang);
  const captionPath = assistantKnowledgeGuideCaptionPath(lang);
  const supademoUrl = supademoEmbeds[contentLanguage];

  useEffect(() => {
    trackProductEventOnce(
      "assistant_knowledge_guide_viewed",
      "assistant_knowledge_guide_viewed"
    );
  }, []);

  const moveDemo = (nextStep: number) => {
    const bounded = Math.max(0, Math.min(copy.steps.length - 1, nextStep));
    setDemoSelection({ contentLanguage, step: bounded });
    trackProductEvent("assistant_knowledge_guide_step_opened", 0, {
      assistant_knowledge_guide_step: copy.steps[bounded].id,
    });
  };

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader
        maxWidth="max-w-6xl"
        localizedContentAvailable={
          lang === "ko" || lang === "en" || lang === "zh"
        }
      />

      <article
        lang={contentLanguage}
        className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8 lg:py-16"
      >
        <header className="grid items-end gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="max-w-4xl">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-700 dark:text-teal-300">
              {copy.eyebrow}
            </p>
            <h1 className="mt-4 text-4xl font-black tracking-[-0.04em] sm:text-6xl">
              {copy.title}
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-8 text-zinc-600 sm:text-lg dark:text-zinc-300">
              {copy.description}
            </p>
          </div>
          <aside className="rounded-3xl border border-teal-200 bg-teal-50 p-5 dark:border-teal-900 dark:bg-teal-950/25">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-300">
              {copy.outcomeLabel}
            </p>
            <h2 className="mt-2 text-lg font-black">{copy.outcomeTitle}</h2>
            <ul className="mt-4 space-y-3">
              {copy.outcomeItems.map((item) => (
                <li key={item} className="flex gap-2 text-sm leading-6">
                  <Check
                    className="mt-1 h-4 w-4 shrink-0 text-teal-700 dark:text-teal-300"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </aside>
        </header>

        <section className="mt-10 overflow-hidden rounded-[2rem] border border-zinc-200 bg-zinc-950 shadow-2xl shadow-zinc-950/10 dark:border-zinc-800">
          <div className="relative aspect-video w-full overflow-hidden">
            <video
              key={videoPath}
              className="h-full w-full object-contain"
              controls
              playsInline
              preload="metadata"
              poster={ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH}
            >
              <source src={videoPath} type="video/mp4" />
              <track
                default
                kind="captions"
                src={captionPath}
                srcLang={contentLanguage}
                label={assistantKnowledgeGuideCaptionLabel(lang)}
              />
            </video>
          </div>
          <div className="border-t border-white/10 px-5 py-4 text-white sm:flex sm:items-center sm:justify-between sm:gap-5 sm:px-7">
            <p className="text-sm font-bold">{copy.videoLabel}</p>
            <p className="mt-1 text-sm text-zinc-400 sm:mt-0">
              {copy.videoHint}
            </p>
          </div>
        </section>

        <section aria-labelledby="interactive-demo-heading" className="mt-16">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
            {copy.demoEyebrow}
          </p>
          <h2 id="interactive-demo-heading" className="mt-2 text-3xl font-black">
            {copy.demoTitle}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-600 dark:text-zinc-300">
            {copy.demoDescription}
          </p>

          {supademoUrl ? (
            <div className="mt-6 overflow-hidden rounded-[2rem] border border-zinc-200 bg-white shadow-xl shadow-zinc-950/5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex items-center gap-2 border-b border-zinc-200 px-5 py-3 text-sm font-bold dark:border-zinc-800">
                <MousePointerClick
                  className="h-4 w-4 text-teal-700 dark:text-teal-300"
                  aria-hidden="true"
                />
                {copy.supademoLabel}
              </div>
              <iframe
                title={copy.supademoLabel}
                src={supademoUrl}
                loading="lazy"
                allow="clipboard-write; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                sandbox="allow-forms allow-popups allow-presentation allow-same-origin allow-scripts"
                className="aspect-video w-full bg-zinc-100"
              />
            </div>
          ) : null}

            <div
              className="mt-6 overflow-hidden rounded-[2rem] border border-zinc-200 bg-white shadow-xl shadow-zinc-950/5 dark:border-zinc-800 dark:bg-zinc-900"
              data-testid="assistant-knowledge-native-demo"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
                <div className="flex items-center gap-2 text-sm font-bold">
                  <MousePointerClick
                    className="h-4 w-4 text-teal-700 dark:text-teal-300"
                    aria-hidden="true"
                  />
                  {copy.nativeDemoLabel}
                </div>
                <p className="text-xs font-bold text-zinc-500">
                  {copy.stepProgress(demoStep + 1, copy.steps.length)}
                </p>
              </div>

              <div className="grid min-h-[420px] lg:grid-cols-[260px_minmax(0,1fr)]">
                <ol className="border-b border-zinc-200 p-4 lg:border-r lg:border-b-0 dark:border-zinc-800">
                  {copy.steps.map((step, index) => {
                    const StepIcon = stepIcons[index];
                    const active = demoStep === index;
                    return (
                      <li key={step.id}>
                        <button
                          type="button"
                          aria-current={active ? "step" : undefined}
                          onClick={() => moveDemo(index)}
                          className={`my-1 flex w-full items-center gap-3 rounded-2xl p-3 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
                            active
                              ? "bg-teal-50 font-bold text-teal-950 dark:bg-teal-950/40 dark:text-teal-100"
                              : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          }`}
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-current/20">
                            <StepIcon className="h-4 w-4" aria-hidden="true" />
                          </span>
                          <span>{step.title}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>

                <div className="flex flex-col justify-between p-5 sm:p-8">
                  <div aria-live="polite">
                    <div className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
                      <Icon
                        className="h-4 w-4 text-teal-700 dark:text-teal-300"
                        aria-hidden="true"
                      />
                      {selected.label}
                    </div>
                    <div className="mt-5 rounded-3xl border border-zinc-200 bg-zinc-50 p-5 sm:p-7 dark:border-zinc-700 dark:bg-zinc-950">
                      <p className="text-xs font-bold text-zinc-500">
                        {selected.screenTitle}
                      </p>
                      <h3 className="mt-3 text-xl font-black">{selected.title}</h3>
                      <p className="mt-2 max-w-2xl text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                        {selected.screenHint}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          demoStep === copy.steps.length - 1
                            ? moveDemo(0)
                            : moveDemo(demoStep + 1)
                        }
                        className="mt-7 inline-flex min-h-12 items-center gap-2 rounded-2xl bg-teal-700 px-5 text-sm font-bold text-white shadow-lg shadow-teal-950/15 transition hover:bg-teal-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950"
                      >
                        <MousePointerClick className="h-4 w-4" aria-hidden="true" />
                        {selected.targetLabel}
                      </button>
                      <p className="mt-4 flex gap-2 text-sm leading-6 text-teal-900 dark:text-teal-100">
                        <Check className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
                        {selected.result}
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      disabled={demoStep === 0}
                      onClick={() => moveDemo(demoStep - 1)}
                      className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-zinc-300 px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700"
                    >
                      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                      {copy.demoPrevious}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        demoStep === copy.steps.length - 1
                          ? moveDemo(0)
                          : moveDemo(demoStep + 1)
                      }
                      className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-teal-300 px-4 text-sm font-bold text-teal-900 dark:border-teal-800 dark:text-teal-100"
                    >
                      {demoStep === copy.steps.length - 1 ? (
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      ) : null}
                      {demoStep === copy.steps.length - 1
                        ? copy.demoRestart
                        : copy.demoNext}
                      {demoStep < copy.steps.length - 1 ? (
                        <ArrowRight className="h-4 w-4" aria-hidden="true" />
                      ) : null}
                    </button>
                  </div>
                </div>
              </div>
              <p className="border-t border-zinc-200 px-5 py-4 text-xs leading-5 text-zinc-500 dark:border-zinc-800">
                {copy.nativeDemoNote}
              </p>
            </div>
        </section>

        <section aria-labelledby="choose-path-heading" className="mt-16">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
            {copy.choosePathEyebrow}
          </p>
          <h2 id="choose-path-heading" className="mt-2 text-3xl font-black">
            {copy.choosePathTitle}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-600 dark:text-zinc-300">
            {copy.choosePathDescription}
          </p>

          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            {[copy.createPath, copy.importPath].map((path, index) => (
              <article
                key={path.label}
                className="rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/60"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200">
                    {index === 0 ? (
                      <Bot className="h-5 w-5" aria-hidden="true" />
                    ) : (
                      <FileArchive className="h-5 w-5" aria-hidden="true" />
                    )}
                  </span>
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                      {path.label}
                    </p>
                    <h3 className="mt-1 text-lg font-black">{path.title}</h3>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                  {path.body}
                </p>
                <ol className="mt-5 space-y-3">
                  {path.steps.map((step, stepIndex) => (
                    <li key={step} className="flex gap-3 text-sm leading-6">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-[11px] font-bold text-white dark:bg-white dark:text-zinc-950">
                        {stepIndex + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>

          <div
            className={`mt-5 rounded-3xl border p-5 ${
              packageImportAvailable
                ? "border-teal-200 bg-teal-50 dark:border-teal-900 dark:bg-teal-950/25"
                : "border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
            }`}
          >
            <p className="font-bold">
              {packageImportAvailable
                ? copy.importAvailableLabel
                : copy.importUnavailableLabel}
            </p>
            <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              {packageImportAvailable
                ? copy.importAvailableBody
                : copy.importUnavailableBody}
            </p>
            <p className="mt-3 text-xs leading-6 text-zinc-500">
              {copy.importBoundary}
            </p>
          </div>
        </section>

        <section aria-labelledby="screen-guide-heading" className="mt-16">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
            {copy.detailsEyebrow}
          </p>
          <h2 id="screen-guide-heading" className="mt-2 text-3xl font-black">
            {copy.detailsTitle}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-600 dark:text-zinc-300">
            {copy.detailsDescription}
          </p>
          <ol className="mt-7 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {copy.detailedSteps.map((step) => (
              <li
                key={step.number}
                className="grid gap-4 py-7 sm:grid-cols-[70px_1fr] lg:grid-cols-[70px_220px_1fr_1fr]"
              >
                <span className="text-sm font-bold text-teal-700 dark:text-teal-300">
                  {step.number}
                </span>
                <h3 className="font-bold">{step.title}</h3>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                    {step.where}
                  </p>
                  <p className="mt-2 text-sm leading-6">{step.action}</p>
                </div>
                <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                  {step.result}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-16 grid gap-5 lg:grid-cols-2">
          <article className="rounded-3xl border border-teal-200 bg-teal-50 p-6 dark:border-teal-900 dark:bg-teal-950/25">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-teal-800 dark:bg-zinc-950 dark:text-teal-200">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-teal-700 dark:text-teal-300">
              {copy.boundariesEyebrow}
            </p>
            <h2 className="mt-2 text-xl font-black">{copy.boundariesTitle}</h2>
            <ul className="mt-5 space-y-3">
              {copy.boundaryItems.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-6">
                  <LockKeyhole
                    className="mt-1 h-4 w-4 shrink-0 text-teal-700 dark:text-teal-300"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </article>

          <article className="rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/60">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
              {copy.helpEyebrow}
            </p>
            <h2 className="mt-2 text-xl font-black">{copy.helpTitle}</h2>
            <div className="mt-5 space-y-5">
              {copy.helpItems.map((item) => (
                <div key={item.title}>
                  <h3 className="text-sm font-bold">{item.title}</h3>
                  <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {item.body}
                  </p>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="mt-12 flex flex-col items-start border-t border-zinc-200 pt-10 dark:border-zinc-800">
          <Link
            href={ctaHref}
            onClick={() =>
              trackProductEvent("cta_start_click", 0, {
                cta_location: "assistant_knowledge_guide",
              })
            }
            className="inline-flex min-h-12 items-center gap-2 rounded-2xl bg-teal-700 px-6 text-sm font-bold text-white transition hover:bg-teal-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950"
          >
            {authenticated ? copy.ctaAuthenticated : copy.ctaGuest}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <p className="mt-3 text-xs leading-5 text-zinc-500">{copy.ctaHint}</p>
        </section>
      </article>

      <MarketingFooter maxWidth="max-w-6xl" />
    </main>
  );
}
