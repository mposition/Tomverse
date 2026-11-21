"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/MarketingChrome";
import type { Language } from "@/lib/language";
import { localizedPath } from "@/lib/seo";
import { cliPageContent, type CliPageCopy } from "./cliPageContent";
import "../v2-pages.css";
import "./cli-page.css";

// CLI download page (approved concept, owner 2026-11-20). The package is not on npm
// yet (publishing is the operator's step, apps/tomverse-cli/RELEASING.md), so the
// install commands are shown with a "coming soon" note and no download link.
// Commands, paths and tool names are not translated; see cliPageContent.ts.

const PACKAGE = "@tomverse/cli";
const COMMANDS = {
  install: `npm install -g ${PACKAGE}`,
  // `@latest` is the update path in apps/tomverse-cli/README.md.
  update: `npm install -g ${PACKAGE}@latest`,
  uninstall: `npm uninstall -g ${PACKAGE}`,
  keyUnix: "export TOMVERSE_API_KEY=\"tvk_...\"",
  keyWin: "$env:TOMVERSE_API_KEY = \"tvk_...\"",
  check: "tomverse doctor",
} as const;
const API_KEYS_PATH = "/settings/api";

type Token = string | [cls: "add", text: string];
// The shape of `tomverse doctor` output (apps/tomverse-cli/src/main.ts). Values are an example.
const DOCTOR_ROWS: Array<[name: string, detail: string]> = [
  ["node", "Node 22.11.0"],
  ["folder", "/home/me/projects/calc (trusted)"],
  ["endpoint", "https://tomverse.app/api/code/v1"],
  ["key", "tvk_ab12cd34_… (from TOMVERSE_API_KEY)"],
  ["models", "7 tool-capable models"],
  ["credits", "key cap none, committed 0, held 0"],
  ["recovery", "request status lookup is available"],
];
const DOCTOR_PROMPT = "~/projects/calc ❯";
const DOCTOR_LINES: Token[][] = DOCTOR_ROWS.map(([name, detail]) => [["add", "PASS"], `  ${name.padEnd(9)} ${detail}`]);

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

const subscribeNever = () => () => {};
const detectOs = (): "unix" | "win" => (/Win/.test(navigator.platform || navigator.userAgent || "") ? "win" : "unix");

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
    <img src="/marketing/v2/dev-hero.jpg" alt="" />
    <video ref={ref} src="/marketing/v2/dev-hero.mp4" poster="/marketing/v2/dev-hero.jpg" autoPlay={!reduce} muted loop playsInline preload="auto" />
  </div>;
}

/** A command in a dark box. With `copy` labels it gets a copy button; the fallback selects the text. */
function Command({ prompt, text, copy, copied, className = "" }: { prompt?: string; text: string; copy?: string; copied?: string; className?: string }) {
  const codeRef = useRef<HTMLElement>(null);
  const timer = useRef(0);
  const [done, setDone] = useState(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const select = () => {
    const node = codeRef.current;
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), 1600);
    } catch {
      select();
    }
  };
  return <div className={`cmd ${className}`.trim()}>
    {prompt && <span className="p" aria-hidden="true">{prompt}</span>}
    <code ref={codeRef}>{text}</code>
    {copy && <button type="button" className={`cmd-copy${done ? " done" : ""}`} aria-label={`${done ? copied : copy}: ${text}`} onClick={copyText}>{done ? copied : copy}</button>}
  </div>;
}

function SoonNote({ chip, children }: { chip?: string; children: string }) {
  return <p className="soon-note" role="note">{chip && <span className="chip amber">{chip}</span>}<span>{children}</span></p>;
}

function TokenLine({ tokens }: { tokens: Token[] }) {
  return <>{tokens.map((token, i) => typeof token === "string" ? token : <span key={i} className={token[0]}>{token[1]}</span>)}</>;
}

/** The terminal is fully visible at rest and with reduced motion; otherwise it types once when it scrolls into view. */
function DoctorTerminal({ label, reduce }: { label: string; reduce: boolean }) {
  const typed = COMMANDS.check;
  // null = show everything (server render, reduced motion, finished or not yet played).
  const [progress, setProgress] = useState<{ chars: number; lines: number } | null>(null);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (reduce || !node || !("IntersectionObserver" in window)) return;
    let timer = 0;
    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      observer.disconnect();
      let chars = 0, lines = 0;
      setProgress({ chars, lines });
      const typeStep = () => {
        chars += 1; setProgress({ chars, lines });
        if (chars < typed.length) { timer = window.setTimeout(typeStep, 28); return; }
        timer = window.setTimeout(lineStep, 500);
      };
      const lineStep = () => {
        lines += 1; setProgress({ chars, lines });
        if (lines < DOCTOR_LINES.length) timer = window.setTimeout(lineStep, 380);
        else setProgress(null);
      };
      typeStep();
    }, { threshold: 0.4 });
    observer.observe(node);
    return () => { observer.disconnect(); window.clearTimeout(timer); setProgress(null); };
  }, [reduce, typed.length]);
  const shown = reduce || !progress ? { chars: typed.length, lines: DOCTOR_LINES.length } : progress;
  const playing = !reduce && progress !== null;
  return <pre ref={ref} className="doctor" aria-label={label}>
    <span className="p">{DOCTOR_PROMPT}</span>{" "}{typed.slice(0, shown.chars)}
    {shown.chars >= typed.length && DOCTOR_LINES.slice(0, shown.lines).map((line, i) => <span key={i}>{"\n"}<TokenLine tokens={line} /></span>)}
    {playing && <span className="caret" />}
  </pre>;
}

function InstallSection({ c, lang, copy }: { c: CliPageCopy; lang: Language; copy: { copy: string; copied: string } }) {
  // Windows visitors start on the PowerShell tab; the server render and hydration use macOS · Linux.
  const detected = useSyncExternalStore(subscribeNever, detectOs, () => "unix" as const);
  const [chosen, setOs] = useState<"unix" | "win" | null>(null);
  const os = chosen ?? detected;
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const order = ["unix", "win"] as const;
  const labels = { unix: "macOS · Linux", win: "Windows (PowerShell)" } as const;
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (index + 1) % order.length;
    setOs(order[next]);
    tabs.current[next]?.focus();
  };
  const steps = {
    unix: { prompt: "$", key: c.install.stepKeyUnix, keyCommand: COMMANDS.keyUnix },
    win: { prompt: "PS>", key: c.install.stepKeyWin, keyCommand: COMMANDS.keyWin },
  } as const;
  const { req } = c.install;
  return <section className="chapter after-hero" aria-labelledby="cli-install-title">
    <div className="wrap">
      <span className="eyebrow">{c.install.eyebrow}</span>
      <h2 id="cli-install-title" className="section-title">{c.install.title}</h2>
      <div className="install rise">
        <div className="panel glow">
          <div className="seg os-tabs" role="tablist" aria-label={c.install.osLabel}>
            {order.map((key, i) => <button key={key} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab"
              id={`cli-os-${key}`} aria-controls={`cli-os-panel-${key}`} aria-selected={os === key} tabIndex={os === key ? 0 : -1}
              data-os={key} onClick={() => setOs(key)} onKeyDown={(event) => onKey(event, i)}>{labels[key]}</button>)}
          </div>
          {order.map((key) => <div key={key} className={`os-panel${os === key ? " on" : ""}`} id={`cli-os-panel-${key}`} role="tabpanel"
            aria-labelledby={`cli-os-${key}`} hidden={os !== key} data-panel={key}>
            <p className="muted os-step">{c.install.stepInstall}</p>
            <Command prompt={steps[key].prompt} text={COMMANDS.install} copy={copy.copy} copied={copy.copied} />
            <p className="muted os-step">{steps[key].key}</p>
            <Command prompt={steps[key].prompt} text={steps[key].keyCommand} copy={copy.copy} copied={copy.copied} />
            <p className="muted os-step">{c.install.stepCheck}</p>
            <Command prompt={steps[key].prompt} text={COMMANDS.check} copy={copy.copy} copied={copy.copied} />
          </div>)}
          <SoonNote chip={c.hero.soon}>{c.install.soonNote}</SoonNote>
          <p className="note">{c.install.keyNote}</p>
        </div>
        <div className="panel">
          <p className="panel-label">{c.install.reqTitle}</p>
          <div className="req">
            <div><span>{req.node[0]}</span><b>{req.node[1]}</b></div>
            <div><span>{req.os[0]}</span><b>{req.os[1]}</b></div>
            <div><span>{req.plan[0]}</span><b><Link href={localizedPath(lang, "/pricing")}>{req.plan[1]}</Link></b></div>
            <div><span>{req.key[0]}</span><b><Link href={API_KEYS_PATH}>{req.key[1]}</Link></b></div>
            <div><span>{req.tools[0]}</span><b>{req.tools[1]}</b></div>
          </div>
          <p className="note">{c.install.capNote}</p>
        </div>
      </div>
    </div>
  </section>;
}

export function CliPage() {
  const { lang } = useLanguage();
  const c = cliPageContent[lang];
  const prefersReducedMotion = usePrefersReducedMotion();
  const [motionPaused, setMotionPaused] = useState(false);
  // One switch for every moving part: the OS preference or the hero's pause button.
  const reduce = prefersReducedMotion || motionPaused;
  const copy = { copy: c.copy, copied: c.copied };

  return <div className="tv-page" lang={lang} data-testid="cli-page" data-motion={reduce ? "paused" : "running"}>
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" />
    <main id="top">
      <section className="page-hero dark-zone" aria-labelledby="cli-title">
        <HeroVideo reduce={reduce} />
        <div className="wrap">
          <p className="crumb">
            <Link href={localizedPath(lang, "/")}>{c.crumb.home}</Link> / <Link href={localizedPath(lang, "/developers")}>{c.crumb.developers}</Link> / <b aria-current="page">{c.crumb.current}</b>
          </p>
          <h1 id="cli-title" data-testid="cli-title">{c.hero.title[0]}<br /><em>{c.hero.title[1]}</em></h1>
          <p className="hero-lede">{c.hero.lede}</p>
          <Command prompt="$" text={COMMANDS.install} copy={c.copy} copied={c.copied} className="hero-cmd" />
          <SoonNote>{c.hero.soonNote}</SoonNote>
          <p className="hero-note ver"><span className="chip blue">v1.0.0</span><span>{c.hero.platforms}</span><span className="chip amber">{c.hero.soon}</span></p>
          {!prefersReducedMotion && <button type="button" className="motion-toggle" data-testid="launch-motion-toggle" aria-pressed={motionPaused}
            onClick={() => setMotionPaused((paused) => !paused)}>
            <span className="icon" aria-hidden="true">{motionPaused ? "▶" : "❚❚"}</span>{motionPaused ? c.hero.motionOn : c.hero.motionOff}
          </button>}
        </div>
      </section>

      <InstallSection c={c} lang={lang} copy={copy} />

      <section className="chapter signature-chapter" aria-labelledby="cli-first-title">
        <div className="wrap">
          <span className="eyebrow">{c.first.eyebrow}</span>
          <h2 id="cli-first-title" className="section-title">{c.first.title[0]}<br /><em>{c.first.title[1]}</em></h2>
          <div className="first rise">
            {c.first.steps.map((step) => <div key={step.k} className="card">
              <span className="k">{step.k}</span><h3>{step.h}</h3><Command text={step.cmd} /><p>{step.p}</p>
            </div>)}
          </div>
        </div>
      </section>

      <section className="chapter" aria-labelledby="cli-safe-title">
        <div className="wrap split">
          <div className="copy">
            <span className="eyebrow">{c.safe.eyebrow}</span>
            <h2 id="cli-safe-title">{c.safe.title[0]}<br /><em>{c.safe.title[1]}</em></h2>
            <ul className="ticks">
              {c.safe.ticks.map(([title, body]) => <li key={title}><span>{title}<small>{body}</small></span></li>)}
            </ul>
          </div>
          <div className="term dark-zone rise">
            <div className="console-bar"><i /><i /><i /><span>~/projects/calc — tomverse doctor</span></div>
            <DoctorTerminal label={c.safe.terminalLabel} reduce={reduce} />
            <p className="example-note">{c.safe.exampleNote}</p>
          </div>
        </div>
      </section>

      <section className="chapter tight" aria-labelledby="cli-update-title">
        <div className="wrap">
          <span className="eyebrow">{c.update.eyebrow}</span>
          <h2 id="cli-update-title" className="section-title">{c.update.title}</h2>
          <div className="cards two rise">
            <div className="card"><span className="k">{c.update.update}</span><Command prompt="$" text={COMMANDS.update} copy={c.copy} copied={c.copied} /></div>
            <div className="card"><span className="k">{c.update.remove}</span><Command prompt="$" text={COMMANDS.uninstall} copy={c.copy} copied={c.copied} /><p>{c.update.removeNote}</p></div>
          </div>
        </div>
      </section>

      <section className="chapter tight" aria-labelledby="cli-connect-title">
        <div className="wrap">
          <div className="cta-band">
            <div><h2 id="cli-connect-title">{c.cta.title[0]}<br />{c.cta.title[1]}</h2><p>{c.cta.body}</p></div>
            <div className="hero-actions">
              <Link className="btn white" href={`${localizedPath(lang, "/developers")}#connect`}><span>{c.cta.connect}</span><Arrow /></Link>
              <Link className="btn ghost" href={API_KEYS_PATH}><span>{c.cta.key}</span><Arrow /></Link>
            </div>
          </div>
        </div>
      </section>
    </main>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}
