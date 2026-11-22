import { createHash } from "node:crypto";
import { parse } from "parse5";
import { RESEARCH_RESOURCE_LIMITS } from "./researchEngineContract";

/**
 * Deterministic evidence mechanics for Research engine v2: identity, location
 * and exactness. Nothing here judges meaning -- relevance, support and
 * independence are model judgements recorded with the evidence they cite.
 */

export const sha256 = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

// Query parameters that only identify a click, never the document. Everything
// else is kept: `?id=`, `?page=`, `?v=` routinely select different content.
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "igshid", "ref_src",
]);

/** Canonical identity for a public URL. Returns null for anything not https on port 443. */
export function canonicalResearchUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  const kept = [...url.searchParams.entries()].filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()));
  url.search = "";
  for (const [key, entry] of kept) url.searchParams.append(key, entry);
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/u, "");
  const href = url.href;
  return href.length <= 2048 ? href : null;
}

export const researchUrlHost = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };

export function hostMatchesDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Normalised text used for exact-quote and republication checks. */
export const normalizeEvidenceText = (value: string) => value
  .normalize("NFKC")
  .replace(/[‘’‚‛]/gu, "'")
  .replace(/[“”„‟]/gu, "\"")
  .replace(/[‐-―]/gu, "-")
  .replace(/\s+/gu, " ")
  .trim()
  .toLowerCase();

/**
 * Fingerprint for "the same article republished elsewhere". Exact on the
 * normalised lead of the body, so two outlets carrying one wire story share it,
 * while two different reports on one event do not. Not a similarity score.
 */
export function republicationFingerprint(text: string): string | null {
  const normalized = normalizeEvidenceText(text).replace(/[^\p{L}\p{N} ]/gu, "");
  const words = normalized.split(" ").filter(Boolean);
  if (words.length < 60) return null;
  return sha256(words.slice(0, 120).join(" "));
}

export type EvidenceLocator =
  | { type: "page"; page: number }
  | { type: "section"; heading: string; ordinal: number }
  | { type: "rows"; sheet?: string; fromRow: number; toRow: number }
  | { type: "messages"; fromIndex: number; toIndex: number }
  | { type: "span"; ordinal: number };

export type EvidenceChunk = { chunkIndex: number; charStart: number; charEnd: number; locator: EvidenceLocator; digest: string };

const PAGE_MARKER = /\[Page (\d{1,5})\]\n/gu;

/**
 * Splits extracted text into located ranges. Ranges point into the stored
 * text, so a chunk is always re-readable and a quote can be checked against
 * the exact bytes the model was shown.
 */
export function chunkEvidenceText(text: string, method: string): EvidenceChunk[] {
  const limit = RESEARCH_RESOURCE_LIMITS.chunkCharacters;
  const segments: Array<{ start: number; end: number; locator: (ordinal: number) => EvidenceLocator }> = [];
  if (method === "pdf_text" && PAGE_MARKER.test(text)) {
    PAGE_MARKER.lastIndex = 0;
    const marks = [...text.matchAll(PAGE_MARKER)];
    marks.forEach((mark, index) => {
      const start = mark.index!;
      const end = index + 1 < marks.length ? marks[index + 1]!.index! : text.length;
      const page = Number(mark[1]);
      segments.push({ start, end, locator: () => ({ type: "page", page }) });
    });
  } else if (method === "csv_rows" || method === "sheet_rows") {
    let offset = 0;
    const lines = text.split("\n");
    let sheet: string | undefined;
    let rowStart = 1; let row = 0; let start = 0; let length = 0;
    const flush = (end: number) => {
      if (end > start) { const from = rowStart; const to = Math.max(rowStart, row); const s = sheet;
        segments.push({ start, end, locator: () => ({ type: "rows", ...(s ? { sheet: s } : {}), fromRow: from, toRow: to }) }); }
    };
    for (const line of lines) {
      const sheetHeader = /^## Sheet: (.{1,120})$/u.exec(line);
      if (sheetHeader) { flush(offset); sheet = sheetHeader[1]; row = 0; rowStart = 1; start = offset; length = 0; }
      else { row += 1; if (length + line.length > limit && length > 0) { flush(offset); rowStart = row; start = offset; length = 0; } }
      length += line.length + 1;
      offset += line.length + 1;
    }
    flush(Math.min(offset, text.length));
  } else if (method === "conversation_messages") {
    const marks = [...text.matchAll(/^\[Message (\d{1,4})\]/gmu)];
    marks.forEach((mark, index) => {
      const start = mark.index!; const end = index + 1 < marks.length ? marks[index + 1]!.index! : text.length;
      const position = Number(mark[1]);
      segments.push({ start, end, locator: () => ({ type: "messages", fromIndex: position, toIndex: position }) });
    });
  } else {
    const headings = [...text.matchAll(/^#{1,4} (.{1,160})$/gmu)];
    if (headings.length) {
      if (headings[0]!.index! > 0) segments.push({ start: 0, end: headings[0]!.index!, locator: (ordinal) => ({ type: "span", ordinal }) });
      headings.forEach((mark, index) => {
        const start = mark.index!; const end = index + 1 < headings.length ? headings[index + 1]!.index! : text.length;
        const heading = mark[1]!;
        segments.push({ start, end, locator: (ordinal) => ({ type: "section", heading, ordinal }) });
      });
    } else {
      segments.push({ start: 0, end: text.length, locator: (ordinal) => ({ type: "span", ordinal }) });
    }
  }
  if (!segments.length && text.length) segments.push({ start: 0, end: text.length, locator: (ordinal) => ({ type: "span", ordinal }) });
  const chunks: EvidenceChunk[] = [];
  for (const segment of segments) {
    let start = segment.start;
    let ordinal = 0;
    while (start < segment.end) {
      let end = Math.min(segment.end, start + limit);
      if (end < segment.end) {
        const space = text.lastIndexOf(" ", end);
        if (space > start + limit / 2) end = space;
      }
      if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")) end -= 1;
      if (end <= start) end = Math.min(segment.end, start + limit);
      chunks.push({ chunkIndex: chunks.length, charStart: start, charEnd: end, locator: segment.locator(ordinal++),
        digest: sha256(text.slice(start, end)) });
      start = end;
    }
  }
  return chunks;
}

export type QuoteMatch = { chunkIndex: number; start: number; end: number } | null;

/**
 * Finds a model-supplied quote in text the run actually stored. This is the one
 * cheap deterministic check on model citations: a quote that is not present
 * verbatim (after whitespace/quote normalisation) is not evidence, however
 * valid its source key looks.
 */
export function locateQuote(text: string, chunks: readonly Pick<EvidenceChunk, "chunkIndex" | "charStart" | "charEnd">[], quote: string): QuoteMatch {
  const needle = normalizeEvidenceText(quote);
  if (needle.length < 12) return null;
  for (const chunk of chunks) {
    const slice = text.slice(Math.max(0, chunk.charStart - 200), chunk.charEnd);
    const map: number[] = [];
    let normalized = "";
    let lastSpace = false;
    for (let index = 0; index < slice.length; index++) {
      const piece = normalizeEvidenceText(slice[index]!) || " ";
      if (piece === " ") { if (lastSpace || !normalized) continue; lastSpace = true; }
      else lastSpace = false;
      for (const character of piece) { normalized += character; map.push(index); }
    }
    const found = normalized.indexOf(needle);
    if (found >= 0) {
      const base = Math.max(0, chunk.charStart - 200);
      return { chunkIndex: chunk.chunkIndex, start: base + map[found]!, end: base + map[found + needle.length - 1]! + 1 };
    }
  }
  return null;
}

/** Numbers with optional units/percent, used to show a reader a claim-vs-evidence mismatch. */
export function extractNumericTokens(text: string): string[] {
  return [...normalizeEvidenceText(text).matchAll(/(?<![\p{L}\p{N}])[-+]?\d[\d,.]*\s?(?:%|percent|per cent|bn|billion|million|m|k|kg|km|usd|aud|eur|krw|\$)?/gu)]
    .map((match) => match[0].replace(/,/gu, "").trim()).filter((token) => /\d/u.test(token));
}

/** Claim numbers absent from every cited quote. Feeds the verifier; never decides on its own. */
export function unmatchedClaimNumbers(claim: string, quotes: readonly string[]) {
  const evidence = new Set(quotes.flatMap(extractNumericTokens).map((token) => token.replace(/\s/gu, "")));
  return extractNumericTokens(claim).map((token) => token.replace(/\s/gu, "")).filter((token) => !evidence.has(token));
}

type Parse5Node = { nodeName: string; tagName?: string; value?: string; attrs?: Array<{ name: string; value: string }>;
  childNodes?: Parse5Node[]; content?: Parse5Node };

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "head", "nav", "footer", "form"]);
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "main", "li", "ul", "ol", "table", "tr", "br", "hr",
  "blockquote", "pre", "figure", "figcaption", "dl", "dt", "dd", "header", "aside", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * HTML to located text with the spec-compliant parse5 parser. Headings become
 * section markers so chunk locators can name them; table cells keep their row
 * shape; links are returned separately as candidates, never followed here.
 */
export function extractHtmlEvidence(html: string, baseUrl: string) {
  const document = parse(html) as unknown as Parse5Node;
  let out = "";
  let title = "";
  let published: string | undefined;
  let modified: string | undefined;
  const links = new Map<string, string>();
  const push = (value: string) => { out += value; };
  const newline = () => { if (!out.endsWith("\n")) out += "\n"; };
  const walk = (node: Parse5Node, inTitle = false) => {
    const tag = node.tagName;
    if (node.nodeName === "#text") {
      const text = (node.value ?? "").replace(/\s+/gu, " ");
      if (inTitle) title += text; else if (text.trim()) push(out.endsWith("\n") || out.endsWith(" ") ? text.trimStart() : text);
      return;
    }
    if (tag === "meta") {
      const attrs = Object.fromEntries((node.attrs ?? []).map((attr) => [attr.name.toLowerCase(), attr.value]));
      const name = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").toLowerCase();
      if (["article:published_time", "datepublished", "date", "dc.date"].includes(name) && attrs.content) published ??= attrs.content;
      if (["article:modified_time", "datemodified", "last-modified"].includes(name) && attrs.content) modified ??= attrs.content;
      return;
    }
    if (tag === "title") { for (const child of node.childNodes ?? []) walk(child, true); return; }
    if (tag === "time" && !published) {
      const datetime = node.attrs?.find((attr) => attr.name === "datetime")?.value;
      if (datetime) published = datetime;
    }
    if (tag && SKIP_TAGS.has(tag) && tag !== "head") return;
    if (tag === "head") { for (const child of node.childNodes ?? []) if (child.tagName === "title" || child.tagName === "meta") walk(child); return; }
    if (tag === "a") {
      const href = node.attrs?.find((attr) => attr.name === "href")?.value;
      if (href && links.size < RESEARCH_RESOURCE_LIMITS.maxDiscoveredLinksPerPage * 4) {
        try {
          const absolute = canonicalResearchUrl(new URL(href, baseUrl).href);
          if (absolute && absolute !== canonicalResearchUrl(baseUrl)) {
            const label = textOf(node).replace(/\s+/gu, " ").trim().slice(0, 160);
            if (label && !links.has(absolute)) links.set(absolute, label);
          }
        } catch { /* An unparsable href is not a candidate. */ }
      }
    }
    const heading = tag && /^h[1-4]$/u.exec(tag);
    if (heading) { newline(); push(`${"#".repeat(Number(tag![1]))} `); for (const child of node.childNodes ?? []) walk(child); newline(); return; }
    if (tag === "td" || tag === "th") { push(" | "); }
    if (tag && BLOCK_TAGS.has(tag)) newline();
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
    if (tag && BLOCK_TAGS.has(tag)) newline();
  };
  walk(document);
  const text = out.split("\n").map((line) => line.replace(/[ \t]+/gu, " ").trim()).filter(Boolean).join("\n");
  const validDate = (value?: string) => { if (!value) return undefined; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : undefined; };
  return {
    text,
    title: title.replace(/\s+/gu, " ").trim().slice(0, 300) || undefined,
    publishedAt: validDate(published),
    modifiedAt: validDate(modified),
    links: [...links.entries()].slice(0, RESEARCH_RESOURCE_LIMITS.maxDiscoveredLinksPerPage).map(([url, label]) => ({ url, label })),
  };
}

function textOf(node: Parse5Node): string {
  if (node.nodeName === "#text") return node.value ?? "";
  return (node.childNodes ?? []).map(textOf).join(" ");
}

/** Spreadsheet AST (officeSecurity.parseOfficeWorkbookSafely) to row text with sheet markers. */
export function workbookRowsText(workbook: unknown[]): string {
  const lines: string[] = [];
  for (const sheet of workbook) {
    if (!sheet || typeof sheet !== "object") continue;
    const record = sheet as { name?: unknown; rows?: unknown };
    lines.push(`## Sheet: ${String(record.name ?? "Sheet").slice(0, 120)}`);
    if (!Array.isArray(record.rows)) continue;
    for (const row of record.rows) {
      const cells = Array.isArray(row) ? row : row && typeof row === "object" && Array.isArray((row as { cells?: unknown }).cells)
        ? (row as { cells: unknown[] }).cells : [];
      lines.push(cells.map((cell) => {
        const value = cell && typeof cell === "object" ? (cell as { value?: unknown; text?: unknown }).text ?? (cell as { value?: unknown }).value : cell;
        return String(value ?? "").replace(/[\r\n|]+/gu, " ").slice(0, 500);
      }).join(" | "));
    }
  }
  return lines.join("\n");
}
