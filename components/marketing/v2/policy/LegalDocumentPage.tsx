"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import type { MarketingInfoCopy } from "@/components/marketing/MarketingInfoPage";
import type { Language } from "@/lib/language";
import { localizedPath } from "@/lib/seo";
import { MarketingFooter, MarketingHeader } from "../../MarketingChrome";
import { LinkedText, MotionToggle, PolicyCrumb, PolicyTabs, documentHref, fill, policyHref, usePolicyMotion } from "./PolicyChrome";
import { policyPageContent, type PolicyDocument } from "./policyPageContent";
import "../v2-pages.css";
import "./policy-page.css";

// The V2 document layout shared by the privacy policy, the terms and the refund
// policy (approved concept, owner 2026-11-20). It only lays a document out: the
// caller renders every clause from its own source, and this frame adds the
// tabs, jump list, contents, reading progress and closing links around it.

export type LegalDocumentSection = { id: string; title: string };

const CJK = new Set<Language>(["ko", "zh", "zh-Hant"]);

/** Minutes to read: 500 characters a minute in Korean and Chinese, 230 words otherwise. */
const readingMinutes = (text: string, lang: Language) => Math.max(1, Math.round(CJK.has(lang)
  ? text.replace(/\s+/g, "").length / 500
  : text.split(/\s+/).filter(Boolean).length / 230));

const number = (index: number) => String(index + 1).padStart(2, "0");

export function LegalDocumentPage({
  document,
  contentLang,
  localizedContentAvailable,
  eyebrow,
  title,
  lead,
  date,
  sections,
  jumpLabel,
  actions,
  children,
}: {
  document: Exclude<PolicyDocument, "safety">;
  /** The language the document's own words are in (English when it has no translation). */
  contentLang: Language;
  localizedContentAvailable: boolean;
  eyebrow: string;
  title: string;
  lead: string;
  /** The document's own date line, shown as written. */
  date?: string;
  sections: LegalDocumentSection[];
  jumpLabel?: string;
  /** Closing links, the first one primary. Links to the other documents follow them. */
  actions: Array<{ href: string; label: string }>;
  children: ReactNode;
}) {
  const { lang } = useLanguage();
  const copy = policyPageContent[lang];
  const motion = usePolicyMotion();
  const bodyRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const tocRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const sectionKey = sections.map((section) => section.id).join(" ");

  useEffect(() => {
    setMinutes(readingMinutes(bodyRef.current?.textContent ?? "", contentLang));
  }, [contentLang, sectionKey]);

  // Scroll spy: the clause crossing the upper third of the screen is the current one.
  useEffect(() => {
    const targets = sectionKey.split(" ").map((id) => window.document.getElementById(id)).filter((node): node is HTMLElement => Boolean(node));
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.id);
    }, { rootMargin: "-30% 0px -60% 0px" });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [sectionKey]);

  // Keep the current entry visible in a contents list taller than the screen.
  useEffect(() => {
    const toc = tocRef.current;
    const link = active ? toc?.querySelector<HTMLElement>(`a[href="#${CSS.escape(active)}"]`) : null;
    if (!toc || !link || toc.scrollHeight <= toc.clientHeight) return;
    if (link.offsetTop < toc.scrollTop || link.offsetTop + link.offsetHeight > toc.scrollTop + toc.clientHeight) {
      toc.scrollTop = link.offsetTop - toc.clientHeight / 2;
    }
  }, [active]);

  // Reading progress follows the scroll position; it never moves on its own.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const doc = bodyRef.current, bar = barRef.current;
      if (!doc || !bar) return;
      const rect = doc.getBoundingClientRect();
      const total = rect.height - window.innerHeight * 0.6;
      bar.style.transform = `scaleX(${Math.min(1, Math.max(0, -rect.top / (total > 0 ? total : 1)))})`;
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const jump = jumpLabel ?? copy.jumpTo;
  const jumpLinks = (className: string) => <nav className={className} aria-label={jump}>
    {sections.map((section, index) => <a key={section.id} href={`#${section.id}`} style={{ animationDelay: `${index * 0.035}s` }}>
      <span aria-hidden="true">{number(index)}</span>{section.title}
    </a>)}
  </nav>;
  const others = (["privacy", "terms", "refund"] as const).filter((other) => other !== document);

  return <div className="tv-page tv-policy" lang={lang} data-testid={`policy-page-${document}`} data-motion={motion.reduce ? "paused" : "running"}>
    <div className="read-bar" aria-hidden="true"><i ref={barRef} /></div>
    <MarketingHeader maxWidth="max-w-[1440px]" localizedContentAvailable={localizedContentAvailable} />
    <main id="top">
      <section className="legal-hero" aria-labelledby="policy-title">
        <div className="wrap">
          <PolicyCrumb lang={lang} copy={copy} current={copy.tabs[document]} />
          <PolicyTabs lang={lang} copy={copy} current={document} />
          <div lang={contentLang}>
            <span className="eyebrow">{eyebrow}</span>
            <h1 id="policy-title" data-testid="policy-title">{title}</h1>
            <p className="lead">{lead}</p>
          </div>
          <div className="legal-meta">
            {date ? <span className="live" lang={contentLang}>{date}</span> : null}
            <span>{fill(copy.sectionCount, sections.length)}</span>
            {minutes ? <span data-testid="policy-reading-time">{fill(copy.readingTime, minutes)}</span> : null}
          </div>
          <MotionToggle motion={motion} copy={copy} />
          <div lang={contentLang}>
            {jumpLinks("toc-grid toc-wide")}
            <details className="toc-fold">
              <summary>{jump}</summary>
              {jumpLinks("toc-grid")}
            </details>
          </div>
        </div>
      </section>

      <div className="chapter legal-chapter">
        <div className="wrap legal-body">
          <aside className="legal-toc" aria-label={copy.contents} ref={tocRef}>
            <h2>{copy.contents}</h2>
            <nav aria-label={copy.contents} lang={contentLang}>
              {sections.map((section) => <a key={section.id} href={`#${section.id}`} className={active === section.id ? "on" : undefined}
                aria-current={active === section.id ? "true" : undefined} onClick={() => setActive(section.id)}>{section.title}</a>)}
            </nav>
            <div className="toc-foot">{copy.askSupport}<Link href={localizedPath(lang, "/support")}>{copy.support} →</Link></div>
          </aside>
          <div className="legal-doc">
            <div lang={contentLang} ref={bodyRef}>{children}</div>
            <div className="legal-end">
              <p lang={contentLang}>{title}{date ? ` · ${date}` : ""}</p>
              <div className="legal-end-actions">
                {actions.map((action, index) => <Link key={action.href} href={policyHref(lang, action.href)} className={index ? "btn ghost" : "btn"}>
                  <span>{action.label}</span><span aria-hidden="true">→</span>
                </Link>)}
                {others.map((other) => <Link key={other} href={documentHref(lang, other)} className="btn ghost">
                  <span>{copy.tabs[other]}</span><span aria-hidden="true">→</span>
                </Link>)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
    <MarketingFooter maxWidth="max-w-[1440px]" />
  </div>;
}

type InfoContent = { en: MarketingInfoCopy } & Partial<Record<Language, MarketingInfoCopy>>;

/**
 * The terms and the refund policy: every clause is the source's own title, body,
 * list and links, in the source's order. Each clause is an article whose body
 * paragraphs keep the reading measure tests/e2e/terms-reading-width.spec.ts holds.
 */
export function LegalInfoDocument({ document, content }: { document: "terms" | "refund"; content: InfoContent }) {
  const { lang } = useLanguage();
  const localized = content[lang];
  const page = localized ?? content.en;
  const contentLang = localized ? lang : "en";
  const sections = page.sections.map((section, index) => ({ id: section.id ?? `section-${index + 1}`, title: section.title }));
  const href = (target: string) => policyHref(lang, target);
  return <LegalDocumentPage document={document} contentLang={contentLang} localizedContentAvailable={Boolean(localized)}
    eyebrow={page.eyebrow} title={page.title} lead={page.description} date={page.updated} sections={sections}
    jumpLabel={page.sectionNavLabel} actions={page.cta ? [page.cta] : []}>
    {page.sections.map((section, index) => {
      const links = [...(section.link ? [section.link] : []), ...(section.links ?? [])];
      return <article key={sections[index].id} id={sections[index].id} className="legal-sec" lang={section.lang} aria-labelledby={`${sections[index].id}-title`}>
        <h2 id={`${sections[index].id}-title`}><span aria-hidden="true">{number(index)}</span>{section.title}</h2>
        <div className="legal-text">
          <p><LinkedText text={section.body} links={section.bodyLinks} href={href} /></p>
          {section.bullets?.length ? <ul className="ok-list">{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
          {links.length ? <p className="legal-links">{links.map((link) => <Link key={link.href} href={href(link.href)} className="inline-link"
            target={link.external ? "_blank" : undefined} rel={link.external ? "noopener noreferrer" : undefined}>{link.label}</Link>)}</p> : null}
        </div>
      </article>;
    })}
  </LegalDocumentPage>;
}
