import {
  ARTIFACT_LIMITS, documentSpecSchema, presentationSpecSchema, sanitizeArtifactFilename, workbookSpecSchema,
  type ArtifactSlideSpec, type DocumentSpec, type PresentationSpec, type WorkbookSpec,
} from "@/lib/generatedArtifactCore";
import { renderDocumentArtifact, renderPresentationArtifact, renderSpreadsheetArtifact } from "@/lib/generatedArtifactRenderers";
import type { ResearchReportDocument, ResearchTaskOutput } from "@/lib/researchEngineContract";
import type { ReportClaim } from "@/lib/researchEngineReport";
import type { ResearchEngineCopy } from "@/locales/researchEngine";

/**
 * Files made from a finished Research report: the exports, and the deliverable of a delegated task.
 *
 * No model call happens here. The report's sections were written by the writer role from verified
 * claims and paid for through the run's own reservations; this only lays that document out in the
 * existing generated-file renderers (docs/policy/generated-artifacts.md), so a task file costs no
 * credits of its own and carries nothing the report does not.
 */

type Quality = "complete" | "partial" | "insufficient_evidence";

/** Default off. Only the exact value "true" turns it on, and only while the Research engine itself is on. */
export const chatTaskAgentEnabled = (env: Record<string, string | undefined>) =>
  env.RESEARCH_ENGINE_ENABLED === "true" && env.CHAT_TASK_AGENT_ENABLED === "true";

export const RESEARCH_TASK_FILE_FORMATS: Readonly<Record<ResearchTaskOutput, "docx" | "xlsx" | "pptx">> = {
  document: "docx", spreadsheet: "xlsx", presentation: "pptx",
};

/** Bullets on one generated slide: a layout choice for legibility, not a product limit. */
const BULLETS_PER_SLIDE = 6;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** `[n]` markers for the claims a block cites, matching the bibliography numbers. */
function citations(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>) {
  const numberOf = new Map(document.bibliography.map((entry) => [entry.sourceKey, entry.n]));
  return (keys: readonly string[]) => {
    const numbers = [...new Set(keys.flatMap((key) => (claims.get(key)?.evidence ?? []).map((evidence) => numberOf.get(evidence.sourceKey))
      .filter((value): value is number => value !== undefined)))].sort((a, b) => a - b);
    return numbers.length ? ` ${numbers.map((n) => `[${n}]`).join("")}` : "";
  };
}

const sourceLine = (entry: ResearchReportDocument["bibliography"][number], labels: ResearchEngineCopy) =>
  `${entry.title}${entry.url ? ` — ${entry.url}` : entry.private ? ` — ${labels.report.privateSource}` : ""}${entry.readStatus === "snippet_only" ? ` (${labels.report.snippetOnly})` : ""} · ${entry.retrievedAt.slice(0, 10)}`;

/** The report as the existing document renderer's spec; citations become [n] markers that match the bibliography. */
export function reportDocumentSpec(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, format: "pdf" | "docx" | "md",
  labels: ResearchEngineCopy, quality: Quality, filename: string): DocumentSpec {
  const cite = citations(document, claims);
  const max = ARTIFACT_LIMITS.maxTextLength;
  const blocks: Array<Record<string, unknown>> = [
    { type: "paragraph", text: labels.report.quality[quality] },
    { type: "heading", level: 2, text: labels.report.summary }, { type: "paragraph", text: clip(document.summary, max) },
    { type: "heading", level: 2, text: labels.report.scope }, { type: "paragraph", text: clip(document.scope.note || document.scope.question, max) },
  ];
  for (const section of document.sections) {
    blocks.push({ type: "heading", level: 2, text: clip(section.heading, ARTIFACT_LIMITS.maxTitleLength) });
    if (section.status === "missing") { blocks.push({ type: "paragraph", text: labels.report.missingSection }); continue; }
    for (const block of section.blocks) {
      if (block.type === "paragraph") blocks.push({ type: "paragraph", text: clip(`${block.text}${cite(block.claimKeys)}`, max) });
      else {
        blocks.push({ type: "paragraph", text: clip(`${block.caption}${cite(block.claimKeys)}`, max) });
        blocks.push({ type: "table", columns: block.columns.slice(0, ARTIFACT_LIMITS.maxDocumentTableColumns).map((column) => clip(column, ARTIFACT_LIMITS.maxTitleLength)),
          rows: block.rows.slice(0, ARTIFACT_LIMITS.maxDocumentTableRows).map((row) => row.slice(0, ARTIFACT_LIMITS.maxDocumentTableColumns)) });
      }
    }
  }
  if (document.conflicts.length) blocks.push({ type: "heading", level: 2, text: labels.report.conflicts },
    { type: "bullets", items: document.conflicts.map((conflict) => clip(`${conflict.text}${cite(conflict.claimKeys)}`, max)) });
  if (document.limitations.length) blocks.push({ type: "heading", level: 2, text: labels.report.limitations },
    { type: "bullets", items: document.limitations.map((entry) => clip(entry, max)) });
  if (document.nextQuestions.length) blocks.push({ type: "heading", level: 2, text: labels.report.nextQuestions },
    { type: "bullets", items: document.nextQuestions.map((entry) => clip(entry, max)) });
  if (document.bibliography.length) blocks.push({ type: "heading", level: 2, text: labels.report.sources },
    { type: "numbers", items: document.bibliography.map((entry) => clip(sourceLine(entry, labels), max)) });
  return documentSpecSchema.parse({ filename, format, title: clip(document.title, ARTIFACT_LIMITS.maxTitleLength), blocks: blocks.slice(0, ARTIFACT_LIMITS.maxDocumentBlocks) });
}

/** One worksheet per report table, in report order: the shape the XLSX export has always used. */
export function reportTableWorksheets(document: ResearchReportDocument, room: number = ARTIFACT_LIMITS.maxWorksheets) {
  return document.sections.flatMap((section) => section.blocks.flatMap((block) => block.type === "table" ? [block] : []).map((block, index) => ({ section, block, index })))
    .slice(0, Math.max(0, room)).map(({ section, block, index }) => ({
      name: clip(`${section.key}-${index + 1}`, 31), title: clip(block.caption, ARTIFACT_LIMITS.maxTitleLength),
      columns: block.columns.map((header) => ({ header: clip(header, ARTIFACT_LIMITS.maxTextLength) })), rows: block.rows,
    }));
}

/** A task spreadsheet: the summary and every section first, then each report table, then the sources. */
export function reportTaskWorkbookSpec(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, labels: ResearchEngineCopy,
  quality: Quality, filename: string): WorkbookSpec {
  const cite = citations(document, claims);
  const max = ARTIFACT_LIMITS.maxTextLength;
  const overview: string[][] = [[labels.report.summary, clip(document.summary, max)], [labels.report.quality[quality], ""]];
  for (const section of document.sections) {
    if (section.status === "missing") { overview.push([clip(section.heading, max), labels.report.missingSection]); continue; }
    for (const block of section.blocks) overview.push([clip(section.heading, max), clip(block.type === "paragraph" ? `${block.text}${cite(block.claimKeys)}` : `${block.caption}${cite(block.claimKeys)}`, max)]);
  }
  for (const entry of document.limitations) overview.push([labels.report.limitations, clip(entry, max)]);
  const sheets = [
    { name: clip(labels.report.summary, 31), title: clip(document.title, ARTIFACT_LIMITS.maxTitleLength),
      columns: [{ header: labels.taskColumnSection }, { header: labels.taskColumnContent }], rows: overview.slice(0, ARTIFACT_LIMITS.maxRowsPerSheet) },
    ...reportTableWorksheets(document, ARTIFACT_LIMITS.maxWorksheets - 2),
  ];
  if (document.bibliography.length) sheets.push({ name: clip(labels.report.sources, 31), title: clip(labels.report.sources, ARTIFACT_LIMITS.maxTitleLength),
    columns: [{ header: "#" }, { header: labels.taskColumnSource }, { header: labels.taskColumnLink }, { header: labels.taskColumnRetrieved }],
    rows: document.bibliography.slice(0, ARTIFACT_LIMITS.maxRowsPerSheet).map((entry) => [String(entry.n), clip(entry.title, max),
      entry.url ?? (entry.private ? labels.report.privateSource : ""), entry.retrievedAt.slice(0, 10)]) });
  return workbookSpecSchema.parse({ filename, format: "xlsx", worksheets: sheets });
}

/** A task slide deck: title, summary, each section's points and tables, closing notes and sources. */
export function reportPresentationSpec(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, labels: ResearchEngineCopy,
  quality: Quality, filename: string): PresentationSpec {
  const cite = citations(document, claims);
  const title = ARTIFACT_LIMITS.maxTitleLength;
  const notesMax = ARTIFACT_LIMITS.maxTextLength;
  const slides: ArtifactSlideSpec[] = [{ layout: "title", title: clip(document.title, title),
    subtitle: clip(`${labels.report.quality[quality]} · ${document.scope.currentDate}`, title) }];
  /** Full text goes to the speaker notes; the slide shows each point clipped to what a bullet can hold. */
  const pointSlides = (heading: string, points: string[]) => {
    for (let index = 0; index < points.length; index += BULLETS_PER_SLIDE) {
      const page = points.slice(index, index + BULLETS_PER_SLIDE);
      slides.push({ layout: "titleAndContent", title: clip(index ? `${heading} (${index / BULLETS_PER_SLIDE + 1})` : heading, title),
        bullets: page.map((point) => clip(point, title)), notes: clip(page.join("\n\n"), notesMax) });
    }
  };
  pointSlides(labels.report.summary, document.summary.split(/\n+/u).map((line) => line.trim()).filter(Boolean));
  for (const section of document.sections) {
    slides.push({ layout: "sectionHeader", title: clip(section.heading, title) });
    if (section.status === "missing") { pointSlides(section.heading, [labels.report.missingSection]); continue; }
    pointSlides(section.heading, section.blocks.flatMap((block) => block.type === "paragraph" ? [`${block.text}${cite(block.claimKeys)}`] : []));
    for (const block of section.blocks) {
      if (block.type !== "table") continue;
      pointSlides(`${block.caption}${cite(block.claimKeys)}`, block.rows.map((row) => row.map((cell, column) => `${block.columns[column] ?? ""}: ${cell}`).join(" · ")));
    }
  }
  if (document.conflicts.length) pointSlides(labels.report.conflicts, document.conflicts.map((conflict) => `${conflict.text}${cite(conflict.claimKeys)}`));
  if (document.limitations.length) pointSlides(labels.report.limitations, document.limitations);
  if (document.bibliography.length) pointSlides(labels.report.sources, document.bibliography.map((entry) => `[${entry.n}] ${sourceLine(entry, labels)}`));
  return presentationSpecSchema.parse({ filename, format: "pptx", slides: slides.slice(0, ARTIFACT_LIMITS.maxSlides) });
}

export type ResearchTaskFile = { format: "docx" | "xlsx" | "pptx"; filename: string; mediaType: string; bytes: Uint8Array };

/** The deliverable of a delegated task, rendered from the finished report. Throws ArtifactRenderError when it cannot be built. */
export function renderResearchTaskFile(input: { output: ResearchTaskOutput; document: ResearchReportDocument; claims: ReadonlyMap<string, ReportClaim>;
  labels: ResearchEngineCopy; quality: Quality }): ResearchTaskFile {
  const format = RESEARCH_TASK_FILE_FORMATS[input.output];
  const filename = sanitizeArtifactFilename(input.document.title, format);
  const rendered = input.output === "document"
    ? renderDocumentArtifact(reportDocumentSpec(input.document, input.claims, "docx", input.labels, input.quality, filename))
    : input.output === "spreadsheet"
      ? renderSpreadsheetArtifact(reportTaskWorkbookSpec(input.document, input.claims, input.labels, input.quality, filename))
      : renderPresentationArtifact(reportPresentationSpec(input.document, input.claims, input.labels, input.quality, filename));
  return { format, filename, mediaType: rendered.mediaType, bytes: rendered.bytes };
}
