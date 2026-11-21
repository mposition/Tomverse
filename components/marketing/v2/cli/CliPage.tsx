"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/MarketingChrome";
import type { Language } from "@/lib/language";
import { localizedPath } from "@/lib/seo";
import { cliPageContent, type CliPageCopy } from "./cliPageContent";
import {
  CLI_FILES,
  CLI_OS_LIST,
  CLI_OS_NAMES,
  CLI_PACKAGE,
  CLI_RELEASE_PAGE,
  CLI_VERSION,
  CLI_WINGET_ID,
  cliFile,
  cliRecommendedFile,
  type CliArch,
  type CliFile,
  type CliOs,
  type CliPlatform,
} from "./cliRelease";
import { useCliPlatform } from "./useCliPlatform";
import "../v2-pages.css";
import "./cli-page.css";

// CLI install page (approved concept, owner 2026-11-20; installers and winget,
// owner 2026-11-21). Download URLs come from cliRelease.ts and exist once the GitHub
// Release cli-v<version> is published (apps/tomverse-cli/RELEASING.md).
// Commands, paths, file and tool names are not translated; see cliPageContent.ts.

const COMMANDS = {
  winget: `winget install ${CLI_WINGET_ID}`,
  npm: `npm install -g ${CLI_PACKAGE}`,
  // `@latest` is the update path in apps/tomverse-cli/README.md.
  npmUpdate: `npm install -g ${CLI_PACKAGE}@latest`,
  wingetUpgrade: `winget upgrade ${CLI_WINGET_ID}`,
  wingetRemove: `winget uninstall ${CLI_WINGET_ID}`,
  macRemove: "sudo rm /usr/local/bin/tomverse",
  macForget: "sudo pkgutil --forget app.tomverse.cli",
  debRemove: "sudo apt remove tomverse-cli",
  rpmRemove: "sudo dnf remove tomverse-cli",
  keyUnix: "export TOMVERSE_API_KEY=\"tvk_...\"",
  keyWin: "$env:TOMVERSE_API_KEY = \"tvk_...\"",
  check: "tomverse doctor",
} as const;
const API_KEYS_PATH = "/settings/api";

type Token = string | [cls: "add" | "p", text: string];
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
// The first run on Windows, shown beside the hero (an example, like the doctor terminal below).
const HERO_DOCTOR_ROWS: Array<[name: string, detail: string]> = [
  ["node", "Node 24 (built into this executable)"],
  ["platform", "win32 x64"],
  ["key", "tvk_ab12cd34_…"],
  ["models", "31 tool-capable models"],
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

function Arrow({ children = "↗" }: { children?: string }) {
  return <span aria-hidden="true">{children}</span>;
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

/** The terminal beside the hero: Windows install, then the first doctor run. Static, so it needs no motion control. */
function HeroTerminal({ c }: { c: CliPageCopy["hero"] }) {
  return <div className="term hero-term dark-zone" data-testid="cli-hero-terminal">
    <div className="console-bar"><i /><i /><i /><span>{c.terminalTitle}</span></div>
    <pre className="hero-pre" aria-label={c.terminalLabel}>
      <span className="p">PS&gt;</span>{` ${COMMANDS.winget}`}{"\n"}
      <span className="add">{c.installed}</span>{"\n"}
      <span className="p">PS&gt;</span>{` ${COMMANDS.check}`}
      {HERO_DOCTOR_ROWS.map(([name, detail]) => <span key={name}>{"\n"}<TokenLine tokens={[["add", "PASS"], `  ${name.padEnd(9)} ${detail}`]} /></span>)}
    </pre>
  </div>;
}

/** An installer to download: its CPU or distribution, its format, and an arrow. `rec` marks the one for this visitor. */
function FileChip({ file, label, rec = false }: { file: CliFile; label: string; rec?: boolean }) {
  return <a className={`file${rec ? " rec" : ""}`} href={file.url} aria-label={file.name} data-testid={`cli-file-${file.os}-${file.arch}-${file.kind}`}>
    <b>{label}</b><span>.{file.kind}</span><span className="ar" aria-hidden="true">⬇</span>
  </a>;
}

const ARCH_LABEL: Record<CliArch, string> = { x64: "x64", arm64: "Arm64" };

function Way({ title, rec, recLabel, children }: { title: string; rec?: boolean; recLabel: string; children: ReactNode }) {
  return <div className="way">
    <h3>{title}{rec && <span className="chip blue">{recLabel}</span>}</h3>
    {children}
  </div>;
}

function InstallSection({ c, lang, copy, platform }: { c: CliPageCopy; lang: Language; copy: { copy: string; copied: string }; platform: CliPlatform | null }) {
  // The detected system's tab is chosen first; the server render and hydration use Windows.
  const [chosen, setOs] = useState<CliOs | null>(null);
  const detectedOs = platform?.os ?? null;
  const os = chosen ?? detectedOs ?? "windows";
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + CLI_OS_LIST.length) % CLI_OS_LIST.length;
    setOs(CLI_OS_LIST[next]);
    tabs.current[next]?.focus();
  };
  // The visitor's CPU only decides a highlight on the tab of the visitor's own system.
  const archFor = (tab: CliOs): CliArch => (platform?.os === tab ? platform.arch : tab === "macos" ? "arm64" : "x64");
  const isRec = (tab: CliOs, arch: CliArch) => platform?.os === tab && platform.arch === arch;
  const { install: t } = c;
  const { req } = t;
  const winRec = (arch: CliArch) => isRec("windows", arch) || (!platform?.os && arch === "x64");
  const macRec = (arch: CliArch) => isRec("macos", arch) || (!platform?.os && arch === "arm64");
  const linuxArch = archFor("linux");
  const key = { windows: { prompt: "PS>", step: t.stepKeyWin, command: COMMANDS.keyWin }, unix: { prompt: "$", step: t.stepKeyUnix, command: COMMANDS.keyUnix } };
  const after = (kind: "windows" | "unix") => <div className="after">
    <p className="muted os-step">{key[kind].step}</p>
    <Command prompt={key[kind].prompt} text={key[kind].command} copy={copy.copy} copied={copy.copied} />
    <p className="muted os-step">{t.stepCheck}</p>
    <Command prompt={key[kind].prompt} text={COMMANDS.check} copy={copy.copy} copied={copy.copied} />
  </div>;
  const npmWay = (prompt: string) => <Way title={t.npmTitle} recLabel={t.recommended}>
    <Command prompt={prompt} text={COMMANDS.npm} copy={copy.copy} copied={copy.copied} />
  </Way>;
  const panels: Record<CliOs, ReactNode> = {
    windows: <>
      <Way title={t.windows.oneLineTitle} rec recLabel={t.recommended}>
        <p>{t.windows.oneLineBody}</p>
        <Command prompt="PS>" text={COMMANDS.winget} copy={copy.copy} copied={copy.copied} />
      </Way>
      <Way title={t.windows.installerTitle} recLabel={t.recommended}>
        <p>{t.windows.installerBody}</p>
        <div className="files">
          {(["x64", "arm64"] as const).map((arch) => <FileChip key={arch} file={cliFile("windows", arch, "msi")} label={ARCH_LABEL[arch]} rec={winRec(arch)} />)}
        </div>
        <p className="warn" role="note">{t.windows.smartScreen[0]}<b>{t.windows.smartScreen[1]}</b>{t.windows.smartScreen[2]}</p>
      </Way>
      {npmWay("PS>")}
      {after("windows")}
    </>,
    macos: <>
      <Way title={t.macos.installerTitle} rec recLabel={t.recommended}>
        <p>{t.macos.installerBody}</p>
        <div className="files">
          {([["arm64", "Apple silicon"], ["x64", "Intel"]] as const).map(([arch, label]) => <FileChip key={arch} file={cliFile("macos", arch, "pkg")} label={label} rec={macRec(arch)} />)}
        </div>
      </Way>
      {npmWay("$")}
      {after("unix")}
    </>,
    linux: <>
      <Way title={t.linux.packageTitle} rec recLabel={t.recommended}>
        <p>{t.linux.packageBody}</p>
        {([["deb", "Ubuntu · Debian", "sudo apt install"], ["rpm", "Fedora · RHEL", "sudo dnf install"]] as const).map(([kind, distro, installCommand]) => <div key={kind} className="distro">
          <p className="distro-name">{distro}</p>
          <div className="files">
            {(["x64", "arm64"] as const).map((arch) => <FileChip key={arch} file={cliFile("linux", arch, kind)} label={ARCH_LABEL[arch]} rec={kind === "deb" && (isRec("linux", arch) || (!platform?.os && arch === "x64"))} />)}
          </div>
          <Command prompt="$" text={`${installCommand} ./${cliFile("linux", linuxArch, kind).name}`} copy={copy.copy} copied={copy.copied} />
        </div>)}
      </Way>
      {npmWay("$")}
      {after("unix")}
    </>,
  };
  return <section id="install" className="chapter after-hero" aria-labelledby="cli-install-title">
    <div className="wrap">
      <span className="eyebrow">{t.eyebrow}</span>
      <h2 id="cli-install-title" className="section-title">{t.title}</h2>
      <div className="install rise">
        <div className="panel glow">
          <div className="seg os-tabs" role="tablist" aria-label={t.osLabel}>
            {CLI_OS_LIST.map((tab, i) => <button key={tab} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab"
              id={`cli-os-${tab}`} aria-controls={`cli-os-panel-${tab}`} aria-selected={os === tab} tabIndex={os === tab ? 0 : -1}
              data-os={tab} onClick={() => setOs(tab)} onKeyDown={(event) => onKey(event, i)}>
              {CLI_OS_NAMES[tab]}{detectedOs === tab && <span className="det"> · {t.detected}</span>}
            </button>)}
          </div>
          {CLI_OS_LIST.map((tab) => <div key={tab} className={`os-panel${os === tab ? " on" : ""}`} id={`cli-os-panel-${tab}`} role="tabpanel"
            aria-labelledby={`cli-os-${tab}`} hidden={os !== tab} data-panel={tab}>
            {panels[tab]}
          </div>)}
          <p className="note">{t.keyNote}</p>
        </div>
        <div className="panel">
          <p className="panel-label">{t.reqTitle}</p>
          <div className="req">
            <div><span>{req.os[0]}</span><b>{req.os[1]}</b></div>
            <div><span>{req.node[0]}</span><b>{req.node[1]}</b></div>
            <div><span>{req.plan[0]}</span><b><Link href={localizedPath(lang, "/pricing")}>{req.plan[1]}</Link></b></div>
            <div><span>{req.key[0]}</span><b><Link href={API_KEYS_PATH}>{req.key[1]}</Link></b></div>
            <div><span>{req.tools[0]}</span><b>{req.tools[1]}</b></div>
          </div>
          <p className="note">{t.capNote}</p>
        </div>
      </div>
    </div>
  </section>;
}

function DownloadsSection({ c }: { c: CliPageCopy }) {
  const { downloads: d } = c;
  const [winX64, winArm, macArm, macX64, debX64, debArm, rpmX64, rpmArm] = CLI_FILES;
  const linkRow = (files: CliFile[]) => files.map((file) => <a key={file.name} href={file.url} data-testid={`cli-table-${file.os}-${file.arch}-${file.kind}`}>{file.name}</a>);
  const shaRow = (files: CliFile[]) => files.map((file) => <a key={file.name} href={file.sha256Url} aria-label={`${file.name}.sha256`}>.sha256</a>);
  const rows: Array<{ os: string; cpu: string; files: CliFile[]; format: string }> = [
    { os: "Windows 10·11", cpu: "x64", files: [winX64], format: d.installer },
    { os: "Windows 11", cpu: "Arm64", files: [winArm], format: d.installer },
    { os: "macOS", cpu: "Apple silicon", files: [macArm], format: d.installerNotarized },
    { os: "macOS", cpu: "Intel", files: [macX64], format: d.installerNotarized },
    { os: "Ubuntu · Debian", cpu: "x64 · Arm64", files: [debX64, debArm], format: d.package },
    { os: "Fedora · RHEL", cpu: "x64 · Arm64", files: [rpmX64, rpmArm], format: d.package },
  ];
  return <section className="chapter tight" aria-labelledby="cli-downloads-title">
    <div className="wrap">
      <span className="eyebrow">{d.eyebrow}</span>
      <h2 id="cli-downloads-title" className="section-title">{d.title}</h2>
      <div className="panel dl-panel rise">
        <table className="dl-table" data-testid="cli-downloads">
          <thead><tr><th>{d.cols.os}</th><th>{d.cols.cpu}</th><th>{d.cols.file}</th><th>{d.cols.format}</th><th>{d.cols.sha}</th></tr></thead>
          <tbody>
            {rows.map((row) => <tr key={`${row.os}-${row.cpu}`}>
              <td data-label={d.cols.os}>{row.os}</td>
              <td data-label={d.cols.cpu}>{row.cpu}</td>
              <td data-label={d.cols.file} className="files-cell">{linkRow(row.files)}</td>
              <td data-label={d.cols.format} className="m">{row.format}</td>
              <td data-label={d.cols.sha} className="files-cell">{shaRow(row.files)}</td>
            </tr>)}
            <tr>
              <td data-label={d.cols.os}>{d.all}</td>
              <td data-label={d.cols.cpu}>—</td>
              <td data-label={d.cols.file} className="m">{d.archiveNote}</td>
              <td data-label={d.cols.format} className="m">{d.archive}</td>
              <td data-label={d.cols.sha}><a href={CLI_RELEASE_PAGE} data-testid="cli-release-link">{d.release}</a></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>;
}

export function CliPage() {
  const { lang } = useLanguage();
  const c = cliPageContent[lang];
  const platform = useCliPlatform();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [motionPaused, setMotionPaused] = useState(false);
  // One switch for every moving part: the OS preference or the hero's pause button.
  const reduce = prefersReducedMotion || motionPaused;
  const copy = { copy: c.copy, copied: c.copied };
  // A download button only for a desktop system there is an installer for; a phone or tablet, an
  // unknown system and the static render get the way to the install section instead.
  const recommended = platform?.os ? cliRecommendedFile(platform.os, platform.arch) : null;
  const mobile = platform?.mobile === true;
  const metaItems = [CLI_OS_LIST.map((os) => CLI_OS_NAMES[os]).join(" · "), c.hero.noNode, c.hero.plan];

  return <div className="tv-page" lang={lang} data-testid="cli-page" data-motion={reduce ? "paused" : "running"}>
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" />
    <main id="top">
      <section className="page-hero dark-zone" aria-labelledby="cli-title">
        <HeroVideo reduce={reduce} />
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="crumb">
              <Link href={localizedPath(lang, "/")}>{c.crumb.home}</Link> / <Link href={localizedPath(lang, "/developers")}>{c.crumb.developers}</Link> / <b aria-current="page">{c.crumb.current}</b>
            </p>
            <h1 id="cli-title" data-testid="cli-title">{c.hero.title[0]}<br /><em>{c.hero.title[1]}</em></h1>
            <p className="hero-lede">{c.hero.lede}</p>
            <div className="hero-actions" data-testid="cli-hero-actions">
              {recommended
                ? <a className="btn" href={recommended.url} data-testid="cli-download" data-os={recommended.os} data-arch={recommended.arch}>
                  <span className="btn-text"><b>{c.hero.downloadFor.replace("{os}", CLI_OS_NAMES[recommended.os])}</b><small>{recommended.name}</small></span>
                  <Arrow>⬇</Arrow>
                </a>
                : <a className={`btn${mobile ? " block" : ""}`} href="#install" data-testid="cli-show-install"><span>{c.hero.showInstall}</span><Arrow>↓</Arrow></a>}
              {recommended && <a className="btn ghost" href="#install" data-testid="cli-other-os"><span>{c.hero.otherOs}</span><Arrow>↓</Arrow></a>}
            </div>
            {mobile && <p className="hero-note" data-testid="cli-mobile-note">{c.hero.mobileNote}</p>}
            <p className="hero-note ver">
              <span className="chip blue">v{CLI_VERSION}</span>
              {metaItems.map((item) => <span key={item} className="meta-item"><span aria-hidden="true">·</span> {item}</span>)}
              <span className="chip green">{c.hero.notarized}</span>
            </p>
            {!prefersReducedMotion && <button type="button" className="motion-toggle" data-testid="launch-motion-toggle" aria-pressed={motionPaused}
              onClick={() => setMotionPaused((paused) => !paused)}>
              <span className="icon" aria-hidden="true">{motionPaused ? "▶" : "❚❚"}</span>{motionPaused ? c.hero.motionOn : c.hero.motionOff}
            </button>}
          </div>
          <HeroTerminal c={c.hero} />
        </div>
      </section>

      <InstallSection c={c} lang={lang} copy={copy} platform={platform} />

      <DownloadsSection c={c} />

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
          <div className="cards rise" data-testid="cli-update-cards">
            <div className="card"><h3>Windows</h3>
              <div className="r"><span>{c.update.windows.upgrade}</span><code>{COMMANDS.wingetUpgrade}</code></div>
              <div className="r"><span>{c.update.windows.remove}</span><code>{COMMANDS.wingetRemove}</code></div>
              <div className="r"><span>{c.update.windows.msi}</span><code>{c.update.windows.msiHow}</code></div>
            </div>
            <div className="card"><h3>macOS</h3>
              <div className="r"><span>{c.update.macos.update}</span><code>{c.update.macos.updateHow}</code></div>
              <div className="r"><span>{c.update.macos.remove}</span><code>{COMMANDS.macRemove}</code></div>
              <div className="r"><span /><code>{COMMANDS.macForget}</code></div>
            </div>
            <div className="card"><h3>Linux · npm</h3>
              <div className="r"><span>{c.update.linux.deb}</span><code>{COMMANDS.debRemove}</code></div>
              <div className="r"><span>{c.update.linux.rpm}</span><code>{COMMANDS.rpmRemove}</code></div>
              <div className="r"><span>{c.update.linux.npm}</span><code>{COMMANDS.npmUpdate}</code></div>
            </div>
          </div>
          <p className="note">{c.update.removeNote}</p>
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
