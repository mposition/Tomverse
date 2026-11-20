"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { aiReviewDemoCopy } from "@/components/marketing/AiReviewDemo";
import type { GuideCopy } from "@/components/marketing/ChatGptVsClaudeGuide";
import { homeV2Content } from "@/components/marketing/home/homeV2Content";
import { guidesUiCopy } from "./guidesUiCopy";

// Illustrations of the four usage guides (approved concept, owner 2026-11-20): the real
// review recording, a before/after cross-review, the facts both example answers keep,
// and a file turned into evidence-backed items. Every moving part reads one `reduce`
// switch: the OS preference or the pause button of the page.

export function usePrefersReducedMotion() {
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

/** True once the element has scrolled into view; drives the highlight sweeps. */
function useLit<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [lit, setLit] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      const frame = window.requestAnimationFrame(() => setLit(true));
      return () => window.cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setLit(true); observer.disconnect(); }
    }, { threshold: 0.15 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, lit] as const;
}

/** Splits `text` around the given phrases (in order of appearance) and wraps each one. */
function Marked({ text, marks, render }: { text: string; marks: readonly string[]; render: (phrase: string, index: number) => ReactNode }) {
  const found = marks
    .map((phrase, index) => ({ phrase, index, at: text.indexOf(phrase) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const hit of found) {
    if (hit.at < cursor) continue;
    parts.push(text.slice(cursor, hit.at), <Fragment key={hit.index}>{render(hit.phrase, hit.index)}</Fragment>);
    cursor = hit.at + hit.phrase.length;
  }
  parts.push(text.slice(cursor));
  return <>{parts.map((part, i) => <Fragment key={i}>{part}</Fragment>)}</>;
}

/* ---------- /compare-ai-models: the recording of the real Review screen ---------- */

export function GuideVideo({ reduce }: { reduce: boolean }) {
  const { lang } = useLanguage();
  const review = homeV2Content[lang].review;
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (reduce) { video.pause(); return; }
    video.play().catch(() => {});
  }, [reduce]);
  return <figure className="demo-frame">
    <video ref={ref} src="/marketing/v2/review-demo.mp4" poster="/marketing/v2/review-demo.jpg" autoPlay={!reduce} muted loop playsInline preload="metadata" aria-label={review.videoLabel} />
    <figcaption>{review.caption}</figcaption>
  </figure>;
}

/* ---------- /ai-answer-review: three answers, then the structured cross-review ---------- */

const FINDING_TONES = ["agree", "diff", "miss", "check"] as const;

export function BeforeAfter({ reduce }: { reduce: boolean }) {
  const { lang } = useLanguage();
  const text = aiReviewDemoCopy[lang];
  const ui = guidesUiCopy[lang];
  const [view, setView] = useState<"before" | "after">("before");
  // The 6 second rotation stops for good as soon as the visitor picks a view.
  const [auto, setAuto] = useState(true);
  const running = auto && !reduce;
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setView((current) => (current === "before" ? "after" : "before")), 6000);
    return () => window.clearTimeout(timer);
  }, [running, view]);
  const pick = (next: "before" | "after") => { setAuto(false); setView(next); };
  const [beforeToken] = text.before.split(" · ");
  const [afterToken] = text.after.split(" · ");

  return <div className="ba" data-testid="guide-before-after" data-view={view}>
    <div className="ba-head">
      <div>
        <span className="k">{text.eyebrow} · {text.example}</span>
        <h2>{text.title}</h2>
        <p>{text.description}</p>
      </div>
      <div className="seg" role="group" aria-label={ui.viewLabel} data-view={view}>
        <i aria-hidden="true" />
        <button type="button" aria-pressed={view === "before"} onClick={() => pick("before")}>{beforeToken}</button>
        <button type="button" aria-pressed={view === "after"} onClick={() => pick("after")}>{afterToken}</button>
      </div>
    </div>
    <div className="ba-q"><small>{text.promptLabel}</small>{text.prompt}</div>
    <div className="ba-stage">
      <div className="ba-pane" hidden={view !== "before"}>
        <p className="lbl">{text.before}</p>
        <div className="ba-grid">
          {text.answers.map((answer, index) => <div key={answer} className="ans"><span className="mk">{String.fromCharCode(65 + index)}</span><br />{answer}</div>)}
        </div>
      </div>
      <div className="ba-pane" hidden={view !== "after"}>
        <p className="lbl">{text.after}</p>
        <div className="ba-grid after">
          {text.findings.map((finding, index) => <article key={finding.title} className={`tile ${FINDING_TONES[index] ?? "check"}`}>
            <h3>{finding.title}</h3>{finding.body}
          </article>)}
        </div>
      </div>
    </div>
    <div className="ba-prog" aria-hidden="true"><i key={view} className={running ? "run" : ""} style={running ? undefined : { width: "100%" }} /></div>
    <p className="ba-foot">{text.disclaimer}</p>
  </div>;
}

/* ---------- /chatgpt-vs-claude: the facts both example outputs keep ---------- */

export type ComparedModel = { name: string; icon: string; provider: string };

function bullets(result: string) {
  return result.split("\n").map((line) => line.replace(/^•\s*/, "").trim()).filter(Boolean);
}

export function FactPair({ copy, gpt, claude, caption }: { copy: GuideCopy; gpt: ComparedModel; claude: ComparedModel; caption: string }) {
  const { lang } = useLanguage();
  const facts = guidesUiCopy[lang].facts;
  const [ref, lit] = useLit<HTMLDivElement>();
  const [ask, notice] = copy.samplePrompt.split("\n\n");
  const outputs = [
    { model: gpt, lines: bullets(copy.gptResult), marks: facts.gpt },
    { model: claude, lines: bullets(copy.claudeResult), marks: facts.claude },
  ];
  return <>
    <div ref={ref} className={`lit-on-view${lit ? " lit" : ""}`} data-testid="guide-fact-pair">
      <div className="gd-source">
        <span className="k">{copy.samplePromptLabel}</span>
        <p>{ask}</p>
        {notice ? <p className="notice">{notice}</p> : null}
      </div>
      <div className="gd-pair">
        {outputs.map(({ model, lines, marks }) => <div key={model.name} className="gd-out">
          <header>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/model-icons/${model.icon}.png`} alt="" />{model.name}
          </header>
          <ul>{lines.map((line) => <li key={line}>
            <Marked text={line} marks={marks} render={(phrase, index) => <span className={`fact${index > 0 ? ` f${index + 1}` : ""}`}>{phrase}</span>} />
          </li>)}</ul>
        </div>)}
      </div>
      <div className="fact-legend" aria-label={copy.decisionHeader}>
        {facts.legend.map((fact) => <span key={fact}>✓ {fact}</span>)}
      </div>
    </div>
    <p className="cap">{caption}</p>
  </>;
}

/* ---------- /ai-for-file-analysis: a file read into evidence-backed items ---------- */

export function FileExtraction() {
  const { lang } = useLanguage();
  const demo = guidesUiCopy[lang].fileDemo;
  const [ref, lit] = useLit<HTMLDivElement>();
  return <div ref={ref} className={`fx lit-on-view${lit ? " lit" : ""}`} data-testid="guide-file-extraction">
    <div className="fx-doc" aria-hidden="true">
      <div className="nm"><span>PDF</span>{demo.file}</div>
      <p>{demo.notice.map(([before, mark, after], i) => <Fragment key={i}>{i > 0 ? " " : ""}{before}<mark>{mark}</mark>{after}</Fragment>)}</p>
    </div>
    <div className="fx-arrow" aria-hidden="true">→</div>
    <dl className="fx-out">
      {demo.items.map(([label, value], i) => {
        const [before, mark, after] = demo.notice[i];
        return <div key={label} className={`fx-item${i === 3 ? " tbd" : ""}`}>
          <dt>{label}</dt>
          <dd>{value}<small>“{before}{mark}{after}”</small></dd>
        </div>;
      })}
    </dl>
  </div>;
}
