"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/MarketingChrome";
import { PROVIDER_LABELS } from "@/components/marketing/ModelCatalogueSection";
import { localizedPath } from "@/lib/seo";
import { cursorGuideContent, type CursorGuideCopy } from "./cursorGuideContent";
import {
  cursorGuideProviders,
  cursorGuideRenames,
  cursorGuideRows,
  filterCursorGuideRows,
  smartAdaptiveOnlyCount,
} from "./cursorGuideModels";
import "../v2-pages.css";
import "./cursor-guide.css";

// Cursor connection guide (Figma draft approved by the owner 2026-11-21). The model
// table is read from the live catalogue; everything else is in cursorGuideContent.

const API_BASE = "https://tomverse.app/api/v1";
const MASKED_KEY = "tvk_••••••••";
const SMART_ADAPTIVE_ID = "smart-adaptive";
/** Rows shown before "Show all", Smart Adaptive included. */
const COLLAPSED_ROWS = 12;
/** Retired ids shown before "Show all". */
const COLLAPSED_RENAMES = 6;
const KEY_PATH = "/settings/api";
const SECTION_IDS = ["before", "step-key", "step-cursor", "step-model", "routing", "models", "verify", "troubleshooting"] as const;
/** Whether each routing row reaches Tomverse, in the order of copy.routing.rows. */
const ROUTE_TO_TOMVERSE = [true, true, false, false] as const;
const COPY_ALL = [`OpenAI API Key: <YOUR_TOMVERSE_API_KEY>`, `Override OpenAI Base URL: ${API_BASE}`, `Custom model: ${SMART_ADAPTIVE_ID}`].join("\n");
/** An example receipt, not live data: what a connected Cursor key's receipts look like. */
const RECEIPT_EXAMPLE = [
  { time: "10:32", asked: "gpt-6-luna", answered: "gpt-6-luna", credits: 2, stopped: false },
  { time: "10:29", asked: SMART_ADAPTIVE_ID, answered: "deepseek-v4-pro", credits: 2, stopped: false },
  { time: "10:29", asked: SMART_ADAPTIVE_ID, answered: "deepseek-v4-pro", credits: 1, stopped: true },
] as const;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), text);
const providerName = (provider: string) => (PROVIDER_LABELS as Record<string, string>)[provider] ?? provider;

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(key);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 1600);
  };
  return { copied, copy };
}

function CopyIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>;
}

function Switch({ on }: { on: boolean }) {
  return <span className={`cg-switch${on ? " on" : ""}`} aria-hidden="true"><i /></span>;
}

function useActiveSection() {
  const [active, setActive] = useState<string>(SECTION_IDS[0]);
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id);
    }, { rootMargin: "-80px 0px -60% 0px" });
    for (const id of SECTION_IDS) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, []);
  return active;
}

function ModelTable({ copy }: { copy: CursorGuideCopy["models"] }) {
  const { models, catalogLoaded } = useModelCatalog();
  const rows = useMemo(() => cursorGuideRows(models), [models]);
  const renames = useMemo(() => cursorGuideRenames(models), [models]);
  const providers = useMemo(() => cursorGuideProviders(rows), [rows]);
  const smartOnly = useMemo(() => smartAdaptiveOnlyCount(models), [models]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [renamesOpen, setRenamesOpen] = useState(false);
  const { copied, copy: copyText } = useCopy();
  const filtered = filterCursorGuideRows(rows, query, provider);
  const needle = query.trim().toLowerCase();
  const showSmart = provider === null && (!needle || SMART_ADAPTIVE_ID.includes(needle) || copy.smartName.toLowerCase().includes(needle));
  const total = rows.length + 1;
  const narrowed = provider !== null || needle.length > 0;
  const visible = narrowed || expanded ? filtered : filtered.slice(0, COLLAPSED_ROWS - 1);
  const shownCount = visible.length + (showSmart ? 1 : 0);

  const idCell = (id: string) => <span className="cg-id">
    <code>{id}</code>
    <button type="button" className="cg-icon-btn" onClick={() => void copyText(id, id)}
      aria-label={fill(copied === id ? copy.copiedId : copy.copyId, { id })} data-testid={`cursor-guide-copy-${id}`}>
      {copied === id ? <span aria-hidden="true">✓</span> : <CopyIcon />}
    </button>
  </span>;

  return <>
    <div className="cg-tools">
      <label className="cg-search">
        <span className="sr-only">{copy.search}</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
        <input type="search" value={query} placeholder={copy.search} onChange={(event) => setQuery(event.target.value)} data-testid="cursor-guide-model-search" />
      </label>
      <span className="cg-source">{copy.source}</span>
    </div>
    <div className="cg-chips" role="group" aria-label={copy.head[2]}>
      <button type="button" className="cg-chip" aria-pressed={provider === null} onClick={() => setProvider(null)}>{copy.all} {total}</button>
      {providers.map((entry) => <button key={entry.provider} type="button" className="cg-chip" aria-pressed={provider === entry.provider}
        onClick={() => setProvider(provider === entry.provider ? null : entry.provider)} data-testid={`cursor-guide-provider-${entry.provider}`}>
        {providerName(entry.provider)} {entry.count}
      </button>)}
    </div>
    <div className="cg-table-wrap">
      <table className="cg-table cg-models" data-testid="cursor-guide-models" aria-busy={!catalogLoaded}>
        <thead><tr>{copy.head.map((head, i) => <th key={head} scope="col" className={i === 3 ? "num" : undefined}>{head}</th>)}</tr></thead>
        <tbody>
          {!catalogLoaded ? <tr><td colSpan={4} className="cg-empty"><span className="cg-skeleton" />{copy.source}</td></tr> : <>
            {showSmart && <tr className="cg-smart" data-testid="cursor-guide-model-row">
              <td data-label={copy.head[0]}><span className="cg-name">{copy.smartName}</span></td>
              <td data-label={copy.head[1]}>{idCell(SMART_ADAPTIVE_ID)}</td>
              <td data-label={copy.head[2]} className="muted">{copy.smartProvider}</td>
              <td data-label={copy.head[3]} className="num">{copy.smartCredits}</td>
            </tr>}
            {visible.map((row) => <tr key={row.id} data-testid="cursor-guide-model-row">
              <td data-label={copy.head[0]}><span className="cg-name">{row.name}</span></td>
              <td data-label={copy.head[1]}>{idCell(row.id)}</td>
              <td data-label={copy.head[2]} className="muted">{providerName(row.provider)}</td>
              <td data-label={copy.head[3]} className="num">{row.credits}</td>
            </tr>)}
            {shownCount === 0 && <tr><td colSpan={4} className="cg-empty">{copy.empty}</td></tr>}
          </>}
        </tbody>
      </table>
      {catalogLoaded && <div className="cg-more">
        <span>{fill(copy.shown, { shown: shownCount, total })}</span>
        {!narrowed && filtered.length > COLLAPSED_ROWS - 1 && <button type="button" className="cg-link-btn" aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)} data-testid="cursor-guide-show-all">{expanded ? copy.showLess : copy.showAll}</button>}
      </div>}
    </div>
    {catalogLoaded && smartOnly > 0 && <p className="cg-small">{fill(copy.smartOnly, { count: smartOnly })}</p>}
    <p className="cg-small">{copy.creditsNote}</p>
    {catalogLoaded && renames.length > 0 && <div className="cg-box" data-testid="cursor-guide-renames">
      <h3>{copy.renamedTitle}</h3>
      <p>{copy.renamedBody}</p>
      <ul>{(renamesOpen ? renames : renames.slice(0, COLLAPSED_RENAMES)).map((rename) => <li key={rename.from}><code className="old">{rename.from}</code><span aria-hidden="true">→</span><code>{rename.to}</code></li>)}</ul>
      {renames.length > COLLAPSED_RENAMES && <button type="button" className="cg-link-btn" aria-expanded={renamesOpen}
        onClick={() => setRenamesOpen((value) => !value)} data-testid="cursor-guide-renames-toggle">
        {renamesOpen ? copy.showLess : `${copy.showAll} (${renames.length})`}
      </button>}
    </div>}
  </>;
}

export function CursorGuidePage() {
  const { lang } = useLanguage();
  const copy = cursorGuideContent[lang];
  const active = useActiveSection();
  const { copied, copy: copyText } = useCopy();
  const keyHref = KEY_PATH;
  const steps = copy.steps.items;

  return <div className="tv-page cursor-guide" lang={lang} data-testid="cursor-guide-page">
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" />
    <main id="top" className="wrap cg-layout">
      <nav className="cg-toc" aria-label={copy.toc.label}>
        <p className="cg-toc-label">{copy.toc.label}</p>
        <ol>{SECTION_IDS.map((id, i) => <li key={id}><a href={`#${id}`} aria-current={active === id ? "location" : undefined}>{copy.toc.items[i]}</a></li>)}</ol>
        <div className="cg-toc-card">
          <p>{copy.toc.cardBody}</p>
          <Link href={keyHref} className="cg-small-btn">{copy.toc.cardAction} <span aria-hidden="true">→</span></Link>
        </div>
      </nav>

      <article className="cg-main">
        <header className="cg-hero">
          <p className="crumb"><Link href={localizedPath(lang, "/")}>Tomverse</Link> / <Link href={localizedPath(lang, "/developers")}>{copy.crumbDevelopers}</Link> / <b>Cursor</b></p>
          <h1 data-testid="cursor-guide-title">{copy.hero.title}</h1>
          <p className="cg-lede">{copy.hero.body}</p>
          <div className="cg-actions">
            <Link className="btn" href={keyHref} data-testid="cursor-guide-primary-cta"><span>{copy.hero.primary}</span><span aria-hidden="true">↗</span></Link>
            <a className="btn ghost" href="#models"><span>{copy.hero.secondary}</span><span aria-hidden="true">↓</span></a>
          </div>
          <ul className="cg-meta">{copy.hero.chips.map((chip, i) => <li key={chip} className={i === 2 ? "ok" : undefined}>{chip}</li>)}</ul>
        </header>

        <section id="before" className="cg-notice" aria-labelledby="before-title">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>
          <div><h2 id="before-title">{copy.notice.title}</h2><p>{copy.notice.body}</p></div>
        </section>

        <section className="cg-section" aria-labelledby="connect-title">
          <h2 id="connect-title">{copy.steps.title}</h2>
          <ol className="cg-steps">
            <li id="step-key" className="cg-step">
              <span className="cg-num" aria-hidden="true">1</span>
              <div><h3>{steps[0].title}</h3><p>{steps[0].body}</p></div>
            </li>
            <li id="step-cursor" className="cg-step">
              <span className="cg-num" aria-hidden="true">2</span>
              <div>
                <h3>{steps[1].title}</h3><p>{steps[1].body}</p>
                <div className="cg-mock" aria-hidden="true">
                  <div className="cg-mock-row">
                    <div className="cg-mock-top"><strong>OpenAI API Key</strong><span>{copy.steps.keySwitch}<Switch on /></span></div>
                    <div className="cg-field"><code>{MASKED_KEY}••••••••••••</code><CopyIcon /></div>
                  </div>
                  <div className="cg-mock-row">
                    <div className="cg-mock-top"><strong>Override OpenAI Base URL</strong><span>{copy.steps.urlSwitch}<Switch on /></span></div>
                    <div className="cg-field"><code>{API_BASE}</code><CopyIcon /></div>
                  </div>
                </div>
                <div className="cg-url">
                  <code>{API_BASE}</code>
                  <button type="button" className="cg-icon-btn" onClick={() => void copyText("url", API_BASE)} aria-label={copied === "url" ? copy.steps.copied : `${copy.steps.copy} ${API_BASE}`} data-testid="cursor-guide-copy-url">
                    {copied === "url" ? <span aria-hidden="true">✓</span> : <CopyIcon />}
                  </button>
                </div>
                <p className="cg-small">{copy.steps.urlNote}</p>
              </div>
            </li>
            <li id="step-model" className="cg-step">
              <span className="cg-num" aria-hidden="true">3</span>
              <div>
                <h3>{steps[2].title}</h3><p>{steps[2].body}</p>
                <div className="cg-mock" aria-hidden="true">
                  <div className="cg-mock-row cg-add"><span className="cg-field focus"><code>{SMART_ADAPTIVE_ID}</code></span><span className="cg-add-btn">+ Add</span></div>
                  <div className="cg-mock-row cg-model"><span><code>{SMART_ADAPTIVE_ID}</code><em className="cg-badge">{copy.steps.recommended}</em></span><Switch on /></div>
                  <div className="cg-mock-row cg-model"><span><code>gpt-6-luna</code></span><Switch on /></div>
                  <div className="cg-mock-row cg-model off"><span><code>{copy.steps.builtIn}</code></span><Switch on={false} /></div>
                </div>
                <div className="cg-config">
                  <div className="cg-config-top"><span>{copy.steps.copyTitle}</span>
                    <button type="button" className="cg-link-btn" onClick={() => void copyText("all", COPY_ALL)} data-testid="cursor-guide-copy-all">
                      <CopyIcon />{copied === "all" ? copy.steps.copied : copy.steps.copy}
                    </button>
                  </div>
                  <pre><span>OpenAI API Key: </span><b>{MASKED_KEY}</b>{"\n"}<span>Override OpenAI Base URL: </span><b>{API_BASE}</b>{"\n"}<span>Custom model: </span><b>{SMART_ADAPTIVE_ID}</b></pre>
                </div>
              </div>
            </li>
          </ol>
        </section>

        <section id="routing" className="cg-section" aria-labelledby="routing-title">
          <h2 id="routing-title">{copy.routing.title}</h2>
          <p className="cg-lead">{copy.routing.lead}</p>
          <div className="cg-table-wrap">
            <table className="cg-table cg-routes">
              <thead><tr>{copy.routing.head.map((head) => <th key={head} scope="col">{head}</th>)}</tr></thead>
              <tbody>{copy.routing.rows.map((row, i) => <tr key={row.pick}>
                <th scope="row" data-label={copy.routing.head[0]}>{row.pick}</th>
                <td data-label={copy.routing.head[1]}><span className={`cg-dest${ROUTE_TO_TOMVERSE[i] ? " ok" : ""}`}>{ROUTE_TO_TOMVERSE[i] ? copy.routing.toTomverse : copy.routing.toCursor}</span></td>
                <td data-label={copy.routing.head[2]}>{row.result}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>

        <section id="models" className="cg-section" aria-labelledby="models-title">
          <h2 id="models-title">{copy.models.title}</h2>
          <p className="cg-lead">{copy.models.lead}</p>
          <ModelTable copy={copy.models} />
        </section>

        <section id="verify" className="cg-section" aria-labelledby="verify-title">
          <h2 id="verify-title">{copy.verify.title}</h2>
          <p className="cg-lead">{copy.verify.lead}</p>
          <div className="cg-receipt" aria-hidden="true">
            <div className="cg-receipt-top"><span>{copy.verify.receiptTitle}</span><code>{copy.verify.receiptKey}</code></div>
            {RECEIPT_EXAMPLE.map((row, i) => <div key={i} className="cg-receipt-row">
              <code className="t">{row.time}</code>
              <span className="m"><code>{row.asked}</code>{row.asked !== row.answered && <><span>→</span><code className="hi">{row.answered}</code></>}</span>
              <span className="c">{fill(copy.verify.credits, { credits: row.credits })}</span>
              <span className={`cg-status${row.stopped ? " warn" : ""}`}>{row.stopped ? copy.verify.stopped : copy.verify.done}</span>
            </div>)}
          </div>
          <p className="cg-hint">{copy.verify.hint}</p>
        </section>

        <section id="troubleshooting" className="cg-section" aria-labelledby="faq-title">
          <h2 id="faq-title">{copy.faq.title}</h2>
          <div className="cg-faq">{copy.faq.items.map((item) => <div key={item.q} className="cg-faq-item"><h3>{item.q}</h3><p>{item.a}</p></div>)}</div>
        </section>

        <p className="cg-back"><Link href={localizedPath(lang, "/developers")} data-testid="cursor-guide-back">← {copy.back}</Link></p>
      </article>
    </main>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}
