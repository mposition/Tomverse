import { ZodError } from "zod";
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
 *
 * Every field of the report document reaches every file kind (RESEARCH_REPORT_FILE_PLACEMENT): a file
 * that left out the conflicts or the unmet criteria would read as more certain than the report is.
 * Text is never cut short to fit; it is split across paragraphs, rows or bullets, and a report that does
 * not fit the file kind's limits is refused (ResearchTaskFileOverflowError -> `content_too_large`).
 */

type Quality = "complete" | "partial" | "insufficient_evidence";

/** Default off. Only the exact value "true" turns it on, and only while the Research engine itself is on. */
export const chatTaskAgentEnabled = (env: Record<string, string | undefined>) =>
  env.RESEARCH_ENGINE_ENABLED === "true" && env.CHAT_TASK_AGENT_ENABLED === "true";

export const RESEARCH_TASK_FILE_FORMATS: Readonly<Record<ResearchTaskOutput, "docx" | "xlsx" | "pptx">> = {
  document: "docx", spreadsheet: "xlsx", presentation: "pptx",
};

/**
 * Where each field of the report document (researchReportDocumentSchema, by path) lands in each file kind.
 * "internal" fields are identifiers, not content. tests/researchEngineTask.test.ts compares these keys with
 * the schema, so a field added to the report fails the test until it is placed here and laid out.
 */
export const RESEARCH_REPORT_FILE_PLACEMENT = {
  "version": "internal",
  "title": { docx: "document title", xlsx: "title row of the Summary sheet", pptx: "title slide" },
  "summary": { docx: "Summary section", xlsx: "Summary sheet rows", pptx: "Summary slides" },
  "scope.question": { docx: "Scope section", xlsx: "Summary sheet, Scope rows", pptx: "Scope slides" },
  "scope.note": { docx: "Scope section", xlsx: "Summary sheet, Scope rows", pptx: "Scope slides" },
  "scope.assumptions": { docx: "Scope section list", xlsx: "Summary sheet, Scope rows", pptx: "Scope slides" },
  "scope.currentDate": { docx: "Scope section", xlsx: "Summary sheet, Scope rows", pptx: "title slide subtitle and Scope slides" },
  "sections.key": "internal",
  "sections.heading": { docx: "section heading", xlsx: "Summary sheet row labels and table names", pptx: "divider and slide titles" },
  "sections.status": { docx: "missing-section note", xlsx: "Summary sheet row", pptx: "slide point" },
  "sections.blocks.type": "internal",
  "sections.blocks.text": { docx: "paragraphs", xlsx: "Summary sheet rows", pptx: "slide points, full text in notes" },
  "sections.blocks.claimKeys": { docx: "[n] markers and verification flags", xlsx: "[n] markers and verification flags", pptx: "[n] markers and verification flags" },
  "sections.blocks.caption": { docx: "table caption", xlsx: "Summary sheet row and table sheet title", pptx: "table slide title" },
  "sections.blocks.columns": { docx: "table header", xlsx: "table sheet header", pptx: "table slide points" },
  "sections.blocks.rows": { docx: "table rows", xlsx: "table sheet rows", pptx: "table slide points" },
  "conflicts.text": { docx: "Conflicting information list", xlsx: "Summary sheet rows", pptx: "Conflicting information slides" },
  "conflicts.claimKeys": { docx: "[n] markers and verification flags", xlsx: "[n] markers and verification flags", pptx: "[n] markers and verification flags" },
  "limitations": { docx: "Limitations list", xlsx: "Summary sheet rows", pptx: "Limitations slides" },
  "nextQuestions": { docx: "Next questions list", xlsx: "Summary sheet rows", pptx: "Next questions slides" },
  "criteria.criterion": { docx: "Completion criteria list", xlsx: "Summary sheet rows", pptx: "Completion criteria slides" },
  "criteria.met": { docx: "met / not met", xlsx: "met / not met", pptx: "met / not met" },
  "bibliography.n": { docx: "source number", xlsx: "Sources sheet #", pptx: "[n] on Sources slides" },
  "bibliography.sourceKey": "internal",
  "bibliography.versionId": "internal",
  "bibliography.title": { docx: "source line", xlsx: "Sources sheet", pptx: "Sources slides" },
  "bibliography.url": { docx: "source line", xlsx: "Sources sheet link", pptx: "Sources slides" },
  "bibliography.private": { docx: "private source note", xlsx: "Sources sheet notes", pptx: "Sources slides" },
  "bibliography.readStatus": { docx: "snippet-only note", xlsx: "Sources sheet notes", pptx: "Sources slides" },
  "bibliography.retrievedAt": { docx: "source line", xlsx: "Sources sheet", pptx: "Sources slides" },
  "bibliography.publishedAt": { docx: "source line", xlsx: "Sources sheet", pptx: "Sources slides" },
  "bibliography.duplicateOf": { docx: "republishes note", xlsx: "Sources sheet notes", pptx: "Sources slides" },
} as const;

/**
 * The report does not fit the file kind's limits (ARTIFACT_LIMITS) however it is laid out. Nothing is
 * dropped to make it fit: the file is not made, and the answer says so (failure `content_too_large`).
 */
export class ResearchTaskFileOverflowError extends Error {
  constructor(detail: string) { super(detail); this.name = "ResearchTaskFileOverflowError"; }
}

/** Bullets on one generated slide when the deck has room: a layout choice for legibility, not a product limit. */
const BULLETS_PER_SLIDE = 6;
const TEXT = ARTIFACT_LIMITS.maxTextLength;
const TITLE = ARTIFACT_LIMITS.maxTitleLength;

/** For short labels only (headings, captions, slide titles); content text is split with `pieces`, never clipped. */
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
/** Text longer than one value may hold, in consecutive pieces that together are the whole text. */
const pieces = (text: string, max: number = TEXT) => {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (let index = 0; index < text.length; index += max) out.push(text.slice(index, index + max));
  return out;
};

/** `[n]` markers and, for anything not fully supported, its verification: the same marks the chat answer shows. */
function citations(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, labels: ResearchEngineCopy) {
  const numberOf = new Map(document.bibliography.map((entry) => [entry.sourceKey, entry.n]));
  return (keys: readonly string[]) => {
    const numbers = [...new Set(keys.flatMap((key) => (claims.get(key)?.evidence ?? []).map((evidence) => numberOf.get(evidence.sourceKey))
      .filter((value): value is number => value !== undefined)))].sort((a, b) => a - b);
    const flags = [...new Set(keys.map((key) => claims.get(key)?.verification).filter((value) => value && value !== "supported"))]
      .map((value) => labels.report.verification[value as ReportClaim["verification"]]);
    return `${numbers.length ? ` ${numbers.map((n) => `[${n}]`).join("")}` : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  };
}

/** Everything the report says about one source, after its title. */
function sourceNotes(document: ResearchReportDocument, entry: ResearchReportDocument["bibliography"][number], labels: ResearchEngineCopy) {
  const numberOf = new Map(document.bibliography.map((source) => [source.sourceKey, source.n]));
  return [entry.private ? labels.report.privateSource : "", entry.readStatus === "snippet_only" ? labels.report.snippetOnly : "",
    entry.duplicateOf ? `${labels.report.republishes} [${numberOf.get(entry.duplicateOf) ?? entry.duplicateOf}]` : ""].filter(Boolean).join(" · ");
}
const sourceLine = (document: ResearchReportDocument, entry: ResearchReportDocument["bibliography"][number], labels: ResearchEngineCopy) =>
  [`${entry.title}${entry.url ? ` — ${entry.url}` : ""}`, sourceNotes(document, entry, labels),
    entry.publishedAt ? `${labels.taskColumnPublished} ${entry.publishedAt.slice(0, 10)}` : "", `${labels.taskColumnRetrieved} ${entry.retrievedAt.slice(0, 10)}`]
    .filter(Boolean).join(" · ");

/** The report outside its sections, as labelled groups of points, in reading order. */
function reportFrame(document: ResearchReportDocument, labels: ResearchEngineCopy, cite: (keys: readonly string[]) => string) {
  const scope = [`${labels.taskLabelQuestion}: ${document.scope.question}`, ...(document.scope.note ? [document.scope.note] : []),
    ...document.scope.assumptions.map((assumption) => `${labels.planAssumptions}: ${assumption}`), `${labels.taskLabelDate}: ${document.scope.currentDate}`];
  return {
    summary: { heading: labels.report.summary, points: document.summary.split(/\n+/u).map((line) => line.trim()).filter(Boolean) },
    scope: { heading: labels.report.scope, points: scope },
    closing: [
      { heading: labels.report.conflicts, points: document.conflicts.map((conflict) => `${conflict.text}${cite(conflict.claimKeys)}`) },
      { heading: labels.report.criteria, points: document.criteria.map((criterion) => `${criterion.met ? labels.report.met : labels.report.notMet}: ${criterion.criterion}`) },
      { heading: labels.report.limitations, points: document.limitations },
      { heading: labels.report.nextQuestions, points: document.nextQuestions },
    ].filter((group) => group.points.length),
  };
}

/**
 * A report table at its full width: every column header, and every row padded with empty cells to the widest of
 * the header and the rows (the report schema lets a row be shorter or longer than its header). A cell past the
 * last header keeps its place under `header(index)` rather than being dropped.
 */
function fullTable(block: { columns: readonly string[]; rows: ReadonlyArray<readonly string[]> }, header: (index: number) => string = () => "") {
  const width = block.rows.reduce((widest, row) => Math.max(widest, row.length), block.columns.length);
  return {
    columns: Array.from({ length: width }, (_, index) => block.columns[index] ?? header(index)),
    rows: block.rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? "")),
  };
}

/** Lists of at most `maxListItems` items; a longer list continues in the next one. */
const lists = (type: "bullets" | "numbers", items: string[]) => {
  const blocks: Array<Record<string, unknown>> = [];
  for (let index = 0; index < items.length; index += ARTIFACT_LIMITS.maxListItems) blocks.push({ type, items: items.slice(index, index + ARTIFACT_LIMITS.maxListItems) });
  return blocks;
};

/**
 * The report as the existing document renderer's spec; citations become [n] markers that match the bibliography.
 * A bibliography longer than one list can hold continues in further lists that keep their [n] numbers.
 * `strict` (a task file) refuses a report with more blocks than a document holds instead of cutting it short;
 * the export keeps its earlier behaviour.
 */
export function reportDocumentSpec(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, format: "pdf" | "docx" | "md",
  labels: ResearchEngineCopy, quality: Quality, filename: string, options: { strict?: boolean } = {}): DocumentSpec {
  const cite = citations(document, claims, labels);
  const frame = reportFrame(document, labels, cite);
  const paragraphs = (text: string) => pieces(text).map((piece) => ({ type: "paragraph", text: piece }));
  const items = (values: string[]) => values.flatMap((value) => pieces(value));
  const blocks: Array<Record<string, unknown>> = [
    { type: "paragraph", text: labels.report.quality[quality] },
    { type: "heading", level: 2, text: frame.summary.heading }, ...paragraphs(document.summary),
    { type: "heading", level: 2, text: frame.scope.heading }, ...frame.scope.points.flatMap(paragraphs),
  ];
  for (const section of document.sections) {
    blocks.push({ type: "heading", level: 2, text: clip(section.heading, TITLE) });
    if (section.status === "missing") { blocks.push({ type: "paragraph", text: labels.report.missingSection }); continue; }
    for (const block of section.blocks) {
      if (block.type === "paragraph") blocks.push(...paragraphs(`${block.text}${cite(block.claimKeys)}`));
      else {
        blocks.push(...paragraphs(`${block.caption}${cite(block.claimKeys)}`));
        // The document writer draws as many cells as there are headers, so the table goes in at its full width.
        // A task file keeps every row and column; one over a document table's limits is refused by the schema below.
        const table = fullTable(block);
        blocks.push(options.strict ? { type: "table", ...table }
          : { type: "table", columns: table.columns.slice(0, ARTIFACT_LIMITS.maxDocumentTableColumns).map((column) => clip(column, TITLE)),
            rows: table.rows.slice(0, ARTIFACT_LIMITS.maxDocumentTableRows).map((row) => row.slice(0, ARTIFACT_LIMITS.maxDocumentTableColumns)) });
      }
    }
  }
  for (const group of frame.closing) blocks.push({ type: "heading", level: 2, text: group.heading }, ...lists("bullets", items(group.points)));
  if (document.bibliography.length) {
    blocks.push({ type: "heading", level: 2, text: labels.report.sources });
    const lines = document.bibliography.map((entry) => sourceLine(document, entry, labels));
    // A numbered list only while its numbers are the [n] numbers: one list, one item per source.
    blocks.push(...(lines.length <= ARTIFACT_LIMITS.maxListItems && lines.every((line) => line.length <= TEXT)
      ? lists("numbers", lines)
      : lists("bullets", items(document.bibliography.map((entry, index) => `[${entry.n}] ${lines[index]}`)))));
  }
  if (options.strict && blocks.length > ARTIFACT_LIMITS.maxDocumentBlocks) {
    throw new ResearchTaskFileOverflowError(`${blocks.length} blocks exceed the ${ARTIFACT_LIMITS.maxDocumentBlocks} a document holds.`);
  }
  return documentSpecSchema.parse({ filename, format, title: clip(document.title, TITLE), blocks: blocks.slice(0, ARTIFACT_LIMITS.maxDocumentBlocks) });
}

/** Every table of the report, in report order, named as the XLSX export names them. */
function reportTables(document: ResearchReportDocument, cite: (keys: readonly string[]) => string) {
  return document.sections.flatMap((section) => section.blocks.flatMap((block) => block.type === "table" ? [block] : [])
    // A spreadsheet header cell cannot be empty: a column past the report's headers is named by its position.
    .map((block, index) => ({ name: clip(`${section.key}-${index + 1}`, 31), caption: block.caption, label: `${section.heading} · ${block.caption}${cite(block.claimKeys)}`,
      ...fullTable(block, (column) => String(column + 1)) })));
}

/**
 * A task spreadsheet. The Summary sheet holds everything outside the tables as label/text rows: the quality,
 * summary, scope (question, note, assumptions, date), every section's text, the conflicts, completion criteria,
 * limitations and next questions. Each report table follows on its own sheet; when there are more tables than
 * sheets left, the last table sheet holds the remaining tables one under another, each opening with its own
 * name and header row. The Sources sheet closes it. A report too large even then is refused.
 */
export function reportTaskWorkbookSpec(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, labels: ResearchEngineCopy,
  quality: Quality, filename: string): WorkbookSpec {
  const cite = citations(document, claims, labels);
  const frame = reportFrame(document, labels, cite);
  const overview: string[][] = [[labels.report.quality[quality], ""]];
  const rows = (label: string, text: string) => { for (const piece of pieces(text)) overview.push([clip(label, TEXT), piece]); };
  for (const point of frame.summary.points) rows(frame.summary.heading, point);
  for (const point of frame.scope.points) rows(frame.scope.heading, point);
  for (const section of document.sections) {
    if (section.status === "missing") { rows(section.heading, labels.report.missingSection); continue; }
    for (const block of section.blocks) rows(section.heading, block.type === "paragraph" ? `${block.text}${cite(block.claimKeys)}` : `${block.caption}${cite(block.claimKeys)}`);
  }
  for (const group of frame.closing) for (const point of group.points) rows(group.heading, point);
  type Sheet = { name: string; title: string; columns: Array<{ header: string }>; rows: string[][] };
  const sheets: Sheet[] = [{ name: clip(labels.report.summary, 31), title: clip(document.title, TITLE),
    columns: [{ header: labels.taskColumnSection }, { header: labels.taskColumnContent }], rows: overview }];
  const tables = reportTables(document, cite);
  const room = ARTIFACT_LIMITS.maxWorksheets - 1 - (document.bibliography.length ? 1 : 0);
  const ownSheets = tables.length <= room ? tables : tables.slice(0, room - 1);
  for (const table of ownSheets) sheets.push({ name: table.name, title: clip(table.caption, TITLE),
    columns: table.columns.map((header) => ({ header })), rows: table.rows });
  const stacked = tables.slice(ownSheets.length);
  if (stacked.length) {
    const width = Math.max(...stacked.map((table) => table.columns.length));
    sheets.push({ name: clip(labels.taskSheetMoreTables, 31), title: clip(labels.taskSheetMoreTables, TITLE),
      columns: [{ header: labels.taskColumnTable }, ...Array.from({ length: width }, (_, index) => ({ header: String(index + 1) }))],
      rows: stacked.flatMap((table) => [[table.label, ...table.columns], ...table.rows.map((row) => [table.label, ...row])]) });
  }
  if (document.bibliography.length) sheets.push({ name: clip(labels.report.sources, 31), title: clip(labels.report.sources, TITLE),
    columns: [{ header: "#" }, { header: labels.taskColumnSource }, { header: labels.taskColumnLink }, { header: labels.taskColumnPublished },
      { header: labels.taskColumnRetrieved }, { header: labels.taskColumnNotes }],
    rows: document.bibliography.map((entry) => [String(entry.n), entry.title, entry.url ?? "", entry.publishedAt?.slice(0, 10) ?? "",
      entry.retrievedAt.slice(0, 10), sourceNotes(document, entry, labels)]) });
  let cells = 0;
  let longest = 0;
  let longestCell = 0;
  for (const sheet of sheets) {
    cells += sheet.columns.length;
    longest = Math.max(longest, sheet.rows.length);
    for (const row of sheet.rows) { cells += row.length; for (const cell of row) longestCell = Math.max(longestCell, cell.length); }
  }
  if (cells > ARTIFACT_LIMITS.maxCells || longest > ARTIFACT_LIMITS.maxRowsPerSheet || longestCell > TEXT) {
    throw new ResearchTaskFileOverflowError(`${cells} cells, ${longest} rows on one sheet or a ${longestCell}-character cell exceed what a workbook holds.`);
  }
  return workbookSpecSchema.parse({ filename, format: "xlsx", worksheets: sheets });
}

/**
 * A task slide deck: the title slide (title, quality, date), then Summary, Scope, each section's points and
 * tables, Conflicting information, Completion criteria, Limitations, Next questions and Sources. Each slide's
 * speaker notes hold its heading and the full text of every point, so a bullet shortened to fit the slide loses
 * nothing from the file. When six points a slide would pass the slide limit, the deck is laid out denser (the
 * most bullets a slide holds) and then without section divider slides, which carry no content of their own;
 * a report that still does not fit is refused, never cut short.
 */
export function reportPresentationSpec(document: ResearchReportDocument, claims: ReadonlyMap<string, ReportClaim>, labels: ResearchEngineCopy,
  quality: Quality, filename: string): PresentationSpec {
  const cite = citations(document, claims, labels);
  const frame = reportFrame(document, labels, cite);
  const deck = (perSlide: number, dividers: boolean) => {
    const slides: ArtifactSlideSpec[] = [{ layout: "title", title: clip(document.title, TITLE),
      subtitle: clip(`${labels.report.quality[quality]} · ${document.scope.currentDate}`, TITLE), notes: document.title }];
    const pointSlides = (heading: string, points: string[]) => {
      // A heading and point together always fit the notes: a point is split to leave the heading room.
      const room = Math.max(1, TEXT - heading.length - 2);
      let page: string[] = [];
      let part = 0;
      const flush = () => {
        if (!page.length) return;
        part += 1;
        slides.push({ layout: "titleAndContent", title: part > 1 ? `${clip(heading, TITLE - 8)} (${part})` : clip(heading, TITLE),
          bullets: page.map((point) => clip(point, TITLE)), notes: [heading, ...page].join("\n\n") });
        page = [];
      };
      for (const point of points.flatMap((value) => pieces(value, room))) {
        if (page.length && (page.length >= perSlide || [heading, ...page, point].join("\n\n").length > TEXT)) flush();
        page.push(point);
      }
      flush();
    };
    pointSlides(frame.summary.heading, frame.summary.points);
    pointSlides(frame.scope.heading, frame.scope.points);
    for (const section of document.sections) {
      if (dividers) slides.push({ layout: "sectionHeader", title: clip(section.heading, TITLE), notes: section.heading });
      if (section.status === "missing") { pointSlides(section.heading, [labels.report.missingSection]); continue; }
      pointSlides(section.heading, section.blocks.flatMap((block) => block.type === "paragraph" ? [`${block.text}${cite(block.claimKeys)}`] : []));
      for (const block of section.blocks) {
        if (block.type !== "table") continue;
        // The header is its own first point, so every column title is on the slide and in the notes however short
        // the rows are; each row then names every column, an empty cell left empty.
        const table = fullTable(block);
        pointSlides(`${block.caption}${cite(block.claimKeys)}`, [table.columns.join(" · "),
          ...table.rows.map((row) => row.map((cell, column) => table.columns[column] ? `${table.columns[column]}: ${cell}` : cell).join(" · "))]);
      }
    }
    for (const group of frame.closing) pointSlides(group.heading, group.points);
    if (document.bibliography.length) pointSlides(labels.report.sources, document.bibliography.map((entry) => `[${entry.n}] ${sourceLine(document, entry, labels)}`));
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
 * when the report does not fit the file kind (a spec over a limit, or the rendered size limit), ArtifactRenderError otherwise.
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
    // The builders above produce only valid shapes; a spec the schema refuses went past one of its limits.
    if (error instanceof ZodError) throw new ResearchTaskFileOverflowError(error.issues[0]?.message ?? "The report exceeds a file limit.");
    throw error;
  }
}
