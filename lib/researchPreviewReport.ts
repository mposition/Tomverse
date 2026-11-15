import { z } from "zod";
import { createGroundedCitationStream } from "./groundedCitationLinks";
import { plainTextFromBackend, safeResultUrl } from "./webSearchBackendAdapter";
import { sanitizeWebSearchCitations, type WebSearchCitation } from "./webSearchCitations";
import type { AppManagedSearchBatchResult, AppManagedSearchToolResult } from "./appManagedWebSearchTool";
import { languageFromTag } from "./language";
import { researchPreviewCopy } from "@/locales/researchPreview";
import { curateResearchPageEvidence, researchPageEvidenceSchema, type ResearchPageEvidence } from "./researchPreviewPageEvidence";
import type { ResearchPageReadResult } from "./researchPreviewPageRead";

const sourceIdsSchema = z.array(z.string().regex(/^R(?:[1-9]|1\d|2[0-5])$/)).max(15);
const statementSchema = z.object({
  text: z.string().trim().min(1).max(1200),
  sourceIds: sourceIdsSchema,
  kind: z.enum(["fact", "inference", "uncertain"]),
  evidenceLevel: z.enum(["search_snippets", "page_text"]).optional(),
}).strict();

export const researchPreviewReportSchema = z.object({
  status: z.enum(["complete", "partial", "insufficient_evidence"]),
  summary: z.string().trim().min(1).max(1600),
  findings: z.array(z.object({
    heading: z.string().trim().min(1).max(160),
    statements: z.array(statementSchema).min(1).max(5),
  }).strict()).max(6),
  contradictions: z.array(z.object({
    text: z.string().trim().min(1).max(800), sourceIds: sourceIdsSchema,
  }).strict()).max(5),
  limitations: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
  nextQuestions: z.array(z.string().trim().min(1).max(300)).max(5),
}).strict();

export type ResearchPreviewReport = z.infer<typeof researchPreviewReportSchema>;
export type ResearchEvidenceSource = {
  sourceId: string; url: string; title?: string; snippet?: string;
  publishedAt?: string; retrievedAt: string;
  pageRead?: ResearchPageEvidence;
};
export type ResearchSearchToolResult = Omit<AppManagedSearchToolResult, "results"> & {
  results?: Array<NonNullable<AppManagedSearchToolResult["results"]>[number] & { sourceId: string }>;
};
export type ResearchSearchBatchResult = Omit<AppManagedSearchBatchResult, "searches"> & {
  searches: ResearchSearchToolResult[];
};

export const researchEvidenceSourceSchema = z.object({
  sourceId: z.string().regex(/^R(?:[1-9]|1\d|2[0-5])$/),
  url: z.string().min(1).max(2048), title: z.string().max(200).optional(),
  snippet: z.string().max(400).optional(), publishedAt: z.string().datetime({ offset: true }).optional(),
  retrievedAt: z.string().datetime({ offset: true }), pageRead: researchPageEvidenceSchema.optional(),
}).strict();

export function createResearchEvidenceRegistry(initialSources: readonly ResearchEvidenceSource[] = []) {
  const byUrl = new Map<string, ResearchEvidenceSource>();
  if (initialSources.length > 25) throw new Error("Invalid Research evidence checkpoint");
  for (const [index, candidate] of initialSources.entries()) {
    const parsed = researchEvidenceSourceSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.sourceId !== `R${index + 1}` ||
        safeResultUrl(parsed.data.url) !== parsed.data.url || /[<>\s\\]/u.test(parsed.data.url) || byUrl.has(parsed.data.url)) {
      throw new Error("Invalid Research evidence checkpoint");
    }
    byUrl.set(parsed.data.url, parsed.data);
  }
  const add = (result: AppManagedSearchToolResult, retrievedAt: string): ResearchSearchToolResult => {
    if (result.status !== "ok" || !result.results) {
      return { ...result, results: undefined };
    }
    return {
      ...result,
      results: result.results.slice(0, 5).flatMap((source) => {
        const url = safeResultUrl(source.url);
        if (!url || /[<>\s\\]/u.test(url) || url.length > 2048) return [];
        let entry = byUrl.get(url);
        if (!entry) {
          if (byUrl.size >= 25) return [];
          const title = plainTextFromBackend(source.title, 200);
          const snippet = plainTextFromBackend(source.snippet, 400);
          const timestamp = source.publishedAt ? new Date(source.publishedAt) : null;
          entry = {
            sourceId: `R${byUrl.size + 1}`, url,
            ...(title ? { title } : {}), ...(snippet ? { snippet } : {}),
            ...(timestamp && Number.isFinite(timestamp.getTime()) ? { publishedAt: timestamp.toISOString() } : {}),
            retrievedAt,
          };
          byUrl.set(url, entry);
        }
        // A repeated URL reuses the first bounded excerpt as well as its ID,
        // so the persisted evidence is exactly what the model was shown.
        return [{ sourceId: entry.sourceId, title: entry.title || "Source", url: entry.url,
          ...(entry.snippet ? { snippet: entry.snippet } : {}),
          ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}) }];
      }),
    };
  };
  return {
    /** Register only bounded results actually returned to the model. */
    addToolResult(result: AppManagedSearchToolResult | AppManagedSearchBatchResult, retrievedAt = new Date().toISOString()): ResearchSearchToolResult | ResearchSearchBatchResult {
      return result.status === "batch"
        ? { ...result, searches: result.searches.map((search) => add(search, retrievedAt)) }
        : add(result, retrievedAt);
    },
    sourceIds: () => [...byUrl.values()].map((source) => source.sourceId),
    snapshot: () => [...byUrl.values()].map((source) => ({ ...source,
      ...(source.pageRead ? { pageRead: { ...source.pageRead } } : {}) })),
    recordPageRead(sourceId: string, result: ResearchPageReadResult) {
      const source = [...byUrl.values()].find((entry) => entry.sourceId === sourceId);
      const pageRead = curateResearchPageEvidence(result);
      if (!source || result.sourceId !== sourceId || result.url !== source.url || !pageRead) {
        throw new Error("Invalid Research page evidence binding");
      }
      source.pageRead = pageRead;
    },
  };
}

export type ResearchEvidenceRegistry = ReturnType<typeof createResearchEvidenceRegistry>;

// Entity expansion cannot introduce Markdown structure, but GFM can still
// autolink decoded text. Break URL/email separators with an invisible space
// before encoding punctuation; only server-owned citations create links.
export const researchPlainText = (text: string) => text.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim()
  .replace(/[:.@]/g, "\u200b$&")
  .replace(/[!-/:-@[-`{-~]/g, (character) => `&#${character.charCodeAt(0)};`);

export type RenderedResearchPreviewReport = {
  ok: true; content: string; citations: WebSearchCitation[];
  outcome: ResearchPreviewReport["status"]; citedSources: ResearchEvidenceSource[];
} | { ok: false; reason: "invalid_report" | "unknown_source" | "too_many_sources" | "insufficient_evidence" };

export function validateAndRenderResearchReport(input: {
  report: unknown; registry: ResearchEvidenceRegistry; allowedSourceIds: readonly string[]; locale?: string;
  allowedEvidenceSources?: readonly ResearchEvidenceSource[];
}): RenderedResearchPreviewReport {
  const parsed = researchPreviewReportSchema.safeParse(input.report);
  if (!parsed.success) return { ok: false, reason: "invalid_report" };
  const report = parsed.data;
  const copy = researchPreviewCopy[languageFromTag(input.locale) ?? "en"];
  const currentSources = input.registry.snapshot();
  const allowedSources = input.allowedEvidenceSources ?? currentSources;
  if (allowedSources.length > 25 || new Set(allowedSources.map((source) => source.sourceId)).size !== allowedSources.length ||
      allowedSources.some((source) => {
        const actual = currentSources.find((entry) => entry.sourceId === source.sourceId);
        return !researchEvidenceSourceSchema.safeParse(source).success || !actual ||
          source.url !== actual.url || source.title !== actual.title || source.snippet !== actual.snippet ||
          source.publishedAt !== actual.publishedAt || source.retrievedAt !== actual.retrievedAt;
      })) return { ok: false, reason: "unknown_source" };
  const sources = new Map(allowedSources.map((source) => [source.sourceId, source]));
  const allowed = new Set(input.allowedSourceIds);
  const citedIds = [...new Set([
    ...report.findings.flatMap((finding) => finding.statements.flatMap((statement) => statement.sourceIds)),
    ...report.contradictions.flatMap((contradiction) => contradiction.sourceIds),
  ])];
  if (citedIds.some((id) => !allowed.has(id) || !sources.has(id))) return { ok: false, reason: "unknown_source" };
  if (citedIds.length > 15) return { ok: false, reason: "too_many_sources" };
  if (report.findings.some((finding) => finding.statements.some((statement) =>
    statement.evidenceLevel === "page_text" && (!statement.sourceIds.length ||
      statement.sourceIds.some((id) => sources.get(id)?.pageRead?.status !== "read"))))) {
    return { ok: false, reason: "invalid_report" };
  }
  if (report.findings.some((finding) => finding.statements.some((statement) =>
      (statement.kind === "fact" || statement.kind === "inference") && !statement.sourceIds.length)) ||
      report.contradictions.some((contradiction) => !contradiction.sourceIds.length) ||
      (report.status !== "insufficient_evidence" && !citedIds.length)) {
    return { ok: false, reason: "insufficient_evidence" };
  }
  const citedSources = citedIds.map((id) => sources.get(id)!);
  const citations = sanitizeWebSearchCitations(citedSources.map((source, index) => ({
    url: source.url, title: source.title, sourceProvider: "brave", referenceNumber: index + 1,
  })));
  const displayIds = new Map(citedIds.map((id, index) => [id, index + 1]));
  const references = (ids: readonly string[]) => [...new Set(ids)].map((id) => `[[cite:R${displayIds.get(id)}]]`).join(" ");
  const outcomeLabels = { complete: copy.researchReportComplete, partial: copy.researchReportPartial,
    insufficient_evidence: copy.researchReportInsufficient };
  const kindLabels = { fact: copy.researchReportFact, inference: copy.researchReportInference,
    uncertain: copy.researchReportUncertain };
  const lines = [`## ${copy.researchReportTitle}`, "", `**${outcomeLabels[report.status]}**`, "", researchPlainText(report.summary)];
  for (const finding of report.findings) {
    lines.push("", `### ${researchPlainText(finding.heading)}`, "");
    for (const statement of finding.statements) lines.push(`- **${kindLabels[statement.kind]}:** ${researchPlainText(statement.text)} ${references(statement.sourceIds)}`.trimEnd());
  }
  lines.push("", `### ${copy.researchReportContradictions}`, "");
  if (report.contradictions.length) {
    for (const contradiction of report.contradictions) lines.push(`- ${researchPlainText(contradiction.text)} ${references(contradiction.sourceIds)}`);
  } else lines.push(copy.researchReportNoContradictions);
  const pagesRead = citedSources.some((source) => source.pageRead?.status === "read");
  lines.push("", `### ${copy.researchReportLimitations}`, "", `- ${pagesRead
    ? copy.researchReportPageLimitation : copy.researchReportSnippetLimitation}`);
  if (citedSources.some((source) => source.pageRead?.truncated)) lines.push(`- ${copy.researchReportPageTruncated}`);
  if (citedSources.some((source) => source.pageRead?.status === "unavailable")) lines.push(`- ${copy.researchReportPageUnavailable}`);
  lines.push(...report.limitations.map((limitation) => `- ${researchPlainText(limitation)}`));
  if (report.nextQuestions.length) lines.push("", `### ${copy.researchReportNextQuestions}`, "", ...report.nextQuestions.map((question) => `- ${researchPlainText(question)}`));
  const citationStream = createGroundedCitationStream(citations.map((citation) => citation.url));
  let content = citationStream.write(lines.join("\n")) + citationStream.finish();
  if (citations.length) content += `\n\n### ${copy.researchReportSources}\n\n` + citations.map((citation) =>
    `${citation.referenceNumber}. [${researchPlainText(citation.title || `Source ${citation.referenceNumber}`)}](<${citation.url.replaceAll("&", "&amp;")}>)`).join("\n");
  if (content.length > 100_000) return { ok: false, reason: "invalid_report" };
  return { ok: true, content, citations, outcome: report.status, citedSources };
}
