"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import { displayHeadingClass } from "@/lib/displayHeading";
import { formatLocalizedInteger } from "@/lib/pricingFormat";
import { getLandingCopy } from "./landingContent";
import { ModelCatalogueBlock } from "./ModelCatalogueSection";
import { discardResponseBody } from "@/lib/discardResponseBody";

type ProofMetrics = {
  periodDays: number;
  generatedAt: string;
  comparisons: number | null;
  fileWorkflows: number | null;
  minimumPublicCount: number;
};

/**
 * What you are actually getting and whether you can rely on it: the model
 * catalogue and its plan and availability conditions, then storage, locks,
 * sharing, attachment limits, the provider-processing notice and the public
 * 30-day counts.
 *
 * V1 ran these as two consecutive sections. Both answered the same question
 * and the split cost a scroll stop for nothing, so the catalogue is the first
 * block here. It owns the `trust` anchor the header points at.
 *
 * ## The one inverted band
 *
 * This section is near-black in both themes, and it is the only place on the
 * page where that happens. It is a deliberate composition rather than a
 * section that wandered off the palette: V1 alternated `bg-zinc-50` under
 * every second section, which is the striped rhythm that makes a page read as
 * a template, and it still ended up putting a dark catalogue box inside a
 * light section anyway. One committed switch, at the point where the page
 * stops selling and starts stating what it is bound by, does more than four
 * grey bands.
 *
 * Because the band decides the ink, the shared `ConditionLine` is not used
 * here: its `zinc-600` would fall below AA on near-black. The conditions keep
 * their `data-landing-condition` marker so they are still findable as a class.
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
      .then((response) =>
        response.ok ? response.json() : discardResponseBody(response).then(() => null)
      )
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
      className="border-y border-zinc-800 bg-zinc-950 py-14 text-white sm:py-24"
    >
      <div className="mx-auto max-w-7xl px-[16px] sm:px-6 lg:px-8">
        <div className="landing-reveal max-w-4xl">
          <h2
            id="landing-trust-heading"
            className={`break-words text-3xl font-black leading-[1.02] tracking-[-0.02em] sm:text-5xl lg:text-[3.25rem] ${displayHeadingClass(lang)}`}
          >
            {copy.title}
          </h2>
          <p className="mt-5 max-w-2xl break-words text-base leading-7 text-zinc-300">
            {copy.description}
          </p>
        </div>

        <div className="mt-10">
          <ModelCatalogueBlock />
        </div>

        <ul className="landing-reveal mt-10 grid border-t-2 border-zinc-100 md:grid-cols-3">
          {copy.items.map((item, index) => (
            <li
              key={item.title}
              className={`min-w-0 border-b border-zinc-800 py-[26px] md:border-b-0 ${
                index < 2 ? "md:border-r md:border-zinc-800 md:pr-[32px]" : ""
              } ${index > 0 ? "md:pl-[32px]" : ""}`}
            >
              <h3 className="break-words text-lg font-black tracking-[-0.01em]">
                {item.title}
              </h3>
              <p className="mt-3 break-words text-sm leading-6 text-zinc-300">
                {item.description}
              </p>
              {item.condition && (
                <p
                  data-landing-condition="true"
                  className="mt-4 break-words text-xs font-semibold leading-5 text-zinc-400"
                >
                  {item.condition}
                </p>
              )}
            </li>
          ))}
        </ul>

        <div className="landing-reveal mt-8 flex flex-col items-start gap-6 border-t border-zinc-800 pt-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            {visibleMetrics.length > 0 && (
              <div data-testid="landing-proof-metrics" className="min-w-0">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-400">
                  {copy.metricPeriod}
                </p>
                <div className="mt-4 flex flex-wrap gap-x-12 gap-y-4">
                  {visibleMetrics.map((metric) => (
                    <p key={metric.label} className="min-w-0">
                      <strong className="block break-words text-4xl font-black tabular-nums tracking-[-0.02em] sm:text-5xl">
                        {formatLocalizedInteger(metric.value, lang)}+
                      </strong>
                      <span className="mt-1 block break-words text-sm text-zinc-400">
                        {metric.label}
                      </span>
                    </p>
                  ))}
                </div>
              </div>
            )}
            <p
              data-testid="landing-metric-disclosure"
              data-landing-condition="true"
              className={`max-w-2xl break-words text-xs leading-5 text-zinc-400 ${
                visibleMetrics.length > 0 ? "mt-5" : ""
              }`}
            >
              {copy.metricDisclosure}
            </p>
          </div>
          <Link
            href="/safety"
            data-testid="landing-safety-cta"
            className="group inline-flex min-h-12 shrink-0 items-center gap-2 text-sm font-bold text-white underline underline-offset-4 transition hover:text-zinc-300"
          >
            {copy.safetyCta}
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </div>
      </div>
    </section>
  );
}
