"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { localizedPath } from "@/lib/seo";
import { MarketingFooter, MarketingHeader } from "../../MarketingChrome";
import { useMarketingChatEntry } from "../../MarketingChatAvailability";
import { chatPageContent, type ChatPageCopy } from "./chatPageContent";
import "../v2-pages.css";
import "./chat-page.css";

// Chat introduction page (approved concept, owner 2026-11-20). Every moving part
// reads one `reduce` switch: the OS preference or the hero's pause button.

const MODEL_ICON = (name: string) => `/model-icons/${name}.png`;
const PLUGIN_ICON = (name: string) => `/plugins/providers/${name}`;

/** Fallback when the catalogue has not loaded: the provider count on 2026-11-19. */
const FALLBACK_PROVIDER_COUNT = 12;

/**
 * Credits of the three example models, from the production catalogue of 2026-11-19
 * (GPT 6.2 Sol, Gemini Flash-Lite, Claude Fable 5.2).
 */
const EXAMPLE_CREDITS = { sol: 16, flashLite: 1, fable: 80 } as const;

const fillProviders = (text: string, n: number) => text.replaceAll("{n}", String(n));
const fillCredits = (text: string, credits: number) => text.replaceAll("{c}", String(credits));

const manualPicks: Array<[icon: string, name: string, provider: string]> = [
  ["claude", "Claude Fable 5.2", "Anthropic"],
  ["gemini", "Gemini 4 Argon", "Google"],
  ["grok", "Grok 4.7", "xAI"],
];
const importSources: Array<[icon: string, name: string, file: string]> = [
  ["chatgpt", "ChatGPT", "conversations.json"],
  ["claude", "Claude", "claude-export.zip"],
  ["gemini", "Gemini", "takeout.zip"],
];

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

function Arrow() {
  return <span aria-hidden="true">↗</span>;
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

function HeroVideo({ reduce }: { reduce: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (reduce) { video.pause(); return; }
    video.play().catch(() => {});
  }, [reduce]);
  return <div className="hero-media" aria-hidden="true">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src="/marketing/v2/chat-hero.jpg" alt="" />
    <video ref={ref} src="/marketing/v2/chat-hero.mp4" poster="/marketing/v2/chat-hero.jpg" autoPlay={!reduce} muted loop playsInline preload="auto" />
  </div>;
}

function Action({ href, children, className = "btn", testId }: { href: string; children: ReactNode; className?: string; testId?: string }) {
  return <Link href={href} className={className} data-testid={testId}><span>{children}</span><Arrow /></Link>;
}

function ModelTile({ icon }: { icon: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <span className="tile"><img src={MODEL_ICON(icon)} alt="" /></span>;
}

/* ---------- Smart Adaptive pipeline ---------- */

function Pipeline({ copy, reduce }: { copy: ChatPageCopy["adaptive"]; reduce: boolean }) {
  const [step, setStep] = useState(0);
  // Rotation stops for good as soon as the visitor picks a step.
  const [autoplay, setAutoplay] = useState(true);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (reduce || !autoplay) return;
    const timer = window.setInterval(() => setStep((current) => (current + 1) % copy.steps.length), 3800);
    return () => window.clearInterval(timer);
  }, [reduce, autoplay, copy.steps.length]);
  const pick = (index: number) => { setAutoplay(false); setStep(index); };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = copy.steps.length;
    const next = event.key === "ArrowDown" || event.key === "ArrowRight" ? (index + 1) % count
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? (index + count - 1) % count : -1;
    if (next < 0) return;
    event.preventDefault(); pick(next); tabs.current[next]?.focus();
  };
  const rotating = autoplay && !reduce;
  return <div className="pipe rise">
    <div className="pipe-steps" role="tablist" aria-label={copy.stepsLabel}>
      {copy.steps.map(([title, small], i) => <button key={title} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab"
        id={`chat-pipe-tab-${i}`} aria-controls={`chat-pipe-view-${i}`} aria-selected={step === i} tabIndex={step === i ? 0 : -1}
        onClick={() => pick(i)} onKeyDown={(event) => onKey(event, i)}>
        <b>{String(i + 1).padStart(2, "0")}</b><span><strong>{title}</strong><small>{small}</small></span>
      </button>)}
    </div>
    <div className="panel glow pipe-view" aria-live={rotating ? "off" : "polite"}>
      <div className={step === 0 ? "on" : ""} role="tabpanel" id="chat-pipe-view-0" aria-labelledby="chat-pipe-tab-0" aria-hidden={step !== 0}>
        <p className="q-old">{copy.original}</p>
        <span className="chip blue">{copy.refinerChip}</span>
        <p className="q-big">{copy.refined}</p>
        <div className="diff-tags">{copy.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}</div>
      </div>
      <div className={step === 1 ? "on" : ""} role="tabpanel" id="chat-pipe-view-1" aria-labelledby="chat-pipe-tab-1" aria-hidden={step !== 1}>
        <p className="muted" style={{ fontSize: ".875rem" }}>{copy.need}</p>
        <div className="route-row"><ModelTile icon="chatgpt" /><span><strong>GPT 6.2 Sol</strong><small>{copy.routeNotes[0]}</small></span><span className="chip">{fillCredits(copy.credits, EXAMPLE_CREDITS.sol)}</span></div>
        <div className="route-row win"><ModelTile icon="gemini" /><span><strong>Gemini Flash-Lite</strong><small>{copy.routeNotes[1]}</small></span><span className="chip blue">{fillCredits(copy.chosenCredits, EXAMPLE_CREDITS.flashLite)}</span></div>
        <div className="route-row"><ModelTile icon="claude" /><span><strong>Claude Fable 5.2</strong><small>{copy.routeNotes[2]}</small></span><span className="chip">{fillCredits(copy.credits, EXAMPLE_CREDITS.fable)}</span></div>
      </div>
      <div className={step === 2 ? "on" : ""} role="tabpanel" id="chat-pipe-view-2" aria-labelledby="chat-pipe-tab-2" aria-hidden={step !== 2}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <div className="answer-meta"><img src={MODEL_ICON("gemini")} alt="" style={{ width: 18, height: 18 }} />{fillCredits(copy.answerMeta, EXAMPLE_CREDITS.flashLite)}</div>
        <div className="answer-card">{copy.answer}</div>
        <p className="muted" style={{ fontSize: ".8125rem" }}>{copy.followNote}</p>
      </div>
    </div>
  </div>;
}

/* ---------- Page ---------- */

export function ChatProductPage() {
  const { lang } = useLanguage();
  const copy = chatPageContent[lang];
  const { publicModels } = useModelCatalog();
  const providerCount = new Set(publicModels.map((model) => model.provider)).size;
  const n = providerCount >= 3 ? providerCount : FALLBACK_PROVIDER_COUNT;
  const { isAuthenticated, guestTrialAvailable, chatHref } = useMarketingChatEntry();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [motionPaused, setMotionPaused] = useState(false);
  const reduce = prefersReducedMotion || motionPaused;

  // The import steps light up in turn while the page is moving.
  const [importStep, setImportStep] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const timer = window.setInterval(() => setImportStep((current) => (current + 1) % copy.continue.steps.length), 1600);
    return () => window.clearInterval(timer);
  }, [reduce, copy.continue.steps.length]);

  const modelsHref = localizedPath(lang, "/models");
  const reviewHref = localizedPath(lang, "/products/review");
  const linkStyle = { color: "var(--brand-hi)" };

  return <div className="tv-page" lang={lang} data-testid="chat-product-page" data-motion={reduce ? "paused" : "running"}>
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" chatHref={chatHref} reviewInfoHref={reviewHref} />
    <main id="top">
      <section className="page-hero dark-zone" aria-labelledby="chat-title">
        <HeroVideo reduce={reduce} />
        <div className="wrap">
          <p className="crumb"><Link href={localizedPath(lang, "/")}>Tomverse</Link> / <b>{copy.crumb}</b></p>
          <h1 id="chat-title" data-testid="chat-product-title"><Title lines={copy.hero.title} /></h1>
          <p className="hero-lede">{fillProviders(copy.hero.body, n)}</p>
          <div className="hero-actions">
            <Action href={chatHref} testId="chat-product-primary-cta">{copy.hero.primary}</Action>
            <Action href={modelsHref} className="btn ghost">{copy.hero.secondary}</Action>
          </div>
          {!isAuthenticated && guestTrialAvailable && <p className="hero-note" data-testid="chat-product-guest-note">{copy.hero.note}</p>}
          {!prefersReducedMotion && <button type="button" className="chat-motion-toggle" data-testid="launch-motion-toggle" aria-pressed={motionPaused}
            onClick={() => setMotionPaused((paused) => !paused)}>
            <span className="icon" aria-hidden="true">{motionPaused ? "▶" : "❚❚"}</span>{motionPaused ? copy.hero.motionOn : copy.hero.motionOff}
          </button>}
        </div>
      </section>

      <section id="adaptive" className="chapter" aria-labelledby="chat-adaptive-title">
        <div className="wrap">
          <span className="eyebrow">{copy.adaptive.eyebrow}</span>
          <h2 id="chat-adaptive-title" className="section-title"><Title lines={copy.adaptive.title} /></h2>
          <Pipeline copy={copy.adaptive} reduce={reduce} />
          <p className="note">{copy.adaptive.note}</p>
        </div>
      </section>

      <section id="manual" className="chapter" style={{ paddingTop: 24 }} aria-labelledby="chat-manual-title">
        <div className="wrap split">
          <div className="copy">
            <span className="eyebrow">{copy.manual.eyebrow}</span>
            <h2 id="chat-manual-title"><Title lines={copy.manual.title} /></h2>
            <p>{copy.manual.body}</p>
            <ul className="ticks">
              <li><span>{copy.manual.creditTick[0]}<small>
                <Linked text={copy.manual.creditTick[1]} links={{
                  models: <Link href={modelsHref} style={linkStyle}>{copy.manual.modelsLink}</Link>,
                  calc: <Link href={`${localizedPath(lang, "/pricing")}#calc`} style={linkStyle}>{copy.manual.calcLink}</Link>,
                }} />
              </small></span></li>
              <li><span>{copy.manual.compareTick[0]}<small>{copy.manual.compareTick[1]}</small></span></li>
            </ul>
          </div>
          <div className="panel rise">
            <p className="say" style={{ alignSelf: "auto", marginLeft: "auto", width: "fit-content", maxWidth: "92%", marginBottom: 16 }}>{copy.manual.say}</p>
            <div className="route-row win"><ModelTile icon="chatgpt" /><span><strong>GPT 6.2 Sol</strong><small>OpenAI</small></span><span className="chip blue">{copy.manual.selected}</span></div>
            <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
              {manualPicks.map(([icon, name, provider]) => <div key={name} className="route-row">
                <ModelTile icon={icon} /><span><strong>{name}</strong><small>{provider}</small></span><span className="chip">{copy.manual.choose}</span>
              </div>)}
            </div>
          </div>
        </div>
      </section>

      <section id="continue" className="chapter signature-chapter" aria-labelledby="chat-continue-title">
        <div className="wrap">
          <div className="chapter-head">
            <div><span className="eyebrow">{copy.continue.eyebrow}</span><h2 id="chat-continue-title"><Title lines={copy.continue.title} /></h2></div>
            <p>{copy.continue.body}</p>
          </div>
          <div className="import-flow rise">
            {importSources.map(([icon, name, file]) => <div key={name} className="import-src"><ModelTile icon={icon} /><strong>{name}</strong><code>{file}</code></div>)}
            <div className="import-src soon"><ModelTile icon="perplexity" /><strong>Perplexity</strong><code>{copy.continue.soon}</code></div>
          </div>
          <div className="steps rise" style={{ marginTop: 48 }}>
            {copy.continue.steps.map(([title, body], i) => <div key={title} className={`step${importStep === i ? " on" : ""}`}>
              <span className="n">{String(i + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{body}</p>
            </div>)}
          </div>
          <p className="note">{copy.continue.note}</p>
        </div>
      </section>

      <section id="tools" className="chapter" aria-labelledby="chat-tools-title">
        <div className="wrap">
          <span className="eyebrow">{copy.tools.eyebrow}</span>
          <h2 id="chat-tools-title" className="section-title"><Title lines={copy.tools.title} /></h2>
          <div className="cards four rise">
            {copy.tools.cards.map((card) => <div key={card.k} className="card">
              <span className="k">{card.k}</span><h3>{card.h}</h3><p>{card.p}</p><p className="foot-note">{card.f}</p>
            </div>)}
          </div>
        </div>
      </section>

      <section id="create" className="chapter" style={{ paddingTop: 24 }} aria-labelledby="chat-create-title">
        <div className="wrap">
          <div className="chapter-head">
            <div><span className="eyebrow">{copy.create.eyebrow}</span><h2 id="chat-create-title"><Title lines={copy.create.title} /></h2></div>
            <p>{copy.create.body}</p>
          </div>
          <div className="create-grid rise">
            <article className="create-card">
              <div className="cv img-compare" aria-hidden="true">
                <div className="gen g1"><span>GPT Image 2</span></div>
                <div className="gen g2 pick"><span>Nano Banana 2</span><i>✓</i></div>
                <div className="gen g3"><span>Grok Imagine</span></div>
              </div>
              <span className="k">{copy.create.cards[0].k}</span><h3>{copy.create.cards[0].h}</h3><p>{copy.create.cards[0].p}</p>
            </article>
            <article className="create-card">
              <div className="cv photo-edit" aria-hidden="true">
                <div className="ph before"><b>{copy.create.original}</b></div>
                <div className="ph after"><b>{copy.create.edited}</b></div>
                <span className="edit-say">{copy.create.editSay}</span>
              </div>
              <span className="k">{copy.create.cards[1].k}</span><h3>{copy.create.cards[1].h}</h3><p>{copy.create.cards[1].p}</p>
            </article>
            <article className="create-card">
              <div className="cv convert" aria-hidden="true">
                <div className="files-in"><span className="fi jpg">JPG</span><span className="fi jpg">JPG</span><span className="fi pdf">PDF</span></div>
                <span className="arrow-flow">→</span>
                <div className="files-out"><span className="fi pdf big">PDF</span></div>
              </div>
              <span className="k">{copy.create.cards[2].k}</span><h3>{copy.create.cards[2].h}</h3><p>{copy.create.cards[2].p}</p>
            </article>
          </div>
          <p className="note">{copy.create.note}</p>
        </div>
      </section>

      <section id="plugins" className="chapter" style={{ paddingTop: 24 }} aria-labelledby="chat-plugins-title">
        <div className="wrap split flip">
          <div className="copy">
            <span className="eyebrow">{copy.plugins.eyebrow}</span>
            <h2 id="chat-plugins-title"><Title lines={copy.plugins.title} /></h2>
            <p>{copy.plugins.body}</p>
            <ul className="ticks">
              {copy.plugins.ticks.map(([title, small]) => <li key={title}><span>{title}<small>{small}</small></span></li>)}
            </ul>
            <div className="ai-stack" style={{ marginTop: 22 }} aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {["github.png", "notion.png", "slack.png", "google-drive.png"].map((icon) => <img key={icon} src={PLUGIN_ICON(icon)} alt="" />)}<i className="more">+</i>
            </div>
          </div>
          <div className="panel glow rise">
            <div className="route-row" style={{ background: "transparent", padding: "0 0 14px" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <span className="tile"><img src={PLUGIN_ICON("github.png")} alt="" /></span>
              <span><strong>{copy.plugins.connectTitle}</strong><small>{copy.plugins.connectAsk}</small></span>
              <span className="chip green">{copy.plugins.connected}</span>
            </div>
            <div className="scope">
              {copy.plugins.scopes.map(([label, tag], i) => <label key={label}>
                <input type="checkbox" defaultChecked={i < 2} /><span>{label}</span><small>{tag}</small>
              </label>)}
            </div>
            <p className="mcp-card" style={{ marginTop: 14, display: "flex" }}>{copy.plugins.customServer} <code>https://mcp.my-company.dev/sse</code></p>
          </div>
        </div>
        <div className="wrap"><p className="note">{copy.plugins.note}</p></div>
      </section>

      <section id="keep" className="chapter" aria-labelledby="chat-keep-title">
        <div className="wrap">
          <span className="eyebrow">{copy.keep.eyebrow}</span>
          <h2 id="chat-keep-title" className="section-title"><Title lines={copy.keep.title} /></h2>
          <div className="cards four rise">
            {copy.keep.cards.map((card) => <div key={card.k} className="card">
              <span className="k">{card.k}</span><h3>{card.h}</h3><p>{card.p}</p><p className="foot-note">{card.f}</p>
            </div>)}
          </div>
        </div>
      </section>

      <section id="mobile" className="chapter" style={{ paddingTop: 24 }} aria-labelledby="chat-mobile-title">
        <div className="wrap split">
          <div className="copy">
            <span className="eyebrow">{copy.mobile.eyebrow}</span>
            <h2 id="chat-mobile-title"><Title lines={copy.mobile.title} /></h2>
            <p>{copy.mobile.body}</p>
          </div>
          <div className="mini-phone rise" aria-hidden="true">
            <div className="screen">
              <div className="bar"><strong>Tomverse</strong><span>Smart Adaptive</span></div>
              <div className="bubble me">{copy.mobile.me}</div>
              <div className="bubble ai">{copy.mobile.ai}</div>
              <div className="typing"><i /><i /><i /></div>
              <div className="compose">{copy.mobile.compose}<i>↑</i></div>
            </div>
          </div>
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 24 }} aria-labelledby="chat-cta-title">
        <div className="wrap">
          <div className="cta-band">
            <div><h2 id="chat-cta-title">{copy.cta.title[0]}<br />{copy.cta.title[1]}</h2><p>{copy.cta.body}</p></div>
            <div className="hero-actions" style={{ margin: 0 }}>
              <Action href={reviewHref} className="btn white">{copy.cta.review}</Action>
              <Action href={chatHref} className="btn ghost">{copy.cta.chat}</Action>
            </div>
          </div>
        </div>
      </section>
    </main>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}
