"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { Language } from "@/lib/language";
import { LOCALIZED_SEO_PATHS, localizedPath } from "@/lib/seo";
import type { PolicyDocument, PolicyPageCopy } from "./policyPageContent";

// Pieces the four V2 policy pages share: the document tabs, the motion switch and
// sentence-with-links rendering. None of them changes a document's words.

const DOCUMENT_PATHS: Record<PolicyDocument, string> = {
  safety: "/safety",
  privacy: "/privacy",
  terms: "/terms",
  refund: "/refund",
};

/** A site path in the visitor's language when that page has localized URLs. */
export function policyHref(lang: Language, href: string): string {
  if (!href.startsWith("/")) return href;
  const url = new URL(href, "https://tomverse.app");
  if (!LOCALIZED_SEO_PATHS.includes(url.pathname as (typeof LOCALIZED_SEO_PATHS)[number])) return href;
  return `${localizedPath(lang, url.pathname)}${url.search}${url.hash}`;
}

export const documentHref = (lang: Language, document: PolicyDocument) => policyHref(lang, DOCUMENT_PATHS[document]);

/** Every moving part reads one switch: the OS preference or the page's pause button. */
export function usePolicyMotion() {
  const [prefersReduced, setPrefersReduced] = useState(false);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return { prefersReduced, paused, togglePaused: () => setPaused((value) => !value), reduce: prefersReduced || paused };
}

export function MotionToggle({ motion, copy }: { motion: ReturnType<typeof usePolicyMotion>; copy: PolicyPageCopy }) {
  if (motion.prefersReduced) return null;
  return <button type="button" className="policy-motion" data-testid="policy-motion-toggle" aria-pressed={motion.paused} onClick={motion.togglePaused}>
    <span className="icon" aria-hidden="true">{motion.paused ? "▶" : "❚❚"}</span>{motion.paused ? copy.motionOn : copy.motionOff}
  </button>;
}

export function PolicyCrumb({ lang, copy, current }: { lang: Language; copy: PolicyPageCopy; current: string }) {
  return <p className="crumb">
    <Link href={localizedPath(lang, "/")}>Tomverse</Link> / <Link href={documentHref(lang, "safety")}>{copy.crumb}</Link> / <b>{current}</b>
  </p>;
}

export function PolicyTabs({ lang, copy, current }: { lang: Language; copy: PolicyPageCopy; current: PolicyDocument }) {
  return <nav className="pol-tabs" aria-label={copy.tabsLabel}>
    {(Object.keys(DOCUMENT_PATHS) as PolicyDocument[]).map((document) => <Link key={document} href={documentHref(lang, document)}
      aria-current={document === current ? "page" : undefined}>{copy.tabs[document]}</Link>)}
  </nav>;
}

/**
 * A sentence with some of its words linked. The sentence is printed exactly as
 * written: links only wrap words it already contains.
 */
export function LinkedText({ text, links, href }: { text: string; links?: Array<{ text: string; href: string }>; href: (href: string) => string }) {
  if (!links?.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  links.forEach((link, index) => {
    const start = text.indexOf(link.text, cursor);
    if (start < 0) return;
    parts.push(text.slice(cursor, start));
    parts.push(<Link key={index} href={href(link.href)} className="inline-link">{link.text}</Link>);
    cursor = start + link.text.length;
  });
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export const fill = (text: string, n: number) => text.replaceAll("{n}", String(n));
