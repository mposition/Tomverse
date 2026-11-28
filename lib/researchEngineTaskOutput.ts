import {
  ARTIFACT_LIMITS, documentSpecSchema, presentationSpecSchema, sanitizeArtifactFilename, workbookSpecSchema,
  type ArtifactSlideSpec, type DocumentSpec, type PresentationSpec, type WorkbookSpec,
} from "@/lib/generatedArtifactCore";
import { ArtifactRenderError, renderDocumentArtifact, renderPresentationArtifact, renderSpreadsheetArtifact } from "@/lib/generatedArtifactRenderers";
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

/**
 * The report does not fit the file kind's limits (ARTIFACT_LIMITS) however it is laid out. Nothing is
 * dropped to make it fit: the file is not made, and the answer says so (failure `content_too_large`).
 */
export class ResearchTaskFileOverflowError extends Error {
  constructor(detail: string) { super(detail); this.name = "ResearchTaskFileOverflowError"; }
}

/** Bullets on one generated slide when the deck has room: a layout choice for legibility, not a product limit. */
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

/**
 * The report as the existing document renderer's spec; citations become [n] markers that match the bibliography.
 * A bibliography longer than one list can hold continues in further lists that keep their [n] numbers.
 * `strict` (a task file) refuses a report with more blocks than a document holds instead of cutting it short;
 * the export keeps its earlier behaviour.
 */
export function reportDocumentSpec(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, format: "pdf" | "docx" | "md",
  labels: ResearchEngineCopy, quality: Quality, filename: string, options: { strict?: boolean } = {}): DocumentSpec {
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
  if (document.bibliography.length <= ARTIFACT_LIMITS.maxListItems) {
    if (document.bibliography.length) blocks.push({ type: "heading", level: 2, text: labels.report.sources },
      { type: "numbers", items: document.bibliography.map((entry) => clip(sourceLine(entry, labels), max)) });
  } else {
    blocks.push({ type: "heading", level: 2, text: labels.report.sources });
    for (let index = 0; index < document.bibliography.length; index += ARTIFACT_LIMITS.maxListItems) {
      blocks.push({ type: "bullets", items: document.bibliography.slice(index, index + ARTIFACT_LIMITS.maxListItems)
        .map((entry) => clip(`[${entry.n}] ${sourceLine(entry, labels)}`, max)) });
    }
  }
  if (options.strict && blocks.length > ARTIFACT_LIMITS.maxDocumentBlocks) {
    throw new ResearchTaskFileOverflowError(`${blocks.length} blocks exceed the ${ARTIFACT_LIMITS.maxDocumentBlocks} a document holds.`);
  }
  return documentSpecSchema.parse({ filename, format, title: clip(document.title, ARTIFACT_LIMITS.maxTitleLength), blocks: blocks.slice(0, ARTIFACT_LIMITS.maxDocumentBlocks) });
}

/** Every table of the report, in report order, named as the XLSX export names them. */
function reportTables(document: ResearchReportDocument, cite: (keys: readonly string[]) => string) {
  return document.sections.flatMap((section) => section.blocks.flatMap((block) => block.type === "table" ? [block] : [])
    .map((block, index) => ({ name: clip(`${section.key}-${index + 1}`, 31), caption: block.caption, label: `${section.heading} · ${block.caption}${cite(block.claimKeys)}`,
      columns: block.columns, rows: block.rows })));
}

/**
 * A task spreadsheet: the summary and every section first, then each report table on its own sheet, then the sources.
 * When there are more tables than sheets left, the last table sheet holds all the remaining tables one under another,
 * each opening with its own name and header row. Every table and row is kept; a report too large even then is refused.
 */
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
  type Sheet = { name: string; title: string; columns: Array<{ header: string }>; rows: string[][] };
  const sheets: Sheet[] = [{ name: clip(labels.report.summary, 31), title: clip(document.title, ARTIFACT_LIMITS.maxTitleLength),
    columns: [{ header: labels.taskColumnSection }, { header: labels.taskColumnContent }], rows: overview }];
  const tables = reportTables(document, cite);
  const room = ARTIFACT_LIMITS.maxWorksheets - 1 - (document.bibliography.length ? 1 : 0);
  const ownSheets = tables.length <= room ? tables : tables.slice(0, room - 1);
  for (const table of ownSheets) sheets.push({ name: table.name, title: clip(table.caption, ARTIFACT_LIMITS.maxTitleLength),
    columns: table.columns.map((header) => ({ header: clip(header, max) })), rows: table.rows });
  const stacked = tables.slice(ownSheets.length);
  if (stacked.length) {
    const width = Math.max(...stacked.map((table) => table.columns.length));
    sheets.push({ name: clip(labels.taskSheetMoreTables, 31), title: clip(labels.taskSheetMoreTables, ARTIFACT_LIMITS.maxTitleLength),
      columns: [{ header: labels.taskColumnTable }, ...Array.from({ length: width }, (_, index) => ({ header: String(index + 1) }))],
      rows: stacked.flatMap((table) => [[clip(table.label, max), ...table.columns], ...table.rows.map((row) => [clip(table.label, max), ...row])]) });
  }
  if (document.bibliography.length) sheets.push({ name: clip(labels.report.sources, 31), title: clip(labels.report.sources, ARTIFACT_LIMITS.maxTitleLength),
    columns: [{ header: "#" }, { header: labels.taskColumnSource }, { header: labels.taskColumnLink }, { header: labels.taskColumnRetrieved }],
    rows: document.bibliography.map((entry) => [String(entry.n), clip(entry.title, max), entry.url ?? (entry.private ? labels.report.privateSource : ""), entry.retrievedAt.slice(0, 10)]) });
  const cells = sheets.reduce((sum, sheet) => sum + sheet.columns.length + sheet.rows.reduce((rows, row) => rows + row.length, 0), 0);
  const longest = Math.max(...sheets.map((sheet) => sheet.rows.length));
  if (cells > ARTIFACT_LIMITS.maxCells || longest > ARTIFACT_LIMITS.maxRowsPerSheet) {
    throw new ResearchTaskFileOverflowError(`${cells} cells and ${longest} rows on one sheet exceed what a workbook holds.`);
  }
  return workbookSpecSchema.parse({ filename, format: "xlsx", worksheets: sheets });
}

/**
 * A task slide deck: title, summary, each section's points and tables, closing notes and sources. Each slide's
 * speaker notes hold its heading and the full text of every point, so a bullet shortened to fit the slide loses
 * nothing from the file. When six points a slide would pass the slide limit, the deck is laid out denser (the
 * most bullets a slide holds) and then without section divider slides, which carry no content of their own;
 * a report that still does not fit is refused, never cut short.
 */
export function reportPresentationSpec(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, labels: ResearchEngineCopy,
  quality: Quality, filename: string): PresentationSpec {
  const cite = citations(document, claims);
  const title = ARTIFACT_LIMITS.maxTitleLength;
  const notesMax = ARTIFACT_LIMITS.maxTextLength;
  const deck = (perSlide: number, dividers: boolean) => {
    const slides: ArtifactSlideSpec[] = [{ layout: "title", title: clip(document.title, title),
      subtitle: clip(`${labels.report.quality[quality]} · ${document.scope.currentDate}`, title), notes: clip(document.title, notesMax) }];
    const pointSlides = (heading: string, points: string[]) => {
      let page: string[] = [];
      let part = 0;
      const flush = () => {
        if (!page.length) return;
        part += 1;
        slides.push({ layout: "titleAndContent", title: part > 1 ? `${clip(heading, title - 8)} (${part})` : clip(heading, title),
          bullets: page.map((point) => clip(point, title)), notes: [heading, ...page].join("\n\n") });
        page = [];
      };
      for (const point of points) {
        const notes = [heading, ...page, point].join("\n\n").length;
        if (page.length && (page.length >= perSlide || notes > notesMax)) flush();
        page.push(point);
      }
      flush();
    };
    pointSlides(labels.report.summary, document.summary.split(/\n+/u).map((line) => line.trim()).filter(Boolean));
    for (const section of document.sections) {
      if (dividers) slides.push({ layout: "sectionHeader", title: clip(section.heading, title), notes: section.heading });
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
    return slides;
  };
  for (const [perSlide, dividers] of [[BULLETS_PER_SLIDE, true], [ARTIFACT_LIMITS.maxSlideBullets, true], [ARTIFACT_LIMITS.maxSlideBullets, false]] as const) {
    const slides = deck(perSlide, dividers);
    if (slides.length <= ARTIFACT_LIMITS.maxSlides) return presentationSpecSchema.parse({ filename, format: "pptx", slides });
  }
  throw new ResearchTaskFileOverflowError(`The report needs more than ${ARTIFACT_LIMITS.maxSlides} slides.`);
}

export type ResearchTaskFile = { format: "docx" | "xlsx" | "pptx"; filename: string; mediaType: string; bytes: Uint8Array };

/**
 * The deliverable of a delegated task, rendered from the finished report. Throws ResearchTaskFileOverflowError
 * when the report does not fit the file kind (including the rendered size limit), ArtifactRenderError otherwise.
 */
export function renderResearchTaskFile(input: { output: ResearchTaskOutput; document: ResearchReportDocument; claims: ReadonlyMap<string, ReportClaim>;
  labels: ResearchEngineCopy; quality: Quality }): ResearchTaskFile {
  const format = RESEARCH_TASK_FILE_FORMATS[input.output];
  const filename = sanitizeArtifactFilename(input.document.title, format);
  try {
    const rendered = input.output === "document"
      ? renderDocumentArtifact(reportDocumentSpec(input.document, input.claims, "docx", input.labels, input.quality, filename, { strict: true }))
      : input.output === "spreadsheet"
        ? renderSpreadsheetArtifact(reportTaskWorkbookSpec(input.document, input.claims, input.labels, input.quality, filename))
        : renderPresentationArtifact(reportPresentationSpec(input.document, input.claims, input.labels, input.quality, filename));
    return { format, filename, mediaType: rendered.mediaType, bytes: rendered.bytes };
  } catch (error) {
    if (error instanceof ArtifactRenderError && error.code === "OUTPUT_TOO_LARGE") throw new ResearchTaskFileOverflowError(error.message);
    throw error;
  }
}
