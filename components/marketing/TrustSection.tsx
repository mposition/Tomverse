"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, BarChart3, Lock, Paperclip, ScreenShare } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { formatLocalizedInteger } from "@/lib/pricingFormat";
import { getLandingCopy } from "./landingContent";
import { ConditionLine, SectionHeading } from "./landingPrimitives";

type ProofMetrics = {
  periodDays: number;
  generatedAt: string;
  comparisons: number | null;
  fileWorkflows: number | null;
  minimumPublicCount: number;
};

const ITEM_ICONS = [Lock, ScreenShare, Paperclip] as const;

/**
 * Storage, locks, sharing, attachment limits -- and the public 30-day usage
 * counts, which moved here from the walkthrough section because they are a
 * trust signal rather than a workflow one.
 *
 * The counts keep their original disclosure verbatim: the API only publishes
 * a figure once it clears a threshold and rounds it down to the nearest ten,
 * and the audit confirmed the sentence matches that implementation exactly.
 * The provider-processing sentence in `description` is likewise unchanged --
 * it is the one place the page tells a visitor their prompt leaves Tomverse.
 */
export function TrustSection() {
  const { lang } = useLanguage();
  const copy = getLandingCopy(lang).trust;
  const [metrics, setMetrics] = useState<ProofMetrics | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/public/proof-metrics", { signal: controller.signal, cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: ProofMetrics | null) => data && setMetrics(data))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const visibleMetrics = [
    typeof metrics?.comparisons === "number"
      ? { label: copy.comparisonMetric, value: metrics.comparisons }
      : null,
    typeof metrics?.fileWorkflows === "number"
      ? { label: copy.fileMetric, value: metrics.fileWorkflows }
      : null,
  ].filter((item): item is { label: string; value: number } => Boolean(item));

  return (
    <section
      id="trust"
      aria-labelledby="landing-trust-heading"
      data-testid="landing-trust-section"
      className="border-b border-zinc-200 py-16 dark:border-zinc-800 sm:py-20"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <SectionHeading
          title={copy.title}
          description={copy.description}
          lang={lang}
          headingId="landing-trust-heading"
        />

        <div className="mt-9 grid gap-4 md:grid-cols-3">
          {copy.items.map((item, index) => {
            const Icon = ITEM_ICONS[index] ?? Lock;
            return (
              <article
                key={item.title}
                className="min-w-0 flex flex-col rounded-2xl border border-zinc-200 bg-zinc-50 p-[20px] dark:border-zinc-800 dark:bg-zinc-900/30"
              >
                <span className="flex h-[40px] w-[40px] items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-base font-bold break-words">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-300 break-words">
                  {item.description}
                </p>
                {item.condition && <ConditionLine>{item.condition}</ConditionLine>}
              </article>
            );
          })}
        </div>

        <div className="mt-6 flex flex-col items-start gap-4 lg:flex-row lg:items-center lg:justify-between">
          {visibleMetrics.length > 0 ? (
            <article
              data-testid="landing-proof-metrics"
              className="w-full rounded-2xl border border-status-success-500/30 bg-status-success-500/5 p-[16px] lg:max-w-2xl"
            >
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-status-success-600">
                <BarChart3 className="h-4 w-4" aria-hidden="true" />
                {copy.metricPeriod}
              </p>
              <div className="mt-3 space-y-2">
                {visibleMetrics.map((metric) => (
                  <p key={metric.label} className="text-sm">
                    <strong className="text-lg font-black break-words">
                      {formatLocalizedInteger(metric.value, lang)}+
                    </strong>{" "}
                    <span className="text-zinc-500">{metric.label}</span>
                  </p>
                ))}
              </div>
              <p
                data-testid="landing-metric-disclosure"
                className="mt-3 text-[11px] leading-5 text-zinc-500"
              >
                {copy.metricDisclosure}
              </p>
            </article>
          ) : (
            <ConditionLine testId="landing-metric-disclosure">
              {copy.metricDisclosure}
            </ConditionLine>
          )}
          <Link
            href="/safety"
            data-testid="landing-safety-cta"
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-zinc-300 px-4 text-sm font-bold text-zinc-800 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-900"
          >
            {copy.safetyCta}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
