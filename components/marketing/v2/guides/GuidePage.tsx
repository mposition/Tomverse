"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useState, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { guideCopy, type GuideCopy } from "@/components/marketing/ChatGptVsClaudeGuide";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/MarketingChrome";
import { useMarketingChatEntry } from "@/components/marketing/MarketingChatAvailability";
import {
  SEARCH_INTENT_SLUGS,
  searchIntentPages,
  type SearchIntentSlug,
} from "@/components/marketing/searchIntentContent";
import { CHATGPT_VS_CLAUDE_MODEL_IDS } from "@/lib/marketingModelReferences";
import { getModel } from "@/lib/models";
import { trackProductEvent } from "@/lib/productAnalyticsClient";
import { REVIEW_WORKSPACE_PATH } from "@/lib/productSurfaceRoutes";
import { localizedPath } from "@/lib/seo";
import { chatPageContent } from "../chat/chatPageContent";
import { guideHref } from "./guideHref";
import { BeforeAfter, FactPair, FileExtraction, GuideVideo, usePrefersReducedMotion, type ComparedModel } from "./GuideVisuals";
import { guidesUiCopy } from "./guidesUiCopy";
import "../v2-pages.css";
import "./guides-page.css";

// Usage guides (approved concept, owner 2026-11-20): one template for the four guides.
// The wording is the live wording of searchIntentContent.ts (and, for the model
// comparison, ChatGptVsClaudeGuide.tsx); only the design is new.

const GUIDE_PATH: Record<SearchIntentSlug, string> = {
  "compare-ai-models": "/compare-ai-models",
  "ai-answer-review": "/ai-answer-review",
  "chatgpt-vs-claude": "/chatgpt-vs-claude",
  "ai-for-file-analysis": "/ai-for-file-analysis",
};
const PROVIDER_ICON: Record<string, string> = { openai: "chatgpt", anthropic: "claude" };
const PROVIDER_NAME: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic" };

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function Action({ href, children, className = "btn", testId, onClick }: { href: string; children: ReactNode; className?: string; testId?: string; onClick?: () => void }) {
  return <Link href={href} className={className} data-testid={testId} onClick={onClick}><span>{children}</span><Arrow /></Link>;
}

/** Breaks a title into a plain first line and an emphasised second one, keeping its text intact. */
function splitTitle(title: string): { first: string; gap: string; second: string } | null {
  const half = title.length / 2;
  const candidates: number[] = [];
  for (let i = 0; i < title.length; i += 1) {
    if (i < title.length * 0.2 || i > title.length * 0.8) continue;
    if (/[:：，,]/.test(title[i])) candidates.push(i + 1);
    else if (title[i] === " ") candidates.push(i);
  }
  if (!candidates.length) return null;
  const at = candidates.reduce((best, current) => (Math.abs(current - half) < Math.abs(best - half) ? current : best));
  const first = title.slice(0, at);
  const rest = title.slice(at);
  const second = rest.trimStart();
  return { first, gap: rest.slice(0, rest.length - second.length), second };
}

function Title({ title }: { title: string }) {
  const parts = splitTitle(title);
  if (!parts) return <>{title}</>;
  return <>{parts.first}{parts.gap}<br /><em>{parts.second}</em></>;
}

function comparedModels(): { gpt: ComparedModel; claude: ComparedModel } {
  const pick = (provider: "openai" | "anthropic", fallback: string): ComparedModel => {
    const model = CHATGPT_VS_CLAUDE_MODEL_IDS.map((id) => getModel(id)).find((candidate) => candidate?.provider === provider);
    return { name: model?.name ?? fallback, icon: PROVIDER_ICON[provider], provider: PROVIDER_NAME[provider] };
  };
  return { gpt: pick("openai", "GPT"), claude: pick("anthropic", "Claude") };
}

/** Wraps `[placeholders]` of a prompt template so the visitor sees what to replace. */
function PromptText({ text }: { text: string }) {
  return <>{text.split(/(\[[^\]]+\])/).map((part, i) => (part.startsWith("[") && part.endsWith("]") ? <mark key={i}>{part}</mark> : part))}</>;
}

function PromptCard({ label, prompt, copyLabel, copiedLabel }: { label: string; prompt: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      void navigator.clipboard.writeText(prompt).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }, () => {});
    } catch { /* clipboard unavailable: the text stays selectable */ }
  };
  return <div className="gd-prompt">
    <b>{label}</b>
    <p><PromptText text={prompt} /></p>
    <button type="button" onClick={copy}>{copied ? copiedLabel : copyLabel}</button>
  </div>;
}

type RowProps = { index: number; id?: string; title: string; children: ReactNode };

function Row({ index, id, title, children }: RowProps) {
  const headingId = `guide-row-${index}`;
  return <article id={id} className="gd-row" aria-labelledby={headingId}>
    <header><span>{String(index + 1).padStart(2, "0")}</span><h2 id={headingId}>{title}</h2></header>
    <div className="gd-body reveal">{children}</div>
  </article>;
}

/* ---------- Rows of the three guides whose body is the plain section list ---------- */

function SectionRows({ slug }: { slug: SearchIntentSlug }) {
  const { lang } = useLanguage();
  const ui = guidesUiCopy[lang];
  const page = searchIntentPages[slug][lang];
  return <>
    {page.sections.map((section, index) => {
      const links = [...(section.link ? [section.link] : []), ...(section.links ?? [])];
      return <Row key={section.title} index={index} id={section.id} title={section.title}>
        {section.body && section.body !== page.description ? <p>{section.body}</p> : null}
        {section.formatGroups ? <div className="gd-formats" data-testid="attachment-format-groups">
          <ul className="fmt-list">
            {section.formatGroups.map((group) => <li key={group.label}><strong>{group.label}:</strong> {group.extensions.join(", ")}</li>)}
          </ul>
          <div className="fmt-details">
            {section.formatGroups.map((group) => <details key={group.label} data-testid="attachment-format-details">
              <summary>
                <span className="name">{group.label}</span>
                <span className="peek">{group.extensions.slice(0, 3).join(", ")}{group.extensions.length > 3 ? ` · +${group.extensions.length - 3}` : ""}</span>
                <span className="more">{ui.allFormats}</span>
              </summary>
              <p>{group.extensions.join(", ")}</p>
            </details>)}
          </div>
        </div> : null}
        {section.bullets ? <ul className="ticks">{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
        {links.map((link) => <Link key={link.href} href={guideHref(link.href, lang)} className="gd-link"
          target={link.external ? "_blank" : undefined} rel={link.external ? "noopener noreferrer" : undefined}>
          {link.label}{link.external ? " ↗" : " →"}
        </Link>)}
      </Row>;
    })}
  </>;
}

/* ---------- Rows of the ChatGPT vs Claude comparison ---------- */

function ModelComparisonRows({ copy, gpt, claude }: { copy: GuideCopy; gpt: ComparedModel; claude: ComparedModel }) {
  const { lang } = useLanguage();
  const ui = guidesUiCopy[lang];
  const lastFaq = copy.faqs.length - 1;
  return <>
    <Row index={0} title={copy.scopeTitle}>
      <p className="eyebrow">{copy.scopeEyebrow}</p>
      <div className="gd-models">
        {[gpt, claude].map((model) => <span key={model.name}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/model-icons/${model.icon}.png`} alt="" />{model.name} <small>{model.provider}</small>
        </span>)}
      </div>
      <span className="gd-pill">{copy.reviewedDate}</span>
      <p>{copy.scopeNote}</p>
    </Row>

    <Row index={1} id="task-comparison" title={copy.resultsTitle}>
      <p>{copy.resultsBody}</p>
      <div className="gd-matrix" role="table" aria-label={copy.resultsTitle} data-testid="comparison-task-table">
        <div className="mrow" role="row">
          <span role="columnheader">{copy.taskHeader}</span>
          <span role="columnheader">{/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/model-icons/${gpt.icon}.png`} alt="" />{copy.gptHeader}</span>
          <span role="columnheader">{/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/model-icons/${claude.icon}.png`} alt="" />{copy.claudeHeader}</span>
          <span role="columnheader">{copy.decisionHeader}</span>
        </div>
        {copy.tasks.map((row) => <div key={row.task} className="mrow" role="row">
          <b role="rowheader">{row.task}</b>
          <span role="cell" className={row.gpt === row.claude ? "same" : undefined} data-h={copy.gptHeader}>{row.gpt}</span>
          <span role="cell" data-h={copy.claudeHeader}>{row.claude}</span>
          <span role="cell" data-h={copy.decisionHeader}>{row.decision}</span>
        </div>)}
      </div>
    </Row>

    <Row index={2} title={copy.resultTitle}>
      <p>{copy.resultBody}</p>
      <p>{copy.resultTakeaway}</p>
      <p className="small">{copy.resultDisclaimer}</p>
    </Row>

    <Row index={3} id="methodology" title={copy.methodTitle}>
      <p>{copy.methodBody}</p>
      <ol className="gd-steps">{copy.methodSteps.map((step) => <li key={step}><span>{step}</span></li>)}</ol>
      <p className="eyebrow" style={{ margin: "26px 0 4px" }}>{copy.screenTitle}</p>
      <p>{copy.screenBody}</p>
    </Row>

    <Row index={4} id="prompt-examples" title={copy.promptsTitle}>
      <p>{copy.promptsBody}</p>
      <div className="gd-prompts">
        {copy.promptExamples.map((example) => <PromptCard key={example.label} label={example.label} prompt={example.prompt} copyLabel={ui.copyPrompt} copiedLabel={ui.copied} />)}
      </div>
    </Row>

    <Row index={5} title={copy.fitTitle}>
      <div className="gd-cards">
        {copy.fitCards.map((card) => <div key={card.title} className="gd-card"><b>{card.title}</b><p>{card.body}</p></div>)}
      </div>
    </Row>

    <Row index={6} id="comparison-faq" title={copy.faqTitle}>
      <div className="gd-faq">
        {copy.faqs.map((faq, i) => <details key={faq.question} open={i === 0} lang={i === lastFaq && lang !== "ko" ? "en" : lang}>
          <summary>{faq.question}</summary>
          <p>{faq.answer}</p>
        </details>)}
      </div>
    </Row>
  </>;
}

/* ---------- Page ---------- */

export function GuidePage({ slug }: { slug: SearchIntentSlug }) {
  const { lang } = useLanguage();
  const { status } = useSession();
  const { chatHref } = useMarketingChatEntry();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [motionPaused, setMotionPaused] = useState(false);
  const reduce = prefersReducedMotion || motionPaused;

  const page = searchIntentPages[slug][lang];
  const ui = guidesUiCopy[lang];
  const motionCopy = chatPageContent[lang].hero;
  const reviewInfoLabel = chatPageContent[lang].cta.review;
  const reviewInfoHref = localizedPath(lang, "/products/review");
  const cta = page.cta ?? { label: ui.tabs[slug], href: "/review" };
  const startHref = guideHref(cta.href, lang);
  const isModelComparison = slug === "chatgpt-vs-claude";
  const vsCopy = guideCopy[lang];
  const { gpt, claude } = comparedModels();

  // The prepared comparison deep link of the ChatGPT vs Claude guide (sign-in first when needed).
  const comparisonParams = new URLSearchParams({
    lang,
    models: [...CHATGPT_VS_CLAUDE_MODEL_IDS].join(","),
    prompt: vsCopy.samplePrompt,
    source: "chatgpt-vs-claude",
  });
  const comparisonPath = `${REVIEW_WORKSPACE_PATH}?${comparisonParams.toString()}`;
  const comparisonHref = status === "authenticated" ? comparisonPath : `/auth/signin?callbackUrl=${encodeURIComponent(comparisonPath)}`;

  // The comparison guide keeps its own list (it also points at the model catalogue); the
  // others link to the three remaining guides, with the one-line notes of the comparison copy.
  const related: Array<{ href: string; label: string; sub: string }> = isModelComparison
    ? vsCopy.relatedLinks.map((link) => ({ href: guideHref(link.href, lang), label: link.label, sub: link.body }))
    : SEARCH_INTENT_SLUGS.filter((other) => other !== slug).map((other) => ({
      href: localizedPath(lang, GUIDE_PATH[other]),
      label: ui.tabs[other],
      sub: other === "compare-ai-models" ? vsCopy.relatedLinks[0].body
        : other === "ai-for-file-analysis" ? vsCopy.relatedLinks[1].body
          : ui.blurbs[other],
    }));

  const visual = slug === "compare-ai-models" ? <GuideVideo reduce={reduce} />
    : isModelComparison ? <FactPair copy={vsCopy} gpt={gpt} claude={claude} caption={vsCopy.screenCaption} />
      : slug === "ai-for-file-analysis" ? <FileExtraction /> : null;

  return <div className="tv-page" lang={lang} data-testid="guide-page" data-guide={slug} data-motion={reduce ? "paused" : "running"}>
    <MarketingHeader variant="launch" maxWidth="max-w-[1440px]" chatHref={chatHref} reviewInfoHref={reviewInfoHref} />
    <main id="top">
      <section className="gd-hero" aria-labelledby="guide-title">
        <div className="wrap">
          <p className="crumb"><Link href={localizedPath(lang, "/")}>Tomverse</Link> / <span>{ui.guides}</span> / <b>{ui.tabs[slug]}</b></p>
          <nav className="gd-tabs" aria-label={ui.guides}>
            {SEARCH_INTENT_SLUGS.map((tab) => <Link key={tab} href={localizedPath(lang, GUIDE_PATH[tab])} aria-current={tab === slug ? "page" : undefined}>{ui.tabs[tab]}</Link>)}
          </nav>
          <div className={`gd-top${visual ? "" : " solo"}`}>
            <div className="gd-copy">
              <p className="eyebrow">{page.eyebrow}</p>
              <h1 id="guide-title" data-testid="guide-title"><Title title={page.title} /></h1>
              <p className="lead">{page.description}</p>
              <div className="hero-actions">
                <Action href={startHref} testId="marketing-info-intro-cta"
                  onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: "marketing_info_intro" })}>
                  {page.introCtaLabel ?? cta.label}
                </Action>
                <Action href={reviewInfoHref} className="btn ghost">{reviewInfoLabel}</Action>
              </div>
              {!prefersReducedMotion && <button type="button" className="gd-motion-toggle" data-testid="guide-motion-toggle" aria-pressed={motionPaused}
                onClick={() => setMotionPaused((paused) => !paused)}>
                <span className="icon" aria-hidden="true">{motionPaused ? "▶" : "❚❚"}</span>{motionPaused ? motionCopy.motionOn : motionCopy.motionOff}
              </button>}
            </div>
            {visual ? <div className="gd-vis">{visual}</div> : null}
          </div>
        </div>
      </section>

      {slug === "ai-answer-review" ? <section className="chapter" style={{ paddingTop: 16, paddingBottom: 24 }} aria-label={page.eyebrow}>
        <div className="wrap reveal"><BeforeAfter reduce={reduce} /></div>
      </section> : null}

      <section className="chapter" style={{ paddingTop: 24 }}>
        <div className="wrap">
          {isModelComparison ? <ModelComparisonRows copy={vsCopy} gpt={gpt} claude={claude} /> : <SectionRows slug={slug} />}
          <article className="gd-row" aria-labelledby="guide-related-title">
            <header><span>→</span><h2 id="guide-related-title">{vsCopy.relatedTitle}</h2></header>
            <div className="gd-body">
              <div className="gd-related">
                {related.map((item) => <Link key={item.href} href={item.href}><b>{item.label}</b><span>{item.sub}</span></Link>)}
              </div>
            </div>
          </article>
        </div>
      </section>

      <section className="chapter" style={{ paddingTop: 8 }} aria-label={page.title}>
        <div className="wrap">
          {isModelComparison ? <>
            <div className="cta-band">
              <div>
                <span className="eyebrow">{vsCopy.ctaEyebrow}</span>
                <h2 style={{ marginTop: 14 }}>{vsCopy.ctaTitle}</h2>
                <p style={{ maxWidth: "60ch" }}>{vsCopy.ctaBody}</p>
                {status !== "authenticated" && <p className="gd-small" style={{ maxWidth: "60ch" }}>{vsCopy.signInNote}</p>}
              </div>
              <div className="hero-actions" style={{ margin: 0 }}>
                <Action href={comparisonHref} className="btn white"
                  onClick={() => trackProductEvent("cta_start_click", 2, { cta_location: "chatgpt_vs_claude_guide" })}>
                  {vsCopy.ctaLabel}
                </Action>
              </div>
            </div>
            <p className="note" lang={lang === "ko" ? "ko" : "en"}>{vsCopy.independentNotice}</p>
          </> : <div className="cta-band">
            <div><h2>{page.title}</h2></div>
            <div className="hero-actions" style={{ margin: 0 }}>
              <Action href={startHref} className="btn white"
                onClick={() => trackProductEvent("cta_start_click", 0, { cta_location: slug === "ai-answer-review" ? "ai_answer_review_page" : "marketing_info_page" })}>
                {cta.label}
              </Action>
              <Action href={reviewInfoHref} className="btn ghost">{reviewInfoLabel}</Action>
            </div>
          </div>}
        </div>
      </section>
    </main>
    <MarketingFooter variant="launch" maxWidth="max-w-[1440px]" />
  </div>;
}
