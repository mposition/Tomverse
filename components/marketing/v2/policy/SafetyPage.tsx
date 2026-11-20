"use client";

import Link from "next/link";
import { Fragment, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Bot, CheckCircle2, Lock, MessageSquareText, Scale, ShieldCheck } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import type { MarketingInfoCopy } from "@/components/marketing/MarketingInfoPage";
import type { Language } from "@/lib/language";
import { localizedPath } from "@/lib/seo";
import { MarketingFooter, MarketingHeader } from "../../MarketingChrome";
import { LinkedText, MotionToggle, PolicyCrumb, PolicyTabs, documentHref, policyHref, usePolicyMotion } from "./PolicyChrome";
import type { PolicyDocumentCards } from "./policyDocumentCards";
import { policyPageContent, type PolicyPageCopy } from "./policyPageContent";
import "../v2-pages.css";
import "./policy-page.css";

// The V2 safety page (approved concept, owner 2026-11-20). The three pillar cards
// are infoPages.safety's sections, printed as written; the diagram and the
// examples only restate what those sections say (policyPageContent.ts).

const FLOW_ICONS = [MessageSquareText, ShieldCheck, Bot, CheckCircle2];
const PILLAR_ICONS = [ShieldCheck, Lock, Scale];

function TryIt({ copy }: { copy: PolicyPageCopy["safety"] }) {
  const [tab, setTab] = useState(0);
  const [locked, setLocked] = useState(false);
  const [shared, setShared] = useState(false);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = copy.tryTabs.length;
    const next = event.key === "ArrowDown" || event.key === "ArrowRight" ? (index + 1) % count
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? (index + count - 1) % count : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(next);
    tabs.current[next]?.focus();
  };
  return <div className="sf-try">
    <div className="sf-tabs" role="tablist" aria-label={copy.tryLabel}>
      {copy.tryTabs.map(([title, note], i) => <button key={title} ref={(el) => { tabs.current[i] = el; }} type="button" role="tab"
        id={`sf-tab-${i}`} aria-controls={`sf-scene-${i}`} aria-selected={tab === i} tabIndex={tab === i ? 0 : -1}
        onClick={() => setTab(i)} onKeyDown={(event) => onKey(event, i)}>
        <b>{title}</b><span>{note}</span>
      </button>)}
    </div>
    <div className="sf-stage">
      <div className="sf-scene" role="tabpanel" id="sf-scene-0" aria-labelledby="sf-tab-0" hidden={tab !== 0}>
        <h3>{copy.file.heading}</h3>
        <div className="sf-scan" aria-hidden="true" />
        {copy.file.rows.map(([ext, name, note, verdict], i) => <div key={name} className="sf-file">
          <span className="ext" aria-hidden="true">{ext}</span>
          <span><strong>{name}</strong><small>{note}</small></span>
          <span className={`sf-verdict ${i < 2 ? "ok" : "no"}`}>{verdict}</span>
        </div>)}
      </div>
      <div className="sf-scene" role="tabpanel" id="sf-scene-1" aria-labelledby="sf-tab-1" hidden={tab !== 1}>
        <h3>{copy.lock.heading}</h3>
        <div className={`sf-lock${locked ? " locked" : ""}`}>
          <div className="sf-convo" aria-hidden={locked}>
            {copy.lock.chat.map((line, i) => <span key={line} className={`sf-bub ${i % 2 ? "ai" : "me"}`}>{line}</span>)}
          </div>
          <div className="sf-veil" aria-hidden={!locked}>
            <div><Lock className="pad" aria-hidden="true" /><b>{copy.lock.veilTitle}</b><small>{copy.lock.veilNote}</small></div>
          </div>
        </div>
        <button type="button" className="sf-toggle" aria-pressed={locked} onClick={() => setLocked((value) => !value)}>
          <i aria-hidden="true" />{locked ? copy.lock.off : copy.lock.on}
        </button>
        <p className="sf-caveat">{copy.lock.caveat}</p>
      </div>
      <div className="sf-scene" role="tabpanel" id="sf-scene-2" aria-labelledby="sf-tab-2" hidden={tab !== 2}>
        <h3>{copy.share.heading}</h3>
        <div className="sf-convo">
          {copy.share.chat.map((line, i) => <span key={line} className={`sf-bub ${i % 2 ? "ai" : "me"}`}>{line}</span>)}
        </div>
        <button type="button" className="sf-toggle" aria-pressed={shared} onClick={() => setShared((value) => !value)}>
          <i aria-hidden="true" />{shared ? copy.share.off : copy.share.on}
        </button>
        {shared ? <div className="sf-link"><code>tomverse.app/share/…</code><span className="ro">{copy.share.linkTag}</span></div> : null}
        <p className="sf-caveat">{copy.share.note}</p>
      </div>
      <p className="sf-stage-note">{copy.sampleNote}</p>
    </div>
  </div>;
}

export function SafetyPage({ content, documents }: {
  content: { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>;
  documents: PolicyDocumentCards;
}) {
  const { lang, t } = useLanguage();
  const copy = policyPageContent[lang];
  const s = copy.safety;
  const localized = content[lang];
  const page = localized ?? content.en;
  const contentLang = localized ? lang : "en";
  const motion = usePolicyMotion();
  const href = (target: string) => policyHref(lang, target);
  const [beforeLink, afterLink = ""] = s.flowNote.split("{privacy}");
  const card = (document: "terms" | "refund") => {
    const own = documents[document][lang];
    return { copy: own ?? documents[document].en, lang: own ? lang : "en" };
  };
  const cards = [
    { document: "privacy" as const, lang, eyebrow: copy.privacyEyebrow, title: t("privacyPolicy.title"), description: t("privacyPolicy.intro"), date: t("privacyPolicy.effective") },
    ...(["terms", "refund"] as const).map((document) => {
      const { copy: heading, lang: headingLang } = card(document);
      return { document, lang: headingLang, eyebrow: heading.eyebrow, title: heading.title, description: heading.description, date: heading.updated };
    }),
  ];

  return <div className="tv-page tv-policy" lang={lang} data-testid="policy-page-safety" data-motion={motion.reduce ? "paused" : "running"}>
    <MarketingHeader maxWidth="max-w-[1440px]" localizedContentAvailable={Boolean(localized)} />
    <main id="top">
      <section className="sf-hero" aria-labelledby="sf-title">
        <div className="wrap">
          <PolicyCrumb lang={lang} copy={copy} current={copy.tabs.safety} />
          <PolicyTabs lang={lang} copy={copy} current="safety" />
          <div lang={contentLang}>
            <h1 id="sf-title" data-testid="policy-title">{page.title}</h1>
            <p className="lead">{page.description}</p>
          </div>
          <MotionToggle motion={motion} copy={copy} />
          <ol className="sf-flow" aria-label={s.flowLabel}>
            {s.flow.map((node, i) => {
              const Icon = FLOW_ICONS[i];
              return <Fragment key={node.k}>
                {i > 0 ? <li className="sf-pipe" aria-hidden="true" style={{ "--d": `${(i - 1) * 0.7}s` } as CSSProperties}><i /></li> : null}
                <li className={`sf-node${i === 1 ? " tv" : ""}`}>
                  <span className="ico" aria-hidden="true"><Icon /></span>
                  <span className="k">{String(i + 1).padStart(2, "0")} · {node.k}</span>
                  <strong>{node.title}</strong>
                  {i === 1 ? <span className="sf-chips">{s.guardChips.map((chip) => <span key={chip}>{chip}</span>)}</span> : null}
                  <small>{node.note}</small>
                </li>
              </Fragment>;
            })}
          </ol>
          <p className="sf-flow-cap">{beforeLink}<Link href={documentHref(lang, "privacy")} className="inline-link">{copy.tabs.privacy}</Link>{afterLink}</p>
        </div>
      </section>

      <section className="chapter" aria-labelledby="sf-pillars-title">
        <div className="wrap">
          <span className="eyebrow">{s.pillarsEyebrow}</span>
          <h2 id="sf-pillars-title" className="section-title">{s.pillarsTitle}</h2>
          <div className="sf-pillars" lang={contentLang}>
            {page.sections.map((section, i) => {
              const Icon = PILLAR_ICONS[i % PILLAR_ICONS.length];
              const links = [...(section.link ? [section.link] : []), ...(section.links ?? [])];
              return <article key={section.title} className="sf-pillar" data-n={String(i + 1).padStart(2, "0")} lang={section.lang}>
                <span className="sf-badge" aria-hidden="true"><Icon /></span>
                <h3>{section.title}</h3>
                <p><LinkedText text={section.body} links={section.bodyLinks} href={href} /></p>
                {links.map((link) => <Link key={link.href} className="sf-more" href={href(link.href)}>{link.label}<span aria-hidden="true"> →</span></Link>)}
              </article>;
            })}
          </div>
        </div>
      </section>

      <section className="chapter sf-follow" aria-labelledby="sf-try-title">
        <div className="wrap">
          <span className="eyebrow">{s.tryEyebrow}</span>
          <h2 id="sf-try-title" className="section-title">{s.tryTitle}</h2>
          <TryIt copy={s} />
        </div>
      </section>

      <section className="chapter sf-follow" aria-labelledby="sf-docs-title">
        <div className="wrap">
          <span className="eyebrow">{s.docsEyebrow}</span>
          <h2 id="sf-docs-title" className="section-title">{s.docsTitle}</h2>
          <div className="sf-docs">
            {cards.map((doc) => <Link key={doc.document} className="sf-doc" href={documentHref(lang, doc.document)} lang={doc.lang}>
              <span className="go" aria-hidden="true">→</span>
              <span className="k">{doc.eyebrow}</span>
              <h3>{doc.title}</h3>
              <p>{doc.description}</p>
              {doc.date ? <span className="date">{doc.date}</span> : null}
            </Link>)}
          </div>
          <div className="sf-closing">
            <p>{s.closing[0]}<br /><em>{s.closing[1]}</em></p>
            <div className="hero-actions">
              <Link className="btn" href={localizedPath(lang, "/products/review")}><span>{s.review}</span><span aria-hidden="true">→</span></Link>
              <Link className="btn ghost" href={localizedPath(lang, "/support")}><span>{copy.support}</span><span aria-hidden="true">→</span></Link>
            </div>
          </div>
        </div>
      </section>
    </main>
    <MarketingFooter maxWidth="max-w-[1440px]" />
  </div>;
}
