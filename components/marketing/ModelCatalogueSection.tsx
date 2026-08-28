"use client";

import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  PUBLIC_MODEL_PROVIDERS,
  type AiProvider,
} from "@/lib/models";
import { formatLocalizedInteger } from "@/lib/pricingFormat";
import { getLandingCopy, interpolate } from "./landingContent";
import { statusLinkLabel, statusNewTabCopy } from "./statusLinkCopy";

/**
 * The provider catalogue, plus the two conditions that decide what a given
 * visitor can actually select: their plan, and whether a model is up now.
 *
 * This is a block rather than a section. V1 gave the catalogue a full section
 * of its own directly above the trust section, and the two were answering the
 * same question -- "what am I actually getting, and can I rely on it" -- in
 * two separate scroll stops. They are one section now (`TrustSection`), which
 * is the page's single inverted band, and this renders inside it. It carries
 * no surface of its own for that reason: the band is the surface.
 *
 * The provider names are set in monospace and ruled into a grid, because the
 * catalogue is a list of what exists rather than a set of logos. Real provider
 * marks would read as an endorsement none of these companies has given.
 *
 * The file keeps its name because `PROVIDER_LABELS` is one of the four
 * provider maps `tests/providerCatalogCoverage.test.mjs` reads by path: that
 * test exists because a provider once printed as its own identifier on an
 * operator report, and renaming the file to tidy up a component boundary
 * would silently drop the marketing surface out of its coverage.
 *
 * The provider count is derived from lib/models.ts rather than written into
 * copy. The landing FAQ used to carry a fixed list of ten provider names that
 * had already fallen one behind the catalogue; a derived count cannot.
 */

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

export function ModelCatalogueBlock() {
  const { lang } = useLanguage();
  const copy = getLandingCopy(lang).catalogue;
  const providerCount = PUBLIC_MODEL_PROVIDERS.length;

  return (
    <div data-testid="landing-catalogue-block" className="landing-reveal min-w-0">
      <div className="grid gap-6 border-t-2 border-zinc-100 pt-8 lg:grid-cols-12 lg:gap-10">
        <div className="min-w-0 lg:col-span-5">
          <h3 className="break-words text-2xl font-black leading-tight tracking-[-0.02em] sm:text-3xl">
            {copy.title}
          </h3>
          <p
            data-testid="landing-provider-count"
            className="mt-4 break-words font-mono text-sm font-semibold tabular-nums text-accent-model-catalogue-500"
          >
            {interpolate(copy.providerNote, {
              count: formatLocalizedInteger(providerCount, lang),
            })}
          </p>
          <p className="mt-4 max-w-xl break-words text-sm leading-6 text-zinc-400">
            {copy.description}
          </p>

          <div className="mt-7 flex flex-wrap gap-3">
            <Link
              href="/models"
              data-testid="landing-models-cta"
              className="inline-flex min-h-12 items-center gap-2 rounded-lg bg-white px-5 text-sm font-bold text-zinc-950 transition hover:bg-zinc-200 active:translate-y-px"
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
              className="inline-flex min-h-12 items-center gap-2 text-sm font-bold text-zinc-200 underline underline-offset-4 transition hover:text-white"
            >
              {copy.statusCta}
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>
        </div>

        <div className="min-w-0 lg:col-span-7">
          <div
            data-testid="landing-provider-list"
            // Rules on the container, not on each cell. The provider count is
            // not a multiple of the column count and the column count changes
            // at `lg`, so a per-cell `border-b` ruled the last row under three
            // cells and left it bare under the fourth, at one breakpoint but
            // not the other. `gap-px` over a rule-coloured background draws
            // the grid itself, which cannot go ragged.
            className="grid grid-cols-3 gap-px border-y border-zinc-800 bg-zinc-800 lg:grid-cols-4"
          >
            {PUBLIC_MODEL_PROVIDERS.map((provider) => (
              <span
                key={provider}
                className="min-w-0 break-words bg-zinc-950 py-[13px] pr-[8px] pl-[10px] font-mono text-xs font-semibold text-zinc-300"
              >
                {PROVIDER_LABELS[provider]}
              </span>
            ))}
          </div>

          {/*
            The two conditions stay attached to the catalogue that is subject
            to them rather than becoming a footnote a section away. They do
            not use the shared ConditionLine: its zinc-600 would fall under AA
            on this band, and the band is the one place on the page where the
            surface, not the component, decides the ink.
          */}
          <div className="mt-5 grid gap-2 sm:grid-cols-2 sm:gap-6">
            <p
              data-testid="landing-catalogue-plan-note"
              data-landing-condition="true"
              className="break-words text-xs font-semibold leading-5 text-zinc-400"
            >
              {copy.planNote}
            </p>
            <p
              data-testid="landing-catalogue-status-note"
              data-landing-condition="true"
              className="break-words text-xs font-semibold leading-5 text-zinc-400"
            >
              {copy.statusNote}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
