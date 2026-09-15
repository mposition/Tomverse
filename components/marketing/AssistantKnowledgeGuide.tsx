"use client";

import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ArrowRight, Bot, Check, FileText, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/MarketingChrome";
import {
  assistantKnowledgeCreateHref,
  ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH,
  assistantKnowledgeSignInHref,
  ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH,
  type AssistantKnowledgeGuideStep,
} from "@/lib/assistantKnowledgeGuide";
import {
  trackProductEvent,
  trackProductEventOnce,
} from "@/lib/productAnalyticsClient";
import { assistantKnowledgeGuideContent } from "./assistantKnowledgeGuideContent";

const stepIcons = [Bot, FileText, MessageSquare] as const;

export function AssistantKnowledgeGuide() {
  const { lang } = useLanguage();
  const { status } = useSession();
  const contentLanguage = lang === "ko" ? "ko" : "en";
  const copy = assistantKnowledgeGuideContent[contentLanguage];
  const videoRef = useRef<HTMLVideoElement>(null);
  const [selectedStep, setSelectedStep] = useState<AssistantKnowledgeGuideStep>(
    "create_assistant"
  );
  const selected =
    copy.steps.find((step) => step.id === selectedStep) ?? copy.steps[0];
  const authenticated = status === "authenticated";
  const ctaHref = authenticated
    ? assistantKnowledgeCreateHref(lang)
    : assistantKnowledgeSignInHref(lang);

  useEffect(() => {
    trackProductEventOnce(
      "assistant_knowledge_guide_viewed",
      "assistant_knowledge_guide_viewed"
    );
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const selectLocalizedCaptions = () => {
      for (const track of Array.from(video.textTracks)) {
        track.mode = track.language === contentLanguage ? "showing" : "disabled";
      }
    };

    selectLocalizedCaptions();
    video.addEventListener("loadedmetadata", selectLocalizedCaptions);
    return () => {
      video.removeEventListener("loadedmetadata", selectLocalizedCaptions);
    };
  }, [contentLanguage]);

  const selectStep = (step: AssistantKnowledgeGuideStep) => {
    setSelectedStep(step);
    trackProductEvent("assistant_knowledge_guide_step_opened", 0, {
      assistant_knowledge_guide_step: step,
    });
  };

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-white">
      <MarketingHeader
        maxWidth="max-w-6xl"
        localizedContentAvailable={lang === "ko" || lang === "en"}
      />

      <article
        lang={contentLanguage}
        className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8 lg:py-16"
      >
        <header className="max-w-4xl">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-700 dark:text-teal-300">
            {copy.eyebrow}
          </p>
          <h1 className="mt-4 text-4xl font-black tracking-[-0.04em] sm:text-6xl">
            {copy.title}
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-8 text-zinc-600 sm:text-lg dark:text-zinc-300">
            {copy.description}
          </p>
        </header>

        <section className="mt-10 overflow-hidden rounded-[2rem] border border-zinc-200 bg-zinc-950 shadow-2xl shadow-zinc-950/10 dark:border-zinc-800">
          <div
            className={`relative w-full overflow-hidden ${
              ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH
                ? "aspect-video"
                : "aspect-[1200/630]"
            }`}
          >
            {ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH ? (
              <video
                ref={videoRef}
                className="h-full w-full object-contain"
                controls
                playsInline
                preload="metadata"
                poster={ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH}
              >
                <source
                  src={ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH}
                  type="video/mp4"
                />
                <track
                  default={contentLanguage === "en"}
                  kind="captions"
                  src="/guides/assistant-knowledge/assistant-knowledge.en.vtt"
                  srcLang="en"
                  label="English"
                />
                <track
                  default={contentLanguage === "ko"}
                  kind="captions"
                  src="/guides/assistant-knowledge/assistant-knowledge.ko.vtt"
                  srcLang="ko"
                  label="한국어"
                />
              </video>
            ) : (
              <Image
                src={ASSISTANT_KNOWLEDGE_GUIDE_POSTER_PATH}
                alt={copy.posterAlt}
                fill
                priority
                unoptimized
                sizes="(max-width: 1200px) 100vw, 1152px"
                className="object-cover"
              />
            )}
          </div>
          <div className="border-t border-white/10 px-5 py-4 text-white sm:flex sm:items-center sm:justify-between sm:gap-5 sm:px-7">
            <p className="text-sm font-bold">
              {ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH
                ? copy.videoLabel
                : copy.mediaLabel}
            </p>
            <p className="mt-1 text-sm text-zinc-400 sm:mt-0">
              {ASSISTANT_KNOWLEDGE_GUIDE_VIDEO_PATH
                ? copy.videoHint
                : copy.videoUnavailable}
            </p>
          </div>
        </section>

        <section aria-labelledby="guide-steps-heading" className="mt-12">
          <h2 id="guide-steps-heading" className="text-2xl font-black">
            {copy.stepsHeading}
          </h2>
          <div className="mt-5 grid gap-3 lg:grid-cols-3">
            {copy.steps.map((step, index) => {
              const Icon = stepIcons[index];
              const active = step.id === selectedStep;
              return (
                <button
                  key={step.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => selectStep(step.id)}
                  className={`rounded-3xl border p-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950 ${
                    active
                      ? "border-teal-500 bg-teal-50 shadow-lg shadow-teal-950/5 dark:bg-teal-950/30"
                      : "border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700"
                  }`}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-xs font-bold uppercase tracking-wider text-teal-700 dark:text-teal-300">
                      {step.label}
                    </span>
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="mt-4 block text-lg font-black">
                    {step.title}
                  </span>
                  <span className="mt-2 block text-sm leading-6 text-zinc-600 dark:text-zinc-300">
                    {step.body}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            aria-live="polite"
            className="mt-4 rounded-3xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/70"
          >
            <div className="flex items-start gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200">
                <Check className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-lg font-black">{selected.previewTitle}</h3>
                <p className="mt-2 max-w-3xl text-sm leading-7 text-zinc-600 dark:text-zinc-300">
                  {selected.previewBody}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8 rounded-3xl border border-teal-200 bg-teal-50 p-6 dark:border-teal-900 dark:bg-teal-950/25">
          <h2 className="text-lg font-black">{copy.boundaryTitle}</h2>
          <p className="mt-2 max-w-4xl text-sm leading-7 text-zinc-700 dark:text-zinc-200">
            {copy.boundaryBody}
          </p>
        </section>

        <section className="mt-10 flex flex-col items-start">
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
