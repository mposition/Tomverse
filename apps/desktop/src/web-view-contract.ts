import { z } from "zod";

/**
 * Shared, dependency-free rules for the in-app web viewer (documentation and external links).
 * The host enforces these on every navigation and request; the renderer only reuses the pure
 * checks to decide whether a link can be offered at all.
 */

export const DOC_SECTIONS = [
  "help", "guides", "terms", "privacy", "refund", "pricing", "models", "developers", "cli", "cursor", "status",
] as const;
export type DocSection = (typeof DOC_SECTIONS)[number];

/** Public Tomverse documentation paths, without the optional locale prefix. */
export const DOC_PATHS: Record<DocSection, string> = {
  help: "/support/help-centre",
  guides: "/guides/assistant-knowledge",
  terms: "/terms",
  privacy: "/privacy",
  refund: "/refund",
  pricing: "/pricing",
  models: "/models",
  developers: "/developers",
  cli: "/developers/cli",
  cursor: "/developers/cursor",
  status: "/status",
};

const DOC_EXACT_PATHS = new Set(["/support", "/privacy", "/terms", "/refund", "/pricing", "/models", "/status", "/developers", "/faq", "/safety"]);
const DOC_PATH_PREFIXES = ["/support/help-centre", "/guides/", "/developers/", "/safety/"];
const LOCALE_SEGMENTS = new Set(["ko", "en", "zh", "zh-Hant", "fr", "de", "es", "pt"]);
const GUIDE_SCOPED_HOST = /(^|\.)github\.(com|io)$/;

const bounds = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(),
  width: z.number().nonnegative(), height: z.number().nonnegative() }).strict();

export const webViewCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open-docs"), section: z.enum(DOC_SECTIONS) }).strict(),
  z.object({ type: z.literal("open-link"), url: z.string().trim().min(1).max(2048) }).strict(),
  z.object({ type: z.literal("layout"), bounds: bounds.nullable() }).strict(),
  z.object({ type: z.enum(["back", "forward", "reload", "stop", "return-to-docs", "close"]) }).strict(),
]);
export type WebViewCommand = z.infer<typeof webViewCommand>;
export type WebViewKind = "docs" | "link";
export type WebViewState = {
  kind: WebViewKind;
  url: string;
  host: string;
  /** The TOC entry that matches the current Tomverse page; null for provider guides and external links. */
  section: DocSection | null;
  loading: boolean;
  failed: boolean;
  back: boolean;
  forward: boolean;
  /** A provider sign-in guide shown in the documentation view instead of a Tomverse page. */
  guide: boolean;
  /** A link view that was opened from a documentation page can return to it. */
  canReturn: boolean;
};

/** A parsed https URL, or null. Credentials, IP literals and local or single-label hosts are never public. */
export function linkViewUrl(value: string): URL | null {
  if (value.length > 2048) return null;
  let target: URL;
  try { target = new URL(value); } catch { return null; }
  if (target.protocol !== "https:" || target.username || target.password) return null;
  return publicHostname(target.hostname) ? target : null;
}

export function publicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("[") || host.includes(":")) return false;
  if (/^[\d.]+$/.test(host) || /^0x[\da-f]+$/i.test(host)) return false;
  if (!host.includes(".")) return false;
  return !/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|onion)$/.test(host) &&
    !host.endsWith(".home.arpa") && !host.endsWith(".in-addr.arpa") && !host.endsWith(".ip6.arpa");
}

/** Requests a page makes after it was admitted: public https/wss hosts and inline data, nothing local. */
export function allowsSubresource(value: string): boolean {
  let target: URL;
  try { target = new URL(value); } catch { return false; }
  if (target.protocol === "data:" || target.protocol === "blob:") return true;
  if ((target.protocol !== "https:" && target.protocol !== "wss:") || target.username || target.password) return false;
  return publicHostname(target.hostname);
}

function stripLocale(pathname: string) {
  const [, first = "", ...rest] = pathname.split("/");
  return LOCALE_SEGMENTS.has(first) ? "/" + rest.join("/") : pathname;
}

export function docPathAllowed(pathname: string): boolean {
  const path = stripLocale(pathname).replace(/\/+$/, "") || "/";
  return DOC_EXACT_PATHS.has(path) || DOC_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"));
}

export function docSectionFor(pathname: string): DocSection | null {
  const path = stripLocale(pathname).replace(/\/+$/, "") || "/";
  return DOC_SECTIONS.filter((section) => path === DOC_PATHS[section] || path.startsWith(DOC_PATHS[section] + "/"))
    .sort((a, b) => DOC_PATHS[b].length - DOC_PATHS[a].length)[0] ?? null;
}

export function docsUrl(origin: string, section: DocSection, language: string): string {
  const target = new URL(origin + DOC_PATHS[section]);
  target.searchParams.set("lang", language);
  return target.href;
}

/** Provider CLI sign-in guides: same host as a known guide; shared hosts (GitHub) stay inside the guide's own project. */
export function isCliGuideUrl(value: string, guideUrls: readonly string[]): boolean {
  const target = linkViewUrl(value);
  if (!target) return false;
  return guideUrls.some((guide) => {
    let known: URL;
    try { known = new URL(guide); } catch { return false; }
    if (known.protocol !== "https:" || known.hostname !== target.hostname) return false;
    if (!GUIDE_SCOPED_HOST.test(known.hostname)) return true;
    const scope = known.pathname.split("/")[1];
    return Boolean(scope) && target.pathname.split("/")[1] === scope;
  });
}

export type DocsNavigation = "docs" | "link" | "blocked";

/**
 * What the documentation viewer does with a navigation target. Tomverse pages outside the public
 * documentation set (the signed-in web app) are blocked rather than redirected to the link viewer.
 */
export function classifyDocsNavigation(value: string, context: { origin: string; guideUrls: readonly string[] }): DocsNavigation {
  let target: URL;
  try { target = new URL(value); } catch { return "blocked"; }
  if (target.protocol !== "https:" || target.username || target.password) return "blocked";
  if (target.origin === context.origin) return docPathAllowed(target.pathname) ? "docs" : "blocked";
  if (isCliGuideUrl(value, context.guideUrls)) return "docs";
  return linkViewUrl(value) ? "link" : "blocked";
}

export function classifyLinkNavigation(value: string): "link" | "blocked" {
  return linkViewUrl(value) ? "link" : "blocked";
}
