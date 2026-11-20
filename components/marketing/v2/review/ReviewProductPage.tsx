"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { reviewDemoVideo } from "@/components/marketing/v2/reviewDemoVideo";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { AI_REVIEW_CREDITS, QUICK_SUMMARY_CREDITS } from "@/lib/comparisonReviewCost";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { workspaceDestination } from "@/lib/productEntryDestination";
import { localizedPath } from "@/lib/seo";
import { MarketingFooter, MarketingHeader } from "../../MarketingChrome";
import { useMarketingChatEntry } from "../../MarketingChatAvailability";
import { reviewPageContent } from "./reviewPageContent";
import "../v2-pages.css";
import "./review-page.css";

// Answer comparison page (approved concept, owner 2026-11-20). Every moving part
// reads one `reduce` switch: the OS preference or the hero's pause button.

const MODEL_ICON = (name: string) => `/model-icons/${name}.png`;

/** Fallback when the catalogue has not loaded: the provider count on 2026-11-19. */
const FALLBACK_PROVIDER_COUNT = 12;

/** The providers shown in the picker; `icon` is a file under /model-icons, MiniMax has none. */
const providerTiles: Array<{ title: string; icon?: string }> = [
  { title: "OpenAI", icon: "chatgpt" }, { title: "Anthropic", icon: "claude" }, { title: "Google", icon: "gemini" },
  { title: "xAI", icon: "grok" }, { title: "DeepSeek", icon: "deepseek" }, { title: "Perplexity", icon: "perplexity" },
  { title: "Mistral", icon: "mistral" }, { title: "Qwen", icon: "qwen" }, { title: "Moonshot AI", icon: "kimi" },
  { title: "Zhipu AI", icon: "zhipu" }, { title: "MiniMax" }, { title: "Cohere", icon: "cohere" },
];

const fillNumbers = (text: string, values: Record<string, number>) =>
  text.replace(/\{(\w+)\}/g, (token, key: string) => (key in values ? String(values[key]) : token));

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduce(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduce;
}

function Arrow({ down = false }: { down?: boolean }) {
  return <span aria-hidden="true">{down ? "↓" : "↗"}</span>;
}

function Title({ lines }: { lines: [string, string] }) {
  return <>{lines[0]}<br /><em>{lines[1]}</em></>;
}

/** Replaces `{name}` tokens in a sentence with the given nodes. */
function Linked({ text, links }: { text: string; links: Record<string, ReactNode> }) {
  return <>{text.split(/(\{\w+\})/).map((part, i) => {
    const token = /^\{(\w+)\}$/.exec(part)?.[1];
    return token && links[token] ? <Fragment key={i}>{links[token]}</Fragment> : part;
  })}</>;
}

/** A looping muted video that stops (showing its poster) when the page's motion is off. */
function LoopVideo({ src, poster, reduce, preload, label }: { src: string; poster: string; reduce: boolean; preload: "auto" | "metadata"; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (reduce) { video.pause(); return; }
    video.play().catch(() => {});
  }, [reduce]);
  return <video ref={ref} src={src} poster={poster} autoPlay={!reduce} muted loop playsInline preload={preload} aria-label={label} />;
}

function Action({ href, children, className = "btn", testId, id, down, onClick }: {
  href: string; children: ReactNode; className?: string; testId?: string; id?: string; down?: boolean; onClick?: () => void;
}) {
  return <Link href={href} id={id} className={className} data-testid={testId} onClick={onClick}><span>{children}</span><Arrow down={down} /></Link>;
}

/** A segmented control with roving focus; arrow keys move between its tabs. */
function Segmented({ label, labels, value, onSelect, idPrefix, panelId, className }: {
  label: string; labels: readonly string[]; value: number; onSelect: (index: number) => void; idPrefix: string; panelId: string; className?: string;
}) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = labels.length;
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % count
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + count - 1) % count : -1;
    if (next < 0) return;
    event.preventDefault(); onSelect(next); tabs.current[next]?.focus();
  };
  return <div className={`seg${className ? ` ${className}` : ""}`} role="tablist" aria-label={label}>
    {labels.map((text, i) => <button key={text} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab"
      id={`${idPrefix}-tab-${i}`} aria-controls={panelId} aria-selected={value === i} tabIndex={value === i ? 0 : -1}
      onClick={() => onSelect(i)} onKeyDown={(event) => onKey(event, i)}>{text}</button>)}
  </div>;
}

/* ---------- Page ---------- */

export function ReviewProductPage() {
  const { lang } = useLanguage();
  const copy = reviewPageContent[lang];
  const { publicModels } = useModelCatalog();
  const providerCount = new Set(publicModels.map((model) => model.provider)).size;
  const n = providerCount >= 3 ? providerCount : FALLBACK_PROVIDER_COUNT;
  const { isAuthenticated } = useMarketingChatEntry();
  // The guest's primary action keeps Review's preview entry marker
  // (docs/ui-contracts/chat-product-switcher.md section 3).
  const reviewHref = workspaceDestination({ chatSurfaceAvailable: false, lang, isAuthenticated });
  const prefersReducedMotion = usePrefersReducedMotion();
  const [motionPaused, setMotionPaused] = useState(false);
  const reduce = prefersReducedMotion || motionPaused;

  const landingTracked = useRef(false);
  useEffect(() => {
    if (landingTracked.current) return;
    landingTracked.current = true;
    trackProductEvent("landing_view");
  }, []);

  // The three steps light up in turn while the page is moving.
  const [howStep, setHowStep] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const timer = window.setInterval(() => setHowStep((current) => (current + 1) % copy.how.steps.length), 1600);
    return () => window.clearInterval(timer);
  }, [reduce, copy.how.steps.length]);

  // Quick summary and AI Review alternate until the visitor picks one.
  const [mode, setMode] = useState(0);
  const [modeAuto, setModeAuto] = useState(true);
  useEffect(() => {
    if (reduce || !modeAuto) return;
    const timer = window.setInterval(() => setMode((current) => (current + 1) % 2), 5200);
    return () => window.clearInterval(timer);
  }, [reduce, modeAuto]);
  const pickMode = (index: number) => { setModeAuto(false); setMode(index); };

  const [lens, setLens] = useState(0);

  const modelsHref = localizedPath(lang, "/models");
  const calcHref = `${localizedPath(lang, "/pricing")}#calc`;
  const linkStyle = { color: "var(--brand-hi)" };
  const credits = { summary: QUICK_SUMMARY_CREDITS, review: AI_REVIEW_CREDITS };
  const primaryLabel = isAuthenticated ? copy.hero.primarySignedIn : copy.hero.primary;
  const quickLetters = ["A", "B", "C"] as const;

  return <div className="tv-page" lang={lang} data-testid="review-product-page" data-motion={reduce ? "paused" : "running"}>
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" />
    <main id="top">
      <section className="page-hero dark-zone" aria-labelledby="review-title">
        <div className="hero-media" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/marketing/v2/review-hero.jpg" alt="" />
          <LoopVideo src="/marketing/v2/review-hero.mp4" poster="/marketing/v2/review-hero.jpg" reduce={reduce} preload="auto" />
        </div>
        <div className="wrap">
          <p className="crumb"><Link href={localizedPath(lang, "/")}>Tomverse</Link> / <b>{copy.crumb}</b></p>
          <h1 id="review-title" data-testid="review-product-title"><Title lines={copy.hero.title} /></h1>
          <p className="hero-lede">{fillNumbers(copy.hero.body, { n })}</p>
          <div className="hero-actions">
            {/* #landing-hero-primary is the landing experiment's conversion target and the header's scroll cue. */}
            <Action href={reviewHref} id="landing-hero-primary" testId="landing-primary-cta"
              onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "review_page_hero" })}>{primaryLabel}</Action>
            <Action href="#how" className="btn ghost" down>{copy.hero.secondary}</Action>
          </div>
          {!isAuthenticated && <p className="hero-note" data-testid="review-product-guest-note">{copy.hero.note}</p>}
          {!prefersReducedMotion && <button type="button" className="review-motion-toggle" data-testid="launch-motion-toggle" aria-pressed={motionPaused}
            onClick={() => setMotionPaused((paused) => !paused)}>
            <span className="icon" aria-hidden="true">{motionPaused ? "▶" : "❚❚"}</span>{motionPaused ? copy.hero.motionOn : copy.hero.motionOff}
          </button>}
        </div>
      </section>

      <section className="chapter after-demo" aria-label={copy.demo.sectionLabel}>
        <div className="wrap">
          <figure className="demo-frame rise">
            <div className="demo-bar" aria-hidden="true"><i /><i /><i /><span>tomverse.app/review</span></div>
            <LoopVideo src={reviewDemoVideo(lang).src} poster={reviewDemoVideo(lang).poster} reduce={reduce} preload="metadata" label={copy.demo.videoLabel} />
            <figcaption data-testid="review-demo-caption">{copy.demo.caption}</figcaption>
          </figure>
        </div>
      </section>

      <section id="how" className="chapter" aria-labelledby="review-how-title">
        <div className="wrap">
          <span className="eyebrow">{copy.how.eyebrow}</span>
          <h2 id="review-how-title" className="section-title"><Title lines={copy.how.title} /></h2>
          <div className="steps rise">
            {copy.how.steps.map(([title, body], i) => <div key={title} className={`step${howStep === i ? " on" : ""}`}>
              <span className="n">{String(i + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{body}</p>
            </div>)}
          </div>
        </div>
      </section>

      <section id="modes" className="chapter signature-chapter" aria-labelledby="review-modes-title">
        <div className="wrap">
          <span className="eyebrow">{copy.modes.eyebrow}</span>
          <h2 id="review-modes-title" className="section-title"><Title lines={copy.modes.title} /></h2>
          <div className="summary-modes rise">
            <div>
              <Segmented label={copy.modes.tabsLabel} labels={copy.modes.tabs} value={mode} onSelect={pickMode} idPrefix="review-mode" panelId="review-mode-panel" />
              <p className="muted review-desc" aria-live={modeAuto && !reduce ? "off" : "polite"}>{copy.modes.descriptions[mode]}</p>
            </div>
            <div className="panel glow" id="review-mode-panel" role="tabpanel" aria-labelledby={`review-mode-tab-${mode}`}>
              <div className={`mode-card${mode === 0 ? " on" : ""}`} hidden={mode !== 0}>
                {copy.modes.quickLines.map((line, i) => <p key={line} className="quick-line"><b>{quickLetters[i]}</b>{line}</p>)}
              </div>
              <div className={`mode-card${mode === 1 ? " on" : ""}`} hidden={mode !== 1}>
                {copy.modes.findings.map((finding) => <div key={finding.k} className="finding">
                  <span className="k">{finding.k}</span><p>{finding.p}</p>
                  {finding.quote && <blockquote>{finding.quote}{finding.cite && <cite>{finding.cite}</cite>}</blockquote>}
                </div>)}
              </div>
            </div>
          </div>
          <p className="note review-modes-note">{copy.modes.note}</p>
        </div>
      </section>

      <section id="lens" className="chapter" aria-labelledby="review-lens-title">
        <div className="wrap split">
          <div className="copy">
            <span className="eyebrow">{copy.lens.eyebrow}</span>
            <h2 id="review-lens-title"><Title lines={copy.lens.title} /></h2>
            <p>{copy.lens.body}</p>
            <Segmented label={copy.lens.tabsLabel} labels={copy.lens.lenses.map((item) => item.tab)} value={lens} onSelect={setLens}
              idPrefix="review-lens" panelId="review-lens-panel" className="review-lens-tabs" />
          </div>
          <div className="panel rise" id="review-lens-panel" role="tabpanel" aria-labelledby={`review-lens-tab-${lens}`}>
            <span className="chip blue">{copy.lens.lenses[lens].name}</span>
            <div className="lens-out">{copy.lens.lenses[lens].items.map((item) => <p key={item}>{item}</p>)}</div>
            <p className="note review-lens-note">{copy.lens.note}</p>
          </div>
        </div>
      </section>

      <section id="trust" className="chapter tight" aria-labelledby="review-trust-title">
        <div className="wrap">
          <span className="eyebrow">{copy.trust.eyebrow}</span>
          <h2 id="review-trust-title" className="section-title"><Title lines={copy.trust.title} /></h2>
          <div className="cards four rise">
            {copy.trust.cards.map((card, i) => <div key={card.k} className="card">
              <span className="k">{card.k}</span><h3>{card.h}</h3>
              {i === 0
                ? <div className="match"><div className="match-bar" aria-hidden="true"><i /></div><p>{card.p}</p></div>
                : <p>{card.p}</p>}
              <p className="foot-note">{card.f}</p>
            </div>)}
          </div>
        </div>
      </section>

      <section id="uses" className="chapter" aria-labelledby="review-uses-title">
        <div className="wrap">
          <span className="eyebrow">{copy.uses.eyebrow}</span>
          <h2 id="review-uses-title" className="section-title"><Title lines={copy.uses.title} /></h2>
          <div className="cards rise">
            {copy.uses.cards.map((card) => <div key={card.k} className="card">
              <span className="k">{card.k}</span><h3>{card.h}</h3><p>{card.p}</p>
            </div>)}
          </div>
        </div>
      </section>

      <section id="after" className="chapter tight" aria-labelledby="review-after-title">
        <div className="wrap split flip">
          <div className="copy">
            <span className="eyebrow">{copy.after.eyebrow}</span>
            <h2 id="review-after-title"><Title lines={copy.after.title} /></h2>
            <ul className="ticks">
              {copy.after.ticks.map(([title, small]) => <li key={title}><span>{title}<small>{small}</small></span></li>)}
            </ul>
          </div>
          <div className="panel glow rise">
            <div className="review-cont">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <span className="tile"><img src={MODEL_ICON("claude")} alt="" /></span>
              <span><strong>{copy.after.continueWith}</strong><small>{copy.after.othersPaused}</small></span>
              <span className="chip blue">{copy.after.chip}</span>
            </div>
            <p className="say review-say">{copy.after.say}</p>
            <p className="note">{copy.after.note}</p>
          </div>
        </div>
      </section>

      <section id="providers" className="chapter" aria-labelledby="review-providers-title">
        <div className="wrap">
          <span className="eyebrow">{fillNumbers(copy.providers.eyebrow, { n })}</span>
          <h2 id="review-providers-title" className="section-title"><Title lines={copy.providers.title} /></h2>
          <ul className="prov-grid rise">
            {providerTiles.map((tile) => <li key={tile.title} className="prov-cell">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {tile.icon ? <span className="tile"><img src={MODEL_ICON(tile.icon)} alt="" /></span> : <span className="tile mm" aria-hidden="true">MM</span>}
              <span className="prov-name">{tile.title}</span>
            </li>)}
          </ul>
          <p className="note"><Linked text={copy.providers.note} links={{ models: <Link href={modelsHref} style={linkStyle}>{copy.providers.modelsLink}</Link> }} /></p>
        </div>
      </section>

      <section id="faq" className="chapter tight" aria-labelledby="review-faq-title">
        <div className="wrap">
          <span className="eyebrow">{copy.faq.eyebrow}</span>
          <h2 id="review-faq-title" className="section-title">{copy.faq.title}</h2>
          <div className="faq">
            {copy.faq.items.map(([question, answer], i) => <details key={question} open={i === 0}>
              <summary>{question}</summary>
              <p><Linked text={fillNumbers(answer, credits)} links={{ calc: <Link href={calcHref} style={linkStyle}>{copy.faq.calcLink}</Link> }} /></p>
            </details>)}
          </div>
        </div>
      </section>

      <section className="chapter tight" aria-labelledby="review-cta-title">
        <div className="wrap">
          <div className="cta-band">
            <div><h2 id="review-cta-title">{copy.cta.title[0]}<br />{copy.cta.title[1]}</h2><p>{copy.cta.body}</p></div>
            <div className="hero-actions" style={{ margin: 0 }}>
              <Action href={reviewHref} className="btn white" testId="review-final-cta"
                onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "review_page_final" })}>{primaryLabel}</Action>
              <Action href={localizedPath(lang, "/pricing")} className="btn ghost">{copy.cta.pricing}</Action>
            </div>
          </div>
        </div>
      </section>
    </main>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}
