"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/MarketingChrome";
import { homeV2Content, type HomeV2Copy } from "@/components/marketing/home/homeV2Content";
import { CURSOR_GUIDE_PATH } from "@/lib/marketingRoutes";
import { localizedPath } from "@/lib/seo";
import { developersPageContent, type DevelopersPageCopy } from "./developersPageContent";
import "../v2-pages.css";
import "./developers-page.css";

// Developer page (approved concept, owner 2026-11-20). The tool tabs, console text and
// the CLI session reuse the homepage's copy; everything else is in developersPageContent.

const MODEL_ICON = (name: string) => `/model-icons/${name}.png`;
const API_BASE = "https://tomverse.app/api/v1";
/** The coding API (docs/policy/external-api.md): Codex, Cursor and Claude Code. Other apps keep API_BASE. */
const CODING_API_BASE = "https://tomverse.app/api/code/v1";
const CODING_ANTHROPIC_BASE = "https://tomverse.app/api/code/anthropic";
const MASKED_KEY = "tvk_••••••••";
/** Fallback when the catalogue has not loaded: the count on 2026-11-19. */
const FALLBACK_PROVIDER_COUNT = 12;
type ToolKey = "codex" | "claude" | "vscode" | "cursor" | "aside" | "other";
const ROUTE_ROWS = [["deepseek", "light", 1], ["gemini", "light", 1], ["claude", "high", 8], ["mistral", "mid", 4], ["chatgpt", "high", 8]] as const;
const PREMIUM_CREDITS = 8;
const KEY_USED = 120;
const CAP_MIN = 150;
const CAP_MAX = 3000;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), text);

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

function Title({ lines }: { lines: [string, string] }) {
  return <>{lines[0]}<br /><em>{lines[1]}</em></>;
}

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

/* ---------- Console and terminal (colored tokens are React nodes) ---------- */

type Token = string | [cls: "c" | "k" | "s" | "g" | "p" | "d" | "y" | "add" | "del", text: string];
type Config = { file: string; lines: Token[][] };

const apiConfigs = (c: HomeV2Copy["api"]["console"]): Record<ToolKey, Config> => ({
  codex: { file: "~/.codex/config.toml", lines: [
    [["c", c.codexComment]], ["[model_providers.tomverse]"],
    [["k", "name"], " = ", ["s", "\"Tomverse\""]], [["k", "base_url"], " = ", ["s", `"${CODING_API_BASE}"`]],
    [["k", "env_key"], " = ", ["s", "\"TOMVERSE_API_KEY\""]], [["k", "wire_api"], " = ", ["s", "\"responses\""]],
    [], ["$ codex --profile tomverse"], [["g", c.codexOk]],
  ] },
  claude: { file: c.claudeFile, lines: [
    [["c", c.claudeComment]],
    [["k", "export"], " ANTHROPIC_BASE_URL=", ["s", `"${CODING_ANTHROPIC_BASE}"`]],
    [["k", "export"], " ANTHROPIC_AUTH_TOKEN=", ["s", `"${MASKED_KEY}"`]],
    [["k", "export"], " ANTHROPIC_MODEL=", ["s", `"${c.chosenModel}"`]],
    [], ["$ claude"], [["g", c.claudeOk]],
  ] },
  vscode: { file: "Chat: Manage Language Models", lines: [
    [["c", "# Add Models → Custom Endpoint"]], ["Endpoint   ", ["s", `${API_BASE}/chat/completions`]], ["Model      ", ["s", "smart-adaptive"]],
    [], [["c", c.vscodeKeyNote]], [["g", c.vscodeOk]],
  ] },
  cursor: { file: "Cursor › Settings › Models", lines: [
    ["OpenAI API Key             ", ["s", MASKED_KEY]], ["Override OpenAI Base URL   ", ["s", CODING_API_BASE]],
    ["Custom model               ", ["s", c.chosenModel]], [], [["g", c.cursorOk]],
  ] },
  aside: { file: "Aside › Custom Provider", lines: [
    ["{ ", ["k", "\"providers\""], ": { ", ["k", "\"tomverse\""], ": {"],
    ["  ", ["k", "\"name\""], ": ", ["s", "\"Tomverse\""], ","],
    ["  ", ["k", "\"api\""], ": ", ["s", "\"openai-completions\""], ","],
    ["  ", ["k", "\"baseUrl\""], ": ", ["s", `"${API_BASE}"`], ","],
    ["  ", ["k", "\"apiKey\""], ": ", ["s", `"${MASKED_KEY}"`], ","],
    ["  ", ["k", "\"models\""], ": [{ ", ["k", "\"id\""], ": ", ["s", "\"smart-adaptive\""], " }]"],
    ["} } }"],
  ] },
  other: { file: c.otherFile, lines: [
    [["c", c.otherComment]], ["Base URL   ", ["s", API_BASE]], ["API key    ", ["s", MASKED_KEY]],
    ["Model      ", ["s", "smart-adaptive"], ["c", c.otherModelNote]],
    [], [["c", c.otherFormats]], [["c", c.otherAnthropic]], [["g", c.otherOk]],
  ] },
});

function TokenLine({ tokens }: { tokens: Token[] }) {
  return <>{tokens.map((token, i) => typeof token === "string" ? token : <span key={i} className={token[0]}>{token[1]}</span>)}</>;
}

function ToolConsole({ copy, reduce }: { copy: HomeV2Copy["api"]; reduce: boolean }) {
  const configs = apiConfigs(copy.console);
  const clients: Array<{ key: ToolKey; name: string; sub: string; icon?: string }> = [
    { key: "codex", name: "Codex", sub: copy.clients.codex, icon: MODEL_ICON("chatgpt") },
    { key: "claude", name: "Claude Code", sub: copy.clients.claude, icon: MODEL_ICON("claude") },
    { key: "vscode", name: "VS Code", sub: copy.clients.vscode, icon: "/marketing/v2/tools/vscode.png" },
    { key: "cursor", name: "Cursor", sub: copy.clients.cursor, icon: "/marketing/v2/tools/cursor.svg" },
    { key: "aside", name: "Aside", sub: copy.clients.aside, icon: "/marketing/v2/tools/aside.png" },
    { key: "other", name: copy.clients.otherName, sub: copy.clients.other },
  ];
  const [selected, setSelected] = useState(0);
  const auto = useRef(true);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (reduce) return;
    const timer = window.setInterval(() => { if (auto.current) setSelected((i) => (i + 1) % clients.length); }, 4200);
    return () => window.clearInterval(timer);
  }, [reduce, clients.length]);
  const pick = (i: number) => { auto.current = false; setSelected(i); };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = event.key === "ArrowDown" || event.key === "ArrowRight" ? (i + 1) % clients.length
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? (i + clients.length - 1) % clients.length
      : event.key === "Home" ? 0 : event.key === "End" ? clients.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); pick(next); tabs.current[next]?.focus();
  };
  const active = clients[selected];
  const config = configs[active.key];
  return <div className="api rise">
    <div className="clients" role="tablist" aria-label={copy.toolsLabel}>
      {clients.map((client, i) => <button key={client.key} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab"
        id={`dev-api-tab-${client.key}`} aria-controls="dev-api-panel" aria-selected={selected === i} tabIndex={selected === i ? 0 : -1}
        data-testid={`developers-tool-${client.key}`}
        className={`client${client.icon ? "" : " any"}`} onClick={() => pick(i)} onKeyDown={(event) => onKey(event, i)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {client.icon ? <span className="tile"><img src={client.icon} alt="" /></span> : <span className="mono any-mark">{"{ }"}</span>}
        <span><strong>{client.name}</strong><small>{client.sub}</small></span>
      </button>)}
    </div>
    <div className="console dark-zone" role="tabpanel" id="dev-api-panel" aria-labelledby={`dev-api-tab-${active.key}`}>
      <div className="console-bar"><i /><i /><i /><span>{config.file}</span></div>
      <pre data-testid="developers-console">{config.lines.map((line, i) => <span key={i}><TokenLine tokens={line} />{i < config.lines.length - 1 ? "\n" : ""}</span>)}</pre>
      <div className="api-facts">{copy.facts.map(([label, value]) => <div key={label}><b>{label}</b><span>{value}</span></div>)}</div>
    </div>
  </div>;
}

function cliLines(t: HomeV2Copy["cli"]["term"]): { prompt: Token[]; typed: string; rest: Token[][] } {
  return {
    prompt: [["p", "~/projects/calc ❯"], " "],
    typed: `tomverse "${t.ask}"`,
    rest: [
      [["d", t.reading]], [["d", t.cause]], [], [["y", t.diff]],
      [["del", "- for (let i = 0; i < b; i++) r += a;"]], [["add", "+ return a * b;"]], [],
      [t.apply, " ", ["p", "[y/n]"], " y"], [t.run, " ", ["y", "npm test"], " ", ["p", "[y/n]"], " y"],
      [["add", "✓ 6 passed · 0 failed"]], [], [["d", t.summary]],
    ],
  };
}

function CliTerminal({ copy, reduce }: { copy: HomeV2Copy["cli"]; reduce: boolean }) {
  const { prompt, typed, rest } = cliLines(copy.term);
  // At rest (and with reduced motion) the whole session is visible; once the terminal
  // is on screen it replays once as a typed session.
  const [typedChars, setTypedChars] = useState(typed.length);
  const [shownLines, setShownLines] = useState(rest.length);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || reduce || !("IntersectionObserver" in window)) return;
    let timer = 0;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      setPlaying(true); setTypedChars(0); setShownLines(0);
      let chars = 0, lines = 0;
      const typeStep = () => {
        chars += 1; setTypedChars(chars);
        if (chars < typed.length) { timer = window.setTimeout(typeStep, 28); return; }
        timer = window.setTimeout(lineStep, 500);
      };
      const lineStep = () => {
        lines += 1; setShownLines(lines);
        if (lines < rest.length) timer = window.setTimeout(lineStep, 380);
      };
      typeStep();
    }, { threshold: 0.4 });
    observer.observe(node);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [reduce, typed.length, rest.length]);
  return <pre ref={ref} aria-label={copy.terminalLabel}>
    <TokenLine tokens={prompt} />{typed.slice(0, typedChars)}
    {typedChars >= typed.length && rest.slice(0, shownLines).map((line, i) => <span key={i}>{"\n"}<TokenLine tokens={line} /></span>)}
    {playing && <span className="caret" />}
  </pre>;
}

/* ---------- Smart Adaptive routing demo ---------- */

function AdaptiveSection({ copy, reduce }: { copy: DevelopersPageCopy["adaptive"]; reduce: boolean }) {
  const total: number = ROUTE_ROWS.length;
  // Everything is shown at rest and with reduced motion; otherwise the five requests appear one by one.
  const [animated, setShown] = useState(total);
  const shown = reduce ? total : animated;
  useEffect(() => {
    if (reduce) return;
    let timer = 0, i = 0;
    const step = () => {
      i += 1; setShown(i);
      timer = window.setTimeout(i < total ? step : play, i < total ? 700 : 3500);
    };
    function play() { i = 0; setShown(0); timer = window.setTimeout(step, 300); }
    play();
    return () => window.clearTimeout(timer);
  }, [reduce, total]);
  const credits = ROUTE_ROWS.slice(0, shown).reduce((sum, row) => sum + row[2], 0);
  const premium = PREMIUM_CREDITS * shown;
  const max = PREMIUM_CREDITS * total;
  const tierLabel = (tier: (typeof ROUTE_ROWS)[number][1]) => copy.tiers[tier];
  return <section className="chapter signature-chapter" aria-labelledby="sa-title">
    <div className="wrap split">
    <div className="copy">
      <span className="eyebrow">{copy.eyebrow}</span>
      <h2 id="sa-title"><Title lines={copy.title} /></h2>
      <p>
        {copy.body[0]}<code className="dev-code">smart-adaptive</code>{copy.body[1]}<code className="dev-code">model</code>
        {copy.body[2]}<code className="dev-code">x-tomverse-routed-model</code>{copy.body[3]}
      </p>
      <div style={{ display: "grid", gap: 10, marginTop: 28 }}>
        <div className="saving"><span>{copy.savingLabels[0]}</span><span className="bar"><i style={{ width: `${credits / max * 100}%` }} /></span><b data-testid="developers-saving-adaptive">{credits}</b></div>
        <div className="saving"><span>{copy.savingLabels[1]}</span><span className="bar gray"><i style={{ width: `${premium / max * 100}%` }} /></span><b>{premium}</b></div>
        <p className="muted" style={{ fontSize: ".75rem" }}>{copy.savingNote}</p>
      </div>
    </div>
    <div className="panel glow rise">
      <div className="route-demo">
        {ROUTE_ROWS.map(([icon, tier, cost], i) => <div key={icon} className={`route-line${i < shown ? " on" : ""}`}>
          <code>{copy.routeAsks[i]}</code>
          <span className="m">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={MODEL_ICON(icon)} alt="" />{tierLabel(tier)}
          </span>
          <span className="cr">{cost}</span>
        </div>)}
      </div>
      <p className="note" style={{ marginTop: 14 }}>{copy.routeNote}</p>
    </div>
    </div>
  </section>;
}

/* ---------- Key limit demo ---------- */

function KeyCard({ copy, lang }: { copy: DevelopersPageCopy["keys"]; lang: string }) {
  const [cap, setCap] = useState(500);
  const [revoked, setRevoked] = useState(false);
  const number = (value: number) => value.toLocaleString(lang);
  return <div className="panel glow key-card rise">
    <div className="key-row">
      <span><strong>ci-nightly</strong><br /><code>tvk_••••••••3f9a</code></span>
      <span className={`chip ${revoked ? "amber" : "green"}`}>{revoked ? copy.chipRevoked : copy.chipActive}</span>
    </div>
    <div className="key-cap">
      <div className="cap-val"><span className="muted" style={{ fontSize: ".875rem" }}>{copy.capLabel}</span><b className="big-num">{number(cap)}</b></div>
      <input type="range" min={CAP_MIN} max={CAP_MAX} step={50} value={cap} aria-label={copy.capAria} disabled={revoked}
        data-testid="developers-key-cap" onChange={(event) => setCap(Number(event.target.value))} />
      <div className="key-range"><span>{number(CAP_MIN)}</span><span>{number(CAP_MAX)}</span></div>
    </div>
    <div className="key-row">
      <span className="muted" style={{ fontSize: ".875rem" }}>{fill(copy.used, { used: number(KEY_USED), cap: number(cap) })}</span>
      <button type="button" className="btn ghost" onClick={() => setRevoked((value) => !value)}>{revoked ? copy.reset : copy.revoke}</button>
    </div>
    <p className="note" style={{ marginTop: 0 }}>{copy.demoNote}</p>
  </div>;
}

/* ---------- FAQ ---------- */

function FaqAnswer({ text, lang, safetyLink }: { text: string; lang: Parameters<typeof localizedPath>[0]; safetyLink: string }) {
  const parts: ReactNode[] = text.split(/(\{safety\}|\{models\})/).map((part, i) =>
    part === "{safety}" ? <Link key={i} href={localizedPath(lang, "/safety")}>{safetyLink}</Link>
      : part === "{models}" ? <code key={i} className="dev-code">GET /api/v1/models</code> : part);
  return <p>{parts}</p>;
}

/* ---------- Page ---------- */

export function DevelopersPage() {
  const { lang } = useLanguage();
  const copy = developersPageContent[lang];
  const home = homeV2Content[lang];
  const { publicModels } = useModelCatalog();
  const providerCount = new Set(publicModels.map((model) => model.provider)).size;
  const n = providerCount >= 3 ? providerCount : FALLBACK_PROVIDER_COUNT;
  const prefersReducedMotion = usePrefersReducedMotion();
  const [motionPaused, setMotionPaused] = useState(false);
  // One switch for every moving part: the OS preference or the hero's pause button.
  const reduce = prefersReducedMotion || motionPaused;
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (reduce) { video.pause(); return; }
    video.play().catch(() => {});
  }, [reduce]);
  const f = (text: string) => fill(text, { n });
  const keyHref = "/settings/api";

  return <div className="tv-page" lang={lang} data-testid="developers-page" data-motion={reduce ? "paused" : "running"}>
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" />
    <main id="top">
      <section className="page-hero dark-zone" aria-labelledby="dev-title">
        <div className="hero-media" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/marketing/v2/dev-hero.jpg" alt="" />
          <video ref={videoRef} src="/marketing/v2/dev-hero.mp4" poster="/marketing/v2/dev-hero.jpg" autoPlay={!reduce} muted loop playsInline preload="auto" />
        </div>
        <div className="wrap">
          <p className="crumb"><Link href={localizedPath(lang, "/")}>Tomverse</Link> / <b>{copy.crumb}</b></p>
          <h1 id="dev-title" data-testid="developers-title">{f(copy.hero.title[0])}<br /><em>{f(copy.hero.title[1])}</em></h1>
          <p className="hero-lede">{f(copy.hero.body)}</p>
          <div className="hero-actions">
            <Link className="btn" href={keyHref} data-testid="developers-primary-cta"><span>{copy.hero.primary}</span><Arrow /></Link>
            <a className="btn ghost" href="#connect"><span>{copy.hero.secondary}</span><span aria-hidden="true">↓</span></a>
          </div>
          <p className="hero-note">{copy.hero.note}</p>
          {!prefersReducedMotion && <button type="button" className="motion-toggle" data-testid="developers-motion-toggle" aria-pressed={motionPaused}
            onClick={() => setMotionPaused((paused) => !paused)}>
            <span className="icon" aria-hidden="true">{motionPaused ? "▶" : "❚❚"}</span>{motionPaused ? copy.hero.motionOn : copy.hero.motionOff}
          </button>}
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 56 }} aria-labelledby="why-title">
        <div className="wrap">
          <span className="eyebrow">{copy.why.eyebrow}</span>
          <h2 id="why-title" className="section-title"><Title lines={copy.why.title} /></h2>
          <div className="why rise">
            {copy.why.cards.map((card) => <div key={card.k} className="card"><span className="k">{card.k}</span><h3>{f(card.h)}</h3><p>{f(card.p)}</p></div>)}
          </div>
        </div>
      </section>

      <AdaptiveSection copy={copy.adaptive} reduce={reduce} />

      <section className="chapter" id="connect" aria-labelledby="connect-title">
        <div className="wrap">
          <span className="eyebrow">{copy.connect.eyebrow}</span>
          <h2 id="connect-title" className="section-title"><Title lines={copy.connect.title} /></h2>
          <ToolConsole copy={home.api} reduce={reduce} />
          <p className="note">{copy.connect.note}</p>
          <div className="dev-cli-link"><Link className="btn ghost" href={localizedPath(lang, CURSOR_GUIDE_PATH)} data-testid="developers-cursor-guide-link"><span>{copy.connect.cursorGuide}</span><Arrow /></Link></div>
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 24 }} aria-labelledby="proto-title">
        <div className="wrap">
          <span className="eyebrow">{copy.proto.eyebrow}</span>
          <h2 id="proto-title" className="section-title"><Title lines={copy.proto.title} /></h2>
          <div className="proto rise">
            {([["OpenAI Chat Completions", "POST /api/v1/chat/completions"], ["OpenAI Responses", "POST /api/code/v1/responses"], ["Anthropic Messages", "POST /api/code/anthropic/v1/messages"]] as const).map(([name, path], i) =>
              <div key={name} className="card"><span className="k">{name}</span><code>{path}</code><p>{f(copy.proto.descriptions[i])}</p></div>)}
          </div>
          <div className="panel rise" style={{ marginTop: 24 }}>
            <div className="flow" aria-hidden="true">
              <div className="node"><strong>{copy.proto.flowTool[0]}</strong><small>{copy.proto.flowTool[1]}</small></div>
              <div className="wire" />
              <div className="node mid"><strong>{copy.proto.flowApi[0]}</strong><small>{copy.proto.flowApi[1]}</small></div>
              <div className="wire back" />
              <div className="node"><strong>{f(copy.proto.flowProviders[0])}</strong><small>{copy.proto.flowProviders[1]}</small></div>
            </div>
            <p className="muted" style={{ fontSize: ".875rem", marginTop: 18 }}>{copy.proto.privacy}</p>
          </div>
        </div>
      </section>

      <section className="chapter" id="keys" aria-labelledby="keys-title">
        <div className="wrap split flip">
          <div className="copy">
            <span className="eyebrow">{copy.keys.eyebrow}</span>
            <h2 id="keys-title"><Title lines={copy.keys.title} /></h2>
            <ul className="ticks">
              {copy.keys.ticks.map(([title, body]) => <li key={title}><span>{title}<small>{body}</small></span></li>)}
            </ul>
          </div>
          <KeyCard copy={copy.keys} lang={lang} />
        </div>
      </section>

      <section className="chapter" id="cli" style={{ paddingTop: 24 }} aria-labelledby="cli-title">
        <div className="wrap">
          <div className="chapter-head">
            <div><span className="eyebrow">{copy.cli.eyebrow}</span><h2 id="cli-title"><Title lines={copy.cli.title} /></h2></div>
            <p>{copy.cli.body}</p>
          </div>
          <div className="cli rise">
            <div className="term dark-zone">
              <div className="console-bar"><i /><i /><i /><span>~/projects/calc — tomverse</span></div>
              <CliTerminal copy={home.cli} reduce={reduce} />
            </div>
            <div className="cli-steps">
              {home.cli.steps.map(([title, body], i) => <div key={title}><span>{String(i + 1).padStart(2, "0")}</span><div><h4>{title}</h4><p>{body}</p></div></div>)}
            </div>
          </div>
          <div className="dev-cli-link"><Link className="btn ghost" href={localizedPath(lang, "/developers/cli")} data-testid="developers-cli-link"><span>{copy.cli.cta}</span><Arrow /></Link></div>
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 24 }} aria-labelledby="dfaq-title">
        <div className="wrap">
          <span className="eyebrow">{copy.faq.eyebrow}</span>
          <h2 id="dfaq-title" className="section-title">{copy.faq.title}</h2>
          <div className="faq">
            {copy.faq.items.map((item, i) => <details key={item.q} open={i === 0 ? true : undefined}>
              <summary>{item.q}</summary>
              <FaqAnswer text={item.a} lang={lang} safetyLink={copy.faq.safetyLink} />
            </details>)}
          </div>
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 24 }}>
        <div className="wrap">
          <div className="cta-band">
            <div><h2>{copy.cta.title[0]}<br />{copy.cta.title[1]}</h2><p>{copy.cta.body}</p></div>
            <div className="hero-actions" style={{ margin: 0 }}>
              <Link className="btn white" href={keyHref}><span>{copy.cta.primary}</span><Arrow /></Link>
              <Link className="btn ghost" href={localizedPath(lang, "/pricing")}><span>{copy.cta.secondary}</span><Arrow /></Link>
            </div>
          </div>
        </div>
      </section>
    </main>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}
