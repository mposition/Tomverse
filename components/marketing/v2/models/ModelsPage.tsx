"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { NATIVE_ATTACHMENT_ESTIMATED_TOKENS } from "@/lib/chatAttachmentTokens";
import { getModelBrand } from "@/lib/modelBranding";
import {
  INPUT_CREDIT_MULTIPLIERS,
  getInputCreditMultiplier,
  getModelUsageProfile,
  modelSupportsImageInput,
  type AiModel,
  type ModelMinimumPlan,
  type ModelUsageCategory,
} from "@/lib/models";
import { localizedPath } from "@/lib/seo";
import { MarketingFooter, MarketingHeader } from "../../MarketingChrome";
import { useMarketingChatEntry } from "../../MarketingChatAvailability";
import { PROVIDER_LABELS } from "../../ModelCatalogueSection";
import { statusLinkLabel, statusNewTabCopy } from "../../statusLinkCopy";
import { modelsPageContent } from "./modelsPageContent";
import "../v2-pages.css";
import "./models-page.css";

// Models page (approved concept, owner 2026-11-20). Every model, provider, credit
// number and tag is read from the live public catalogue (useModelCatalog), never
// from this file or from copy.

/** Fallback when the catalogue has not loaded: the provider count on 2026-11-19. */
const FALLBACK_PROVIDER_COUNT = 12;

/** The catalogue's credit categories, lightest first. */
const GRADE_ORDER: readonly ModelUsageCategory[] = ["Standard", "Advanced", "Premium", "Reasoning", "Research", "Frontier", "Apex"];
const PLAN_ORDER: readonly ModelMinimumPlan[] = ["Guest", "Free", "Pro"];

/**
 * Presentation groups for the "reading credits" panel: base credits up to 3, up to
 * 16, and above. The ranges shown are computed from the catalogue, so these
 * thresholds only decide which model falls in which row.
 */
const BAND_LIMITS = [3, 16] as const;

const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));

type Row = {
  model: AiModel;
  providerLabel: string;
  grade: ModelUsageCategory;
  credits: number;
  image: boolean;
  reasoning: boolean;
  limited: boolean;
  haystack: string;
};

type Caps = { image: boolean; reasoning: boolean; oneCredit: boolean };
const NO_CAPS: Caps = { image: false, reasoning: false, oneCredit: false };

const providerLabelOf = (provider: string) => (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;

function ProviderTile({ provider }: { provider: string }) {
  const brand = getModelBrand(provider);
  return <span className={`m-tile${brand.image ? "" : " mark"}`} data-provider={provider} aria-hidden="true">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {brand.image ? <img src={brand.image} alt="" /> : brand.mark}
  </span>;
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="m-chip" aria-pressed={pressed} onClick={onClick}>{children}</button>;
}

const tierOf = (credits: number) => (credits <= BAND_LIMITS[0] ? 0 : credits <= BAND_LIMITS[1] ? 1 : 2);
const toneOf = (credits: number) => (credits <= 1 ? "low" : credits <= BAND_LIMITS[1] ? "mid" : "high");

export function ModelsPage() {
  const { lang, t } = useLanguage();
  const copy = modelsPageContent[lang];
  const { publicModels } = useModelCatalog();
  const { chatHref } = useMarketingChatEntry();

  const [query, setQuery] = useState("");
  const [plan, setPlan] = useState<ModelMinimumPlan | "all">("all");
  const [grade, setGrade] = useState<ModelUsageCategory | "all">("all");
  const [provider, setProvider] = useState("all");
  const [caps, setCaps] = useState<Caps>(NO_CAPS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const numberFormat = useMemo(() => new Intl.NumberFormat(lang), [lang]);
  const rows = useMemo<Row[]>(() => publicModels.map((model) => {
    const usage = getModelUsageProfile(model);
    const providerLabel = providerLabelOf(model.provider);
    return {
      model,
      providerLabel,
      grade: usage.category,
      credits: usage.credits,
      image: modelSupportsImageInput(model),
      reasoning: Boolean(model.reasoning && model.reasoning !== "none"),
      limited: model.status !== "enabled",
      haystack: `${model.name} ${model.id} ${providerLabel}`.toLowerCase(),
    };
  }), [publicModels]);

  const providers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.model.provider, (counts.get(row.model.provider) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || providerLabelOf(a[0]).localeCompare(providerLabelOf(b[0])))
      .map(([id]) => id);
  }, [rows]);
  const grades = GRADE_ORDER.filter((value) => rows.some((row) => row.grade === value));

  const needle = query.trim().toLowerCase();
  const shown = rows.filter((row) =>
    (!needle || row.haystack.includes(needle)) &&
    (plan === "all" || row.model.minimumPlan === plan) &&
    (grade === "all" || row.grade === grade) &&
    (provider === "all" || row.model.provider === provider) &&
    (!caps.image || row.image) &&
    (!caps.reasoning || row.reasoning) &&
    (!caps.oneCredit || row.credits === 1));
  const filtered = Boolean(needle) || plan !== "all" || grade !== "all" || provider !== "all" || caps.image || caps.reasoning || caps.oneCredit;
  const clearFilters = () => { setQuery(""); setPlan("all"); setGrade("all"); setProvider("all"); setCaps(NO_CAPS); };
  const toggleCap = (key: keyof Caps) => setCaps((current) => ({ ...current, [key]: !current[key] }));

  const providerCount = new Set(rows.map((row) => row.model.provider)).size;
  const n = providerCount >= 3 ? providerCount : FALLBACK_PROVIDER_COUNT;
  const creditUnit = (credits: number) => copy.list.creditUnit[credits === 1 ? 0 : 1];

  // The "reading credits" panel: up to three rows, each with the range the catalogue gives.
  const bands = [0, 1, 2].flatMap((tier) => {
    const inBand = rows.filter((row) => tierOf(row.credits) === tier);
    if (!inBand.length) return [];
    const credits = inBand.map((row) => row.credits);
    const low = Math.min(...credits);
    const high = Math.max(...credits);
    return [{
      tier,
      range: low === high ? numberFormat.format(low) : `${numberFormat.format(low)}–${numberFormat.format(high)}`,
      unit: creditUnit(high),
      count: inBand.length,
      names: inBand.slice(0, 2).map((row) => row.model.name).join(", "),
      provider: inBand[0].model.provider,
    }];
  });

  const inputBands = [
    { label: fill(copy.credits.guide.bandUpTo, { a: numberFormat.format(INPUT_CREDIT_MULTIPLIERS[0].aboveTokens) }), x: 1 },
    ...INPUT_CREDIT_MULTIPLIERS.map((threshold, index) => {
      const next = INPUT_CREDIT_MULTIPLIERS[index + 1];
      return {
        label: next
          ? fill(copy.credits.guide.bandBetween, { a: numberFormat.format(threshold.aboveTokens), b: numberFormat.format(next.aboveTokens) })
          : fill(copy.credits.guide.bandOver, { a: numberFormat.format(threshold.aboveTokens) }),
        x: threshold.multiplier,
      };
    }),
  ];

  const reviewHref = localizedPath(lang, "/products/review");
  const chatPageHref = `${localizedPath(lang, "/products/chat")}#adaptive`;
  const calcHref = `${localizedPath(lang, "/pricing")}#calc`;
  const title = copy.hero.title.map((line) => fill(line, { n }));

  return <div className="tv-page" lang={lang} data-testid="models-page">
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" chatHref={chatHref} reviewInfoHref={reviewHref} />
    <main id="top">
      <section className="page-hero dark-zone" aria-labelledby="models-title">
        <div className="hero-media" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/marketing/v2/models-hero.jpg" alt="" />
        </div>
        <div className="wrap">
          <p className="crumb"><Link href={localizedPath(lang, "/")}>Tomverse</Link> / <b>{copy.crumb}</b></p>
          <h1 id="models-title" data-testid="models-title">{title[0]}<br /><em>{title[1]}</em></h1>
          <p className="hero-lede">{copy.hero.body}</p>
          <div className="hero-actions">
            <a className="btn" href="#list" data-testid="models-primary-cta"><span>{copy.hero.primary}</span><span aria-hidden="true">↓</span></a>
            <Link className="btn ghost" href={chatPageHref}><span>{copy.hero.secondary}</span><span aria-hidden="true">↗</span></Link>
          </div>
        </div>
      </section>

      <section id="list" className="chapter" style={{ paddingTop: 48 }} aria-labelledby="models-list-title">
        <div className="wrap">
          <h2 id="models-list-title" className="m-sr">{copy.list.sectionLabel}</h2>
          <div className="m-filters" role="search" aria-label={copy.list.searchLabel}>
            <label className="m-search">
              <span aria-hidden="true">⌕</span>
              <input type="search" value={query} placeholder={copy.list.searchPlaceholder} aria-label={copy.list.searchLabel}
                onChange={(event) => setQuery(event.target.value)} />
            </label>
            <button type="button" className="m-toggle" data-testid="models-mobile-filters-toggle" aria-expanded={filtersOpen}
              aria-controls="models-catalog-filters" onClick={() => setFiltersOpen((open) => !open)}>
              {copy.list.filtersToggle}<span aria-hidden="true">{filtersOpen ? "▴" : "▾"}</span>
            </button>
            <div id="models-catalog-filters" className="m-filter-body" data-open={filtersOpen}>
              <div className="m-row" role="group" aria-label={copy.list.rows.plan}>
                <span className="m-row-label" aria-hidden="true">{copy.list.rows.plan}</span>
                <div className="m-chips">
                  <Chip pressed={plan === "all"} onClick={() => setPlan("all")}>{copy.list.all}</Chip>
                  {PLAN_ORDER.map((value) => <Chip key={value} pressed={plan === value} onClick={() => setPlan(value)}>{copy.list.plans[value]}</Chip>)}
                </div>
                <p className="m-help">{copy.list.planNote}</p>
              </div>
              <div className="m-row" role="group" aria-label={copy.list.rows.grade}>
                <span className="m-row-label" aria-hidden="true">{copy.list.rows.grade}</span>
                <div className="m-chips">
                  <Chip pressed={grade === "all"} onClick={() => setGrade("all")}>{copy.list.all}</Chip>
                  {grades.map((value) => <Chip key={value} pressed={grade === value} onClick={() => setGrade(value)}>{t(`modelUsageClasses.${value.toLowerCase()}`)}</Chip>)}
                </div>
              </div>
              <div className="m-row" role="group" aria-label={copy.list.rows.feature}>
                <span className="m-row-label" aria-hidden="true">{copy.list.rows.feature}</span>
                <div className="m-chips">
                  <Chip pressed={caps.image} onClick={() => toggleCap("image")}>{copy.list.features.image}</Chip>
                  <Chip pressed={caps.reasoning} onClick={() => toggleCap("reasoning")}>{copy.list.features.reasoning}</Chip>
                  <Chip pressed={caps.oneCredit} onClick={() => toggleCap("oneCredit")}>{copy.list.features.oneCredit}</Chip>
                </div>
              </div>
              <div className="m-row" role="group" aria-label={copy.list.rows.provider}>
                <span className="m-row-label" aria-hidden="true">{copy.list.rows.provider}</span>
                <div className="m-chips">
                  <Chip pressed={provider === "all"} onClick={() => setProvider("all")}>{copy.list.all}</Chip>
                  {providers.map((id) => {
                    const brand = getModelBrand(id);
                    return <Chip key={id} pressed={provider === id} onClick={() => setProvider(id)}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {brand.image ? <img src={brand.image} alt="" /> : null}{providerLabelOf(id)}
                    </Chip>;
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="m-meta">
            <p className="m-count" role="status" aria-atomic="true" data-testid="models-count">
              {fill(copy.list.count, { shown: shown.length, total: rows.length })}
            </p>
            {filtered ? <button type="button" className="m-clear" onClick={clearFilters}>{copy.list.clear}</button> : null}
          </div>

          {shown.length === 0
            ? <p className="m-empty">{copy.list.empty}</p>
            : <div className="m-grid">
              {shown.map((row) => <article key={row.model.id} className="m-card" data-model-id={row.model.id}>
                <ProviderTile provider={row.model.provider} />
                <div className="m-main">
                  <h3>{row.model.name}</h3>
                  <p className="m-sub"><span>{row.providerLabel}</span></p>
                  <div className="m-tags">
                    <span className={`chip${row.model.minimumPlan === "Guest" ? " green" : row.model.minimumPlan === "Pro" ? " amber" : ""}`}>{copy.list.plans[row.model.minimumPlan]}</span>
                    {row.image ? <span className="chip">{copy.list.tags.image}</span> : null}
                    {row.reasoning ? <span className="chip blue">{copy.list.tags.reasoning}</span> : null}
                    {row.limited ? <span className="chip amber">{copy.list.tags.limited}</span> : null}
                  </div>
                </div>
                <div className={`m-cr ${toneOf(row.credits)}`} data-testid="model-page-credit-cost" role="group"
                  aria-label={`${copy.list.creditLabel}: ${row.credits} ${creditUnit(row.credits)}`}>
                  <b>{numberFormat.format(row.credits)}</b><small>{creditUnit(row.credits)}</small>
                </div>
              </article>)}
            </div>}
          <p className="note">{copy.list.note} <a className="m-link" href="#model-input-credit-guide">{copy.list.guideLink}</a></p>
        </div>
      </section>

      <section className="chapter signature-chapter" aria-labelledby="models-credits-title">
        <div className="wrap split">
          <div className="copy">
            <span className="eyebrow">{copy.credits.eyebrow}</span>
            <h2 id="models-credits-title">{copy.credits.title[0]}<br /><em>{copy.credits.title[1]}</em></h2>
            <p>{copy.credits.body}</p>
            <details id="model-input-credit-guide" className="m-guide" tabIndex={-1}>
              <summary>{copy.credits.guide.summary}</summary>
              <p>{copy.credits.guide.intro}</p>
              <p>{fill(copy.credits.guide.files, { tokens: numberFormat.format(NATIVE_ATTACHMENT_ESTIMATED_TOKENS), x: numberFormat.format(getInputCreditMultiplier(NATIVE_ATTACHMENT_ESTIMATED_TOKENS + 1)) })}</p>
              <dl>
                {inputBands.map((band) => <div key={band.label} data-testid="model-input-credit-band">
                  <dt>{band.label}</dt><dd>{fill(copy.credits.guide.bandValue, { x: numberFormat.format(band.x) })}</dd>
                </div>)}
              </dl>
              <p>{copy.credits.guide.outro}</p>
            </details>
          </div>
          <div className="panel glow">
            {bands.map((band) => <div key={band.tier} className="m-band">
              <ProviderTile provider={band.provider} />
              <div className="m-main"><h3>{copy.credits.bands[band.tier][0]}</h3><p className="m-sub">{fill(copy.credits.bands[band.tier][1], { count: band.count, names: band.names })}</p></div>
              <div className={`m-cr ${(["low", "mid", "high"] as const)[band.tier]}`}><b>{band.range}</b><small>{band.unit}</small></div>
            </div>)}
            <p className="note"><Link className="m-link" href={calcHref}>{copy.credits.calc} <span aria-hidden="true">↗</span></Link></p>
          </div>
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 24 }} aria-labelledby="models-cta-title">
        <div className="wrap">
          <div className="cta-band">
            <div><h2 id="models-cta-title">{copy.cta.title[0]}<br />{copy.cta.title[1]}</h2><p>{copy.cta.body}</p></div>
            <div className="hero-actions" style={{ margin: 0 }}>
              <Link className="btn white" href={reviewHref}><span>{copy.cta.review}</span><span aria-hidden="true">↗</span></Link>
              <Link className="btn ghost" href={`/status?lang=${encodeURIComponent(lang)}`} target="_blank" rel="noopener noreferrer" prefetch={false}
                aria-label={statusLinkLabel(copy.cta.status, lang)} title={statusNewTabCopy[lang]} data-testid="models-status-link">
                <span>{copy.cta.status}</span><span aria-hidden="true">↗</span>
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}
