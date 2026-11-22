import "server-only";

import { decodeAttachmentText } from "@/lib/chatAttachmentText";
import { extractPdfTextSafely } from "@/lib/mediaSecurity";
import { parseOfficeSafely, parseOfficeWorkbookSafely } from "@/lib/officeSecurity";
import { RESEARCH_RESOURCE_LIMITS } from "@/lib/researchEngineContract";
import { extractHtmlEvidence, workbookRowsText } from "@/lib/researchEngineEvidence";

/**
 * Bytes to located text through the existing hardened processors: the
 * worker-isolated PDF and Office parsers and the attachment text decoder. Scanned
 * PDF pages have no text layer; they are reported as `no_text_layer` instead of
 * being sent to an OCR/vision provider this feature has no authority to pay.
 */

export type ResearchExtracted =
  | { ok: true; text: string; method: "html_text" | "plain_text" | "pdf_text" | "office_text" | "sheet_rows" | "csv_rows";
      truncated: boolean; title?: string; publishedAt?: string; modifiedAt?: string; links?: Array<{ url: string; label: string }> }
  | { ok: false; reason: "unsupported_content" | "no_text_layer" | "parse_failed" | "too_large" };

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const RESEARCH_READABLE_MEDIA_TYPES = new Set([
  "text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/csv", "application/pdf", DOCX, PPTX, XLSX,
]);

function bounded(text: string) {
  const limit = RESEARCH_RESOURCE_LIMITS.maxExtractedCharacters;
  if (text.length <= limit) return { text, truncated: false };
  let cut = text.slice(0, limit);
  if (/[\uD800-\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

export async function extractResearchDocument(bytes: Buffer, mediaType: string, baseUrl?: string): Promise<ResearchExtracted> {
  const type = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (bytes.byteLength > RESEARCH_RESOURCE_LIMITS.maxReadBytes) return { ok: false, reason: "too_large" };
  try {
    if (type === "application/pdf") {
      const text = await extractPdfTextSafely(bytes, RESEARCH_RESOURCE_LIMITS.maxExtractedCharacters + 1);
      if (!text.trim()) return { ok: false, reason: "no_text_layer" };
      return { ok: true, method: "pdf_text", ...bounded(text) };
    }
    if (type === DOCX || type === PPTX) {
      const text = await parseOfficeSafely(bytes, type, RESEARCH_RESOURCE_LIMITS.maxExtractedCharacters);
      return { ok: true, method: "office_text", ...bounded(text) };
    }
    if (type === XLSX) {
      const workbook = await parseOfficeWorkbookSafely(bytes, RESEARCH_RESOURCE_LIMITS.maxExtractedCharacters, 200_000);
      return { ok: true, method: "sheet_rows", ...bounded(workbookRowsText(workbook)) };
    }
    const decoded = decodeAttachmentText(new Uint8Array(bytes));
    if (!decoded.ok) return { ok: false, reason: "unsupported_content" };
    if (type === "text/html" || type === "application/xhtml+xml") {
      const html = extractHtmlEvidence(decoded.text, baseUrl ?? "https://invalid.example/");
      return { ok: true, method: "html_text", ...bounded(html.text), title: html.title, publishedAt: html.publishedAt,
        modifiedAt: html.modifiedAt, links: html.links };
    }
    if (type === "text/csv") return { ok: true, method: "csv_rows", ...bounded(decoded.text.replace(/\r\n/gu, "\n")) };
    if (type === "text/plain" || type === "text/markdown") return { ok: true, method: "plain_text", ...bounded(decoded.text) };
    return { ok: false, reason: "unsupported_content" };
  } catch {
    return { ok: false, reason: "parse_failed" };
  }
}
