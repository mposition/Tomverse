"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { useModelCatalog } from "@/components/ModelCatalogProvider";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { localizedPath } from "@/lib/seo";
import { workspaceDestination } from "@/lib/productEntryDestination";
import { CLI_DOWNLOAD_PATH, DEVELOPERS_PATH } from "@/lib/marketingRoutes";
import type { Language } from "@/lib/language";
import { MarketingFooter, MarketingHeader } from "./MarketingChrome";
import { useMarketingChatEntry } from "./MarketingChatAvailability";
import { homeV2Content, type HomeV2Copy } from "./home/homeV2Content";
import type { LandingSurfaceCopy } from "./landingExperimentBundles";
import "./home/home-v2.css";

// Homepage V2 (approved concept, owner 2026-11-20). `variantCopy` is a
// landing-experiment variant (policy 9.1): headline, subtitle and primary call
// to action only.
type LaunchHomepageProps = { reviewInfoHref: string; variantCopy?: LandingSurfaceCopy };

const MODEL_ICON = (name: string) => `/model-icons/${name}.png`;
const PLUGIN_ICON = (name: string) => `/plugins/providers/${name}`;
const API_BASE = "https://tomverse.app/api/v1";
const ANTHROPIC_BASE = "https://tomverse.app/api/anthropic";
const MASKED_KEY = "tvk_••••••••";

/** Fallback when the catalogue has not loaded: the count on 2026-11-19. */
const FALLBACK_PROVIDER_COUNT = 12;

const heroStack = ["chatgpt", "claude", "gemini", "grok", "deepseek", "perplexity"];
const providerTiles: Array<{ title: string; icon?: string; target?: boolean }> = [
  { title: "OpenAI", icon: "chatgpt" }, { title: "Anthropic", icon: "claude" }, { title: "Google", icon: "gemini", target: true },
  { title: "xAI", icon: "grok" }, { title: "Perplexity", icon: "perplexity" }, { title: "Mistral", icon: "mistral" },
  { title: "DeepSeek", icon: "deepseek" }, { title: "Qwen", icon: "qwen" }, { title: "Moonshot", icon: "kimi" },
  { title: "Zhipu", icon: "zhipu" }, { title: "MiniMax" }, { title: "Cohere", icon: "cohere" },
];
const sourceIcons = ["chatgpt", "claude", "gemini", "perplexity"];
const askIcons = ["github.png", "notion.png", "slack.png", "sentry.svg"];
const pluginRows: Array<Array<[string, string]>> = [
  [["GitHub", "github.png"], ["Notion", "notion.png"], ["Slack", "slack.png"], ["Google Drive", "google-drive.png"], ["Gmail", "gmail.png"], ["Google Calendar", "google-calendar.png"], ["Figma", "figma.png"], ["Linear", "linear.png"]],
  [["Stripe", "stripe.png"], ["Sentry", "sentry.svg"], ["Canva", "canva.png"], ["Vercel", "vercel.png"], ["Supabase", "supabase.png"], ["Atlassian", "atlassian.png"], ["HubSpot", "hubspot.png"], ["Zapier", "zapier.png"]],
];
const manualPicks: Array<[string, string, string]> = [
  ["chatgpt", "GPT 6.2 Sol", "OpenAI"], ["claude", "Claude Fable 5.2", "Anthropic"], ["gemini", "Gemini 4 Argon", "Google"], ["grok", "Grok 4.7", "xAI"],
];
const indexAnchors = ["chat", "continue", "plugins", "review", "mobile", "api", "cli", "plans"] as const;

const fill = (text: string, n: number) => text.replaceAll("{n}", String(n));

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

/* ---------- Hero ---------- */

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
    <img src="/marketing/v2/hero.jpg" alt="" />
    <video ref={ref} src="/marketing/v2/hero.mp4" poster="/marketing/v2/hero.jpg" autoPlay={!reduce} muted loop playsInline preload="auto" />
  </div>;
}

// Nine light fibres that converge into one: "Many AIs. One Tomverse."
const THREADS_FRAGMENT = [
  "precision highp float;uniform vec2 r;uniform float t;",
  "void main(){",
  " vec2 uv=gl_FragCoord.xy/r; float x=uv.x; vec3 col=vec3(0.);",
  " float spread=pow(1.-smoothstep(0.,.94,x),1.35);",
  " for(int i=0;i<9;i++){",
  "  float fi=float(i); float o=(fi-4.)/4.;",
  "  float w=.30*o+.10*sin(x*5.2+t*.55+fi*1.7)+.05*sin(x*11.-t*.8+fi*.9);",
  "  float y=.5+spread*w+.015*sin(x*3.1-t*.35)*spread;",
  "  float d=abs(uv.y-y)*r.y;",
  "  float th=mix(.55,1.1,1.-spread);",
  "  float core=exp(-d*d/(th*th*1.6));",
  "  float glow=.9/(d*.55+1.);",
  "  float spark=pow(.5+.5*sin(x*26.-t*2.4+fi*2.1),14.);",
  "  vec3 c=mix(vec3(.08,.36,.98),vec3(.62,.75,1.),fract(fi*.37+.2));",
  "  float k=(core*.55+glow*.045)*(.75+.9*spark*spread);",
  "  col+=c*k;",
  " }",
  " float conv=smoothstep(.78,1.,x); col+=vec3(.85,.9,1.)*conv*exp(-pow(abs(uv.y-.5)*r.y,2.)/1.8)*.9;",
  " col*=smoothstep(0.,.06,x)*smoothstep(1.,.985,x)*1.;",
  " col=1.-exp(-col*1.25);",
  " float a=clamp(max(col.r,max(col.g,col.b)),0.,1.);",
  " gl_FragColor=vec4(col,a);",
  "}",
].join("\n");

function ThreadsBand({ many, one, reduce }: { many: string; one: string; reduce: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    const host = hostRef.current, canvas = canvasRef.current;
    if (!host || !canvas) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) { setFallback(true); return; }
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error("shader");
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    let program: WebGLProgram | null = null;
    try {
      program = gl.createProgram();
      if (!program) throw new Error("program");
      gl.attachShader(program, shader(gl.VERTEX_SHADER, "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}"));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, THREADS_FRAGMENT));
      gl.linkProgram(program);
    } catch { setFallback(true); return; }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uR = gl.getUniformLocation(program, "r"), uT = gl.getUniformLocation(program, "t");
    const draw = (time: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(host.clientWidth * dpr), h = Math.round(host.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform2f(uR, canvas.width, canvas.height); gl.uniform1f(uT, time);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    if (reduce) {
      const still = () => draw(4);
      still();
      window.addEventListener("resize", still);
      return () => window.removeEventListener("resize", still);
    }
    let raf = 0, visible = true;
    const start = performance.now();
    const loop = (now: number) => { draw((now - start) / 1000); raf = visible ? requestAnimationFrame(loop) : 0; };
    const observer = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
      if (visible && !raf) raf = requestAnimationFrame(loop);
    });
    observer.observe(host);
    raf = requestAnimationFrame(loop);
    return () => { observer.disconnect(); cancelAnimationFrame(raf); };
  }, [reduce]);
  return <div className="ribbon-wrap wrap" aria-hidden="true">
    <div className="threads">
      <span className="threads-label">{many}</span>
      <div ref={hostRef} className={`threads-canvas${fallback ? " fallback" : ""}`}>{!fallback && <canvas ref={canvasRef} />}</div>
      <span className="threads-label one">{one}</span>
    </div>
  </div>;
}

/* ---------- Smart Adaptive ---------- */

function AdaptiveDemo({ copy, n, reduce }: { copy: HomeV2Copy["adaptive"]; n: number; reduce: boolean }) {
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  // The scan walks the tiles in timer callbacks; at rest (and with reduced
  // motion) it has finished, so the picked provider is marked.
  const [scanStep, setScanStep] = useState(providerTiles.length);
  const autoCycle = useRef(true);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (mode !== "auto" || reduce) return;
    let i = 0;
    const timer = window.setInterval(() => {
      setScanStep(i);
      i += 1;
      if (i > providerTiles.length) window.clearInterval(timer);
    }, 90);
    return () => window.clearInterval(timer);
  }, [mode, reduce]);
  const scanDone = reduce || scanStep >= providerTiles.length;
  const scanIndex = scanDone ? -1 : scanStep;
  const chosen = scanDone;

  useEffect(() => {
    if (reduce) return;
    const timer = window.setInterval(() => {
      if (autoCycle.current) setMode((current) => current === "auto" ? "manual" : "auto");
    }, 6500);
    return () => window.clearInterval(timer);
  }, [reduce]);

  const choose = (next: "auto" | "manual") => { autoCycle.current = false; setMode(next); };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const other = (index + 1) % 2;
    choose(other === 0 ? "auto" : "manual");
    tabs.current[other]?.focus();
  };
  const modes = [["auto", copy.modeAuto], ["manual", copy.modeManual]] as const;

  return <div className="adaptive rise">
    <div className="refine">
      <p className="q-original">{copy.original}</p>
      <span className="refiner-tag">{copy.refinerTag}</span>
      <p className="q-refined">{copy.refined}</p>
      <div className="refine-changes" aria-label={copy.changesLabel}>
        {copy.changes.map(([label, body]) => <p key={label}><b>{label}</b>{body}</p>)}
      </div>
    </div>
    <div className="selector">
      <div className="mode" role="tablist" aria-label={copy.modeLabel}>
        {modes.map(([key, label], i) => <button key={key} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab"
          id={`home-mode-${key}`} aria-controls={`home-panel-${key}`} aria-selected={mode === key} tabIndex={mode === key ? 0 : -1}
          onClick={() => choose(key)} onKeyDown={(event) => onKey(event, i)}>{label}</button>)}
      </div>
      <div className="mode-stack">
        <div className={`mode-panel${mode === "auto" ? "" : " off"}`} id="home-panel-auto" role="tabpanel" aria-labelledby="home-mode-auto" aria-hidden={mode !== "auto"}>
          <h3>{copy.autoTitle}</h3>
          <div className="meter">
            {copy.meter.map(([label, value], i) => <div key={label} className="meter-row">
              <span>{label}</span><span className="bar"><i style={{ width: ["64%", "38%", "82%", "26%"][i], animationDelay: `${i * 0.2}s` }} /></span><b>{value}</b>
            </div>)}
          </div>
          <p className="providers-label">{fill(copy.providersLabel, n)}</p>
          <div className="provider-grid">
            {providerTiles.map((tile, i) => <span key={tile.title} title={tile.title}
              className={`prov${tile.icon ? "" : " mm"}${tile.target ? " pick-target" : ""}${scanIndex === i ? " scan" : ""}${tile.target && chosen ? " chosen" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {tile.icon ? <img src={MODEL_ICON(tile.icon)} alt={tile.title} /> : "MM"}
            </span>)}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <p className="pick">{copy.pick[0]} <b><img src={MODEL_ICON("gemini")} alt="" />Gemini</b> {copy.pick[1]}</p>
        </div>
        <div className={`mode-panel${mode === "manual" ? "" : " off"}`} id="home-panel-manual" role="tabpanel" aria-labelledby="home-mode-manual" aria-hidden={mode !== "manual"}>
          <h3>{copy.manualTitle}</h3>
          <p className="say">{copy.say}</p>
          <div className="picker" aria-label={copy.pickerLabel}>
            {manualPicks.map(([icon, name, provider], i) => <div key={name} className={`picker-row${i === 0 ? " on" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <span className="prov"><img src={MODEL_ICON(icon)} alt="" /></span>
              <span><strong>{name}</strong><small>{provider}</small></span>
              {i === 0 ? <span className="check" aria-hidden="true">✓</span> : <span className="radio" aria-hidden="true" />}
            </div>)}
            <div className="picker-row dim"><span className="prov plus">＋</span><span><strong>{copy.otherProviders}</strong><small>DeepSeek · Mistral · Qwen · Kimi …</small></span><span className="more" aria-hidden="true">›</span></div>
          </div>
        </div>
      </div>
      <p className="outcome">{copy.outcome}</p>
    </div>
  </div>;
}

/* ---------- API console ---------- */

type Token = string | [cls: "c" | "k" | "s" | "g" | "p" | "d" | "y" | "add" | "del", text: string];
type Config = { file: string; lines: Token[][] };

const apiConfigs = (c: HomeV2Copy["api"]["console"]): Record<string, Config> => ({
  codex: { file: "~/.codex/config.toml", lines: [
    [["c", c.codexComment]], ["[model_providers.tomverse]"],
    [["k", "name"], " = ", ["s", "\"Tomverse\""]], [["k", "base_url"], " = ", ["s", `"${API_BASE}"`]],
    [["k", "env_key"], " = ", ["s", "\"TOMVERSE_API_KEY\""]], [["k", "wire_api"], " = ", ["s", "\"responses\""]],
    [], ["$ codex --profile tomverse"], [["g", c.codexOk]],
  ] },
  claude: { file: c.claudeFile, lines: [
    [["c", c.claudeComment]],
    [["k", "export"], " ANTHROPIC_BASE_URL=", ["s", `"${ANTHROPIC_BASE}"`]],
    [["k", "export"], " ANTHROPIC_AUTH_TOKEN=", ["s", `"${MASKED_KEY}"`]],
    [["k", "export"], " ANTHROPIC_MODEL=", ["s", `"${c.chosenModel}"`]],
    [], ["$ claude"], [["g", c.claudeOk]],
  ] },
  vscode: { file: "Chat: Manage Language Models", lines: [
    [["c", "# Add Models → Custom Endpoint"]], ["Endpoint   ", ["s", `${API_BASE}/chat/completions`]], ["Model      ", ["s", "smart-adaptive"]],
    [], [["c", c.vscodeKeyNote]], [["g", c.vscodeOk]],
  ] },
  cursor: { file: "Cursor › Settings › Models", lines: [
    ["OpenAI API Key             ", ["s", MASKED_KEY]], ["Override OpenAI Base URL   ", ["s", API_BASE]],
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

function CodeLines({ lines }: { lines: Token[][] }) {
  return <>{lines.map((line, i) => <span key={i}><TokenLine tokens={line} />{i < lines.length - 1 ? "\n" : ""}</span>)}</>;
}

function ApiSection({ copy, n, reduce, lang }: { copy: HomeV2Copy["api"]; n: number; reduce: boolean; lang: Language }) {
  const configs = apiConfigs(copy.console);
  const clients: Array<{ key: keyof typeof configs; name: string; sub: string; icon?: string }> = [
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
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? (i + clients.length - 1) % clients.length : -1;
    if (next < 0) return;
    event.preventDefault(); pick(next); tabs.current[next]?.focus();
  };
  const active = clients[selected];
  const config = configs[active.key];
  return <section id="api" className="chapter" aria-labelledby="home-api-title">
    <div className="wrap">
      <div className="chapter-head">
        <div><span className="eyebrow">{copy.eyebrow}</span><h2 id="home-api-title"><Title lines={copy.title} /></h2></div>
        <p>{fill(copy.body, n)} <Link href={localizedPath(lang, DEVELOPERS_PATH)} style={{ color: "var(--brand-hi)" }}>{copy.devLink} ↗</Link></p>
      </div>
      <div className="api rise">
        <div className="clients" role="tablist" aria-label={copy.toolsLabel}>
          {clients.map((client, i) => <button key={client.key} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab"
            id={`home-api-tab-${client.key}`} aria-controls="home-api-panel" aria-selected={selected === i} tabIndex={selected === i ? 0 : -1}
            className={`client${client.icon ? "" : " any"}`} onClick={() => pick(i)} onKeyDown={(event) => onKey(event, i)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {client.icon ? <span className="tile"><img src={client.icon} alt="" /></span> : <span className="mono any-mark">{"{ }"}</span>}
            <span><strong>{client.name}</strong><small>{client.sub}</small></span>
          </button>)}
        </div>
        <div className="console dark-zone" role="tabpanel" id="home-api-panel" aria-labelledby={`home-api-tab-${active.key}`}>
          <div className="console-bar"><i /><i /><i /><span>{config.file}</span></div>
          <pre><CodeLines lines={config.lines} /></pre>
          <div className="api-facts">{copy.facts.map(([label, value]) => <div key={label}><b>{label}</b><span>{value}</span></div>)}</div>
        </div>
      </div>
      <p className="note">{copy.note}</p>
    </div>
  </section>;
}

/* ---------- CLI terminal ---------- */

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
  // At rest (and with reduced motion) the whole session is visible; once the
  // terminal is on screen it replays once as a typed session.
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

/* ---------- Page ---------- */

function Action({ href, children, className = "btn", testId, location, id }: {
  href: string; children: ReactNode; className?: string; testId?: string; location?: string; id?: string;
}) {
  return <Link href={href} id={id} className={className} data-testid={testId}
    onClick={location ? () => trackProductEvent("cta_start_click", 0, { cta_location: location }) : undefined}>
    <span>{children}</span><Arrow />
  </Link>;
}

export default function LaunchHomepage({ reviewInfoHref, variantCopy }: LaunchHomepageProps) {
  const { lang } = useLanguage();
  const copy = homeV2Content[lang];
  const { publicModels } = useModelCatalog();
  const providerCount = new Set(publicModels.map((model) => model.provider)).size;
  const n = providerCount >= 3 ? providerCount : FALLBACK_PROVIDER_COUNT;
  const { isAuthenticated, guestTrialAvailable, chatHref } = useMarketingChatEntry();
  // The hero and final comparison CTAs keep Review's guest preview entry for guests
  // (docs/ui-contracts/chat-product-switcher.md section 3).
  const reviewHref = workspaceDestination({ chatSurfaceAvailable: false, lang, isAuthenticated });
  const prefersReducedMotion = usePrefersReducedMotion();
  const [motionPaused, setMotionPaused] = useState(false);
  // One switch for every moving part: the OS preference or the hero's pause button.
  const reduce = prefersReducedMotion || motionPaused;
  const landingTracked = useRef(false);
  useEffect(() => {
    if (landingTracked.current) return;
    landingTracked.current = true;
    trackProductEvent("landing_view");
  }, []);

  const heroTitle: [string, string] = variantCopy?.title ? [variantCopy.title[0], variantCopy.title[1]] : copy.hero.title;
  const heroBody = variantCopy?.body ?? fill(copy.hero.body, n);
  const t = copy;

  return <div className="tv-home" lang={lang} data-testid="launch-homepage" data-motion={reduce ? "paused" : "running"}
    data-guest-chat-trial-available={guestTrialAvailable ? "true" : "false"}>
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" chatHref={chatHref} reviewInfoHref={reviewInfoHref} />
    <main id="top">
      <section className="hero dark-zone" aria-labelledby="landing-hero-title">
        <HeroVideo reduce={reduce} />
        <div className="wrap">
          <span className="eyebrow eyebrow-stack">
            <span className="ai-stack" aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {heroStack.map((icon) => <img key={icon} src={MODEL_ICON(icon)} alt="" />)}<i className="more">+{Math.max(n - heroStack.length, 0)}</i>
            </span>{fill(t.hero.eyebrow, n)}
          </span>
          <h1 id="landing-hero-title" data-testid="landing-hero-title" style={{ marginTop: 28 }}><span>{heroTitle[0]}</span><span className="blue">{heroTitle[1]}</span></h1>
          <p className="hero-lede">{heroBody}</p>
          <div className="hero-actions">
            {/* #landing-hero-primary is the landing experiment's conversion target (LandingExperimentBeacon). */}
            <Action href={reviewHref} id="landing-hero-primary" testId="landing-primary-cta" location="landing_hero_review">{variantCopy?.cta ?? t.hero.primary}</Action>
            <Action href={chatHref} className="btn ghost" testId="landing-secondary-cta" location="landing_hero_chat">{t.hero.secondary}</Action>
          </div>
          {!isAuthenticated && <p className="hero-note" data-testid="landing-hero-signup-note">{t.hero.note}</p>}
          {!prefersReducedMotion && <button type="button" className="motion-toggle" data-testid="launch-motion-toggle" aria-pressed={motionPaused}
            onClick={() => setMotionPaused((paused) => !paused)}>
            <span className="icon" aria-hidden="true">{motionPaused ? "▶" : "❚❚"}</span>{motionPaused ? t.hero.motionOn : t.hero.motionOff}
          </button>}
        </div>
        <ThreadsBand many={t.hero.threadsMany} one={t.hero.threadsOne} reduce={reduce} />
      </section>

      <section className="chapter" style={{ paddingTop: 48 }} aria-labelledby="home-index-title">
        <div className="wrap">
          <div className="chapter-head">
            <div><span className="eyebrow">{t.index.eyebrow}</span><h2 id="home-index-title"><Title lines={t.index.title} /></h2></div>
            <p>{t.index.body}</p>
          </div>
          <div className="index-grid rise">
            {t.index.cards.map((card, i) => <a key={indexAnchors[i]} href={`#${indexAnchors[i]}`} className={`cap${indexAnchors[i] === "review" ? " lead sig" : ""}`}>
              <span className="k">{card.k}</span><h3>{card.h}</h3><p>{card.p}</p><span className="arrow">↗</span>
            </a>)}
          </div>
        </div>
      </section>

      <section id="chat" className="chapter paper" aria-labelledby="home-adaptive-title">
        <div className="wrap">
          <div className="chapter-head">
            <div><span className="eyebrow">{t.adaptive.eyebrow}</span><h2 id="home-adaptive-title"><Title lines={t.adaptive.title} /></h2></div>
            <p>{t.adaptive.body}</p>
          </div>
          <AdaptiveDemo copy={t.adaptive} n={n} reduce={reduce} />
          <p className="note">{t.adaptive.note}</p>
        </div>
      </section>

      <section id="continue" className="chapter" aria-labelledby="home-continue-title">
        <div className="wrap">
          <div className="chapter-head">
            <div><span className="eyebrow">{t.continue.eyebrow}</span><h2 id="home-continue-title"><Title lines={t.continue.title} /></h2></div>
            <p>{t.continue.body}</p>
          </div>
          <div className="continue-stage rise">
            <div className="sources">
              {t.continue.sources.map((source, i) => <div key={source.name} className={`source${source.file ? "" : " soon"}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <span className="tile"><img src={MODEL_ICON(sourceIcons[i])} alt={source.name} /></span>
                <div><strong>{source.name}</strong><small>{source.small}</small></div>
                <span className="file">{source.file || t.continue.soon}</span>
              </div>)}
            </div>
            <div className="thread" aria-label={t.continue.threadLabel}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <div className="thread-head"><strong>{t.continue.threadTitle}</strong><span className="badge"><img src={MODEL_ICON("chatgpt")} alt="" />{t.continue.badge}</span></div>
              <div className="imported">{t.continue.imported.map(([who, text], i) => <p key={i}><b>{who === "me" ? t.continue.me : t.continue.ai}</b>{text}</p>)}</div>
              <div className="divider">{t.continue.divider}</div>
              <div className="bubble me">{t.continue.followup}</div>
              <div className="bubble ai">{t.continue.answer}</div>
              <div className="typing" aria-hidden="true"><i /><i /><i /></div>
            </div>
          </div>
          <p className="note">{t.continue.note}</p>
        </div>
      </section>

      <section id="plugins" className="chapter" aria-labelledby="home-plugins-title">
        <div className="wrap">
          <div className="chapter-head">
            <div><span className="eyebrow">{t.plugins.eyebrow}</span><h2 id="home-plugins-title"><Title lines={t.plugins.title} /></h2></div>
            <p>{t.plugins.body}</p>
          </div>
        </div>
        <div className="wrap">
          <div className="plug-asks rise" aria-label={t.plugins.asksLabel}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {t.plugins.asks.map((ask, i) => <span key={i} className="ask"><img src={PLUGIN_ICON(askIcons[i])} alt="" />{ask}</span>)}
          </div>
          <div className="sig-points rise" style={{ gridTemplateColumns: "repeat(4,minmax(0,1fr))" }}>
            {t.plugins.points.map(([title, body]) => <div key={title}><b>{title}</b><span>{body}</span></div>)}
          </div>
          <div className="plugins rise">
            {pluginRows.map((row, r) => <div key={r} className={`plug-row${r === 1 ? " rev" : ""}`} aria-hidden="true">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {[...row, ...row].map(([name, icon], i) => <span key={`${name}-${i}`} className="plug"><span className="tile"><img src={PLUGIN_ICON(icon)} alt="" /></span>{name}</span>)}
            </div>)}
            <div className="plugins-foot">
              <span className="mcp-card">{t.plugins.customServer} <code>https://mcp.my-company.dev/sse</code></span>
              <span className="mcp-card">{t.plugins.count}</span>
            </div>
          </div>
          <p className="note">{t.plugins.note}</p>
        </div>
      </section>

      <section id="create" className="chapter" aria-labelledby="home-create-title">
        <div className="wrap">
          <div className="chapter-head">
            <div><span className="eyebrow">{t.create.eyebrow}</span><h2 id="home-create-title"><Title lines={t.create.title} /></h2></div>
            <p>{t.create.body}</p>
          </div>
          <div className="create-grid rise">
            <article className="create-card">
              <div className="cv img-compare" aria-hidden="true">
                <div className="gen g1"><span>GPT Image 2</span></div>
                <div className="gen g2 pick"><span>Nano Banana 2</span><i>✓</i></div>
                <div className="gen g3"><span>Grok Imagine</span></div>
              </div>
              <span className="k">{t.create.cards[0].k}</span><h3>{t.create.cards[0].h}</h3><p>{t.create.cards[0].p}</p>
            </article>
            <article className="create-card">
              <div className="cv photo-edit" aria-hidden="true">
                <div className="ph before"><b>{t.create.original}</b></div>
                <div className="ph after"><b>{t.create.edited}</b></div>
                <span className="edit-say">{t.create.editSay}</span>
              </div>
              <span className="k">{t.create.cards[1].k}</span><h3>{t.create.cards[1].h}</h3><p>{t.create.cards[1].p}</p>
            </article>
            <article className="create-card">
              <div className="cv convert" aria-hidden="true">
                <div className="files-in"><span className="fi jpg">JPG</span><span className="fi jpg">JPG</span><span className="fi pdf">PDF</span></div>
                <span className="arrow-flow">→</span>
                <div className="files-out"><span className="fi pdf big">PDF</span></div>
              </div>
              <span className="k">{t.create.cards[2].k}</span><h3>{t.create.cards[2].h}</h3><p>{t.create.cards[2].p}</p>
            </article>
          </div>
          <p className="note">{t.create.note}</p>
        </div>
      </section>

      <section id="review" className="chapter signature-chapter" aria-labelledby="home-review-title">
        <div className="wrap">
          <div className="chapter-head">
            <div>
              <span className="eyebrow eyebrow-stack">
                <span className="ai-stack" aria-hidden="true">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {heroStack.map((icon) => <img key={icon} src={MODEL_ICON(icon)} alt="" />)}<i className="more">+{Math.max(n - heroStack.length, 0)}</i>
                </span>{t.review.eyebrow}
              </span>
              <h2 id="home-review-title"><Title lines={t.review.title} /></h2>
            </div>
            <p>{t.review.body}</p>
          </div>
          <div className="sig-points rise">{t.review.points.map(([title, body]) => <div key={title}><b>{title}</b><span>{body}</span></div>)}</div>
          <figure className="demo-frame rise">
            <div className="demo-bar" aria-hidden="true"><i /><i /><i /><span>tomverse.app/review</span></div>
            <video src="/marketing/v2/review-demo.mp4" poster="/marketing/v2/review-demo.jpg" autoPlay={!reduce} muted loop playsInline preload="metadata" aria-label={t.review.videoLabel} />
            <figcaption>{t.review.caption}</figcaption>
          </figure>
        </div>
      </section>

      <section id="mobile" className="chapter" aria-labelledby="home-mobile-title">
        <div className="wrap mobile">
          <div className="mobile-copy rise">
            <span className="eyebrow">{t.mobile.eyebrow}</span>
            <h2 id="home-mobile-title">{t.mobile.title[0]}<br /><span style={{ color: "var(--brand-hi)" }}>{t.mobile.title[1]}</span></h2>
            <p>{t.mobile.body}</p>
            <div className="stores">
              {(["Android", "iOS"] as const).map((store) => <span key={store} className="store" aria-disabled="true">
                <span><small>{t.mobile.soon}</small><strong>{store}</strong></span>
              </span>)}
            </div>
          </div>
          <div className="phones" aria-hidden="true">
            <div className="phone a dark-zone">
              <div className="screen">
                <div className="bar"><strong>Tomverse</strong><span>Smart Adaptive</span></div>
                <div className="bubble me">{t.mobile.phoneA.me}</div>
                <div className="bubble ai">{t.mobile.phoneA.ai}</div>
                <div className="bubble me">{t.mobile.phoneA.followup}</div>
                <div className="typing"><i /><i /><i /></div>
                <div className="compose">{t.mobile.phoneA.compose}<i>↑</i></div>
              </div>
            </div>
            <div className="phone b">
              <div className="screen light">
                <div className="bar"><strong>{t.mobile.phoneB.title}</strong><span>{t.mobile.phoneB.count}</span></div>
                <div className="mini-answers">
                  {t.mobile.phoneB.answers.map(([title, body]) => <div key={title}><b>{title}</b>{body}</div>)}
                  <div className="sum"><b>{t.mobile.phoneB.summary[0]}</b>{t.mobile.phoneB.summary[1]}</div>
                </div>
                <div className="compose">{t.mobile.phoneB.compose}<i>↑</i></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <ApiSection copy={t.api} n={n} reduce={reduce} lang={lang} />

      <section id="cli" className="chapter" aria-labelledby="home-cli-title">
        <div className="wrap">
          <div className="chapter-head">
            <div><span className="eyebrow">{t.cli.eyebrow}</span><h2 id="home-cli-title"><Title lines={t.cli.title} /></h2></div>
            <p>{t.cli.body}</p>
          </div>
          <div className="cli rise">
            <div className="term dark-zone">
              <div className="console-bar"><i /><i /><i /><span>~/projects/calc — tomverse</span></div>
              <CliTerminal copy={t.cli} reduce={reduce} />
            </div>
            <div className="cli-steps">
              {t.cli.steps.map(([title, body], i) => <div key={title}><span>{String(i + 1).padStart(2, "0")}</span><div><h4>{title}</h4><p>{body}</p></div></div>)}
            </div>
          </div>
          <div className="hero-actions" style={{ marginTop: 28 }}><Link className="btn" href={localizedPath(lang, CLI_DOWNLOAD_PATH)}><span>{t.cli.cta}</span><Arrow /></Link></div>
        </div>
      </section>

      <section id="plans" className="chapter" style={{ paddingTop: 24 }} aria-labelledby="home-plans-title">
        <div className="wrap plans rise">
          <div className="plan-card">
            <span className="eyebrow">{t.plans.eyebrow}</span>
            <h2 id="home-plans-title">{t.plans.title}</h2>
            <p>{t.plans.body}</p>
            <div className="tiers"><span>Free</span><span>Pro</span><span>Max</span></div>
            <p className="note" style={{ marginTop: 0 }}>{t.plans.freeNote}</p>
            <Link className="btn ghost" href={localizedPath(lang, "/pricing")} style={{ alignSelf: "flex-start" }}><span>{t.plans.pricingCta}</span><Arrow /></Link>
          </div>
          <div className="plan-card">
            <span className="eyebrow">Trust</span>
            <h2 style={{ fontSize: "clamp(1.5rem,3vw,2.25rem)" }}>{t.plans.trustTitle}</h2>
            <p>{t.plans.trustBody}</p>
            <Link className="btn ghost" href={localizedPath(lang, "/safety")} style={{ alignSelf: "flex-start" }}><span>{t.plans.safetyCta}</span><Arrow /></Link>
          </div>
        </div>
      </section>

      <section id="final" className="final dark-zone" aria-labelledby="home-final-title">
        <div className="orb" aria-hidden="true" />
        <div className="wrap">
          <h2 id="home-final-title">{t.final.title[0]}<br />{t.final.title[1]}</h2>
          <p>{t.final.body}</p>
          <div className="hero-actions">
            <Action href={chatHref} className="btn white" location="landing_final_chat">{t.final.chat}</Action>
            <Action href={reviewHref} className="btn ghost" location="landing_final_review">{t.final.review}</Action>
          </div>
        </div>
      </section>
    </main>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}
