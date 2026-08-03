"use client";

import Link from "next/link";
import { ArrowRight, Compass, ExternalLink, LayoutGrid } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  PUBLIC_MODEL_PROVIDERS,
  type AiProvider,
} from "@/lib/models";
import { formatLocalizedInteger } from "@/lib/pricingFormat";
import { getLandingCopy, interpolate } from "./landingContent";
import { ConditionLine, SectionHeading } from "./landingPrimitives";
import { statusLinkLabel, statusNewTabCopy } from "./statusLinkCopy";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  groq: "Groq",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  moonshot: "Moonshot AI",
  minimax: "MiniMax",
  qwen: "Qwen",
  zhipu: "Zhipu AI",
  perplexity: "Perplexity",
};

/**
 * The catalogue entry point, plus the two conditions that decide what a given
 * visitor can actually select: their plan, and whether a model is up right now.
 *
 * The provider count is derived from lib/models.ts rather than written into
 * copy. The landing FAQ used to carry a fixed list of ten provider names that
 * had already fallen one behind the catalogue; a derived count cannot.
 */
export function ModelCatalogueSection() {
  const { lang } = useLanguage();
  const copy = getLandingCopy(lang).catalogue;
  const providerCount = PUBLIC_MODEL_PROVIDERS.length;

  return (
    <section
      id="model-catalogue"
      aria-labelledby="landing-catalogue-heading"
      data-testid="landing-catalogue-section"
      className="border-b border-zinc-200 py-16 dark:border-zinc-800 sm:py-20"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <SectionHeading
          title={copy.title}
          description={copy.description}
          lang={lang}
          headingId="landing-catalogue-heading"
        />

        <div className="mt-10 overflow-hidden rounded-3xl border border-zinc-800">
          <div className="grid lg:grid-cols-[1.2fr_0.8fr]">
          <article className="min-w-0 bg-zinc-950 p-[20px] text-white sm:p-[28px] lg:p-[36px]">
            <span className="flex h-[44px] w-[44px] items-center justify-center rounded-2xl bg-accent-model-catalogue-500/15 text-accent-model-catalogue-500">
              <LayoutGrid className="h-5 w-5" aria-hidden="true" />
            </span>
            <p
              data-testid="landing-provider-count"
              className="mt-6 max-w-2xl break-words text-2xl font-black sm:text-3xl"
            >
              {interpolate(copy.providerNote, {
                count: formatLocalizedInteger(providerCount, lang),
              })}
            </p>
            <div
              data-testid="landing-provider-list"
              className="mt-7 grid grid-cols-2 border-y border-zinc-800 sm:grid-cols-3"
            >
              {PUBLIC_MODEL_PROVIDERS.map((provider) => (
                <span
                  key={provider}
                  className="min-w-0 break-words border-b border-zinc-800 px-[8px] py-[11px] text-xs font-semibold text-zinc-300 odd:border-r sm:odd:border-r-0 sm:[&:not(:nth-child(3n))]:border-r"
                >
                  {PROVIDER_LABELS[provider]}
                </span>
              ))}
            </div>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                href="/models"
                data-testid="landing-models-cta"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-5 text-sm font-bold text-zinc-950 transition hover:bg-zinc-200"
              >
                {copy.cta}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                href="/status"
                target="_blank"
                rel="noopener noreferrer"
                prefetch={false}
                aria-label={statusLinkLabel(copy.statusCta, lang)}
                title={statusNewTabCopy[lang]}
                data-testid="landing-status-cta"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-zinc-700 px-4 text-sm font-bold text-zinc-200 transition hover:bg-zinc-900"
              >
                {copy.statusCta}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          </article>

          <article className="flex min-w-0 flex-col justify-center bg-accent-model-catalogue-500/10 p-[20px] sm:p-[28px] lg:p-[36px]">
            <span className="flex h-[44px] w-[44px] items-center justify-center rounded-2xl bg-accent-model-catalogue-500/15 text-accent-model-catalogue-500">
              <Compass className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="mt-6 break-words text-xl font-black sm:text-2xl">
              {copy.modelFinderLead}
            </p>
            <p className="mt-3 break-words text-sm leading-6 text-zinc-600 dark:text-zinc-300">
              {copy.modelFinderCta}
            </p>
          </article>
          </div>

          <div className="grid gap-2 border-t border-zinc-200 bg-white px-[20px] pb-[20px] dark:border-zinc-800 dark:bg-zinc-950 sm:grid-cols-2 sm:px-[28px] sm:pb-[24px]">
            <ConditionLine testId="landing-catalogue-plan-note">
              {copy.planNote}
            </ConditionLine>
            <ConditionLine testId="landing-catalogue-status-note">
              {copy.statusNote}
            </ConditionLine>
          </div>
        </div>
      </div>
    </section>
  );
}
