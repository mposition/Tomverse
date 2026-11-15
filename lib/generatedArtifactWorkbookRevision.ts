import {
  ARTIFACT_LIMITS, ARTIFACT_NUMBER_FORMATS, admitWorkbookSpecSafely,
  type ArtifactCellValue, type ArtifactNumberFormat, type WorkbookSpec,
} from "@/lib/generatedArtifactCore";
import { MAX_EXTRACTED_ATTACHMENT_CHARACTERS } from "@/lib/chatAttachmentLimits";
import { readSpreadsheetGrid } from "@/lib/spreadsheetDataRows";
import { parseArtifactDate } from "@/lib/generatedArtifactXlsx";

export type CanonicalWorkbookSpec = {
  version: 1;
  kind: "spreadsheet";
  spec: WorkbookSpec;
  /** Old files retain the parsed typed grid, not unavailable original layout metadata. */
  fidelity?: "values";
};

export class WorkbookRevisionError extends Error {
  readonly status: number;
  constructor(readonly code: "ATTACHMENT_TEXT_TOO_LARGE" | "UNSUPPORTED_ATTACHMENT_TYPE" | "ATTACHMENT_UNREADABLE") {
    super(code); this.name = "WorkbookRevisionError";
    this.status = code === "ATTACHMENT_TEXT_TOO_LARGE" ? 413 : 400;
  }
}

const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const xmlText = (value: string) => decoder.decode(encoder.encode(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")));
const jsonText = (value: string) => !value.includes("\0") && decoder.decode(encoder.encode(value)) === value;

/** No larger than a whole Chat input; no new retention-sized copy of huge outputs. */
export function parseCanonicalWorkbookSpec(value: unknown): CanonicalWorkbookSpec | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.kind !== "spreadsheet" ||
      Object.keys(record).some(key => !["version", "kind", "spec", "fidelity"].includes(key)) ||
      (record.fidelity !== undefined && record.fidelity !== "values")) return null;
  const admitted = admitWorkbookSpecSafely(record.spec);
  if (!admitted.ok || admitted.spec.format !== "xlsx") return null;
  // Count before serialising; a valid per-cell maximum must not multiply into
  // a gigantic JSON allocation merely to discover that it cannot be retained.
  let characters = 0;
  if (!jsonText(admitted.spec.filename)) return null;
  for (const sheet of admitted.spec.worksheets) {
    if (!jsonText(sheet.name) || !jsonText(sheet.title ?? "")) return null;
    characters += sheet.name.length + (sheet.title?.length ?? 0);
    for (const column of sheet.columns) {
      if (!jsonText(column.header) || !jsonText(column.key ?? "")) return null;
      characters += column.header.length + (column.key?.length ?? 0);
    }
    for (const row of sheet.rows) for (const cell of row) {
      if (typeof cell === "string" && !jsonText(cell)) return null;
      characters += typeof cell === "string" ? cell.length : 8;
    }
    if (characters > MAX_EXTRACTED_ATTACHMENT_CHARACTERS) return null;
  }
  const envelope: CanonicalWorkbookSpec = { version: 1, kind: "spreadsheet", spec: admitted.spec,
    ...(record.fidelity === "values" ? { fidelity: "values" as const } : {}) };
  const json = JSON.stringify(envelope);
  if (json.length > MAX_EXTRACTED_ATTACHMENT_CHARACTERS) return null;
  return envelope;
}

/** The stored source reflects the trusted XML writer's character normalisation. */
export function canonicalWorkbookSpecFor(spec: WorkbookSpec, fidelity?: "values"): CanonicalWorkbookSpec | null {
  if (spec.worksheets.some(sheet => sheet.rows.some(row => row.some((cell, index) =>
    typeof cell === "string" && sheet.columns[index]?.type === "date" && xmlText(cell) !== cell)))) return null;
  const normalized: WorkbookSpec = { ...spec, filename: xmlText(spec.filename), worksheets: spec.worksheets.map(sheet => ({
    ...sheet, name: xmlText(sheet.name), ...(sheet.title === undefined ? {} : { title: xmlText(sheet.title) }),
    columns: sheet.columns.map(column => ({ ...column, header: xmlText(column.header),
      ...(column.key === undefined ? {} : { key: xmlText(column.key) }) })),
    rows: sheet.rows.map(row => row.map(cell => typeof cell === "string" ? xmlText(cell) : cell)),
  })) };
  return parseCanonicalWorkbookSpec({ version: 1, kind: "spreadsheet", spec: normalized,
    ...(fidelity ? { fidelity } : {}) });
}

export type WorkbookCellUpdate = { sheet: string; row: number; column: number; value: ArtifactCellValue };

/** One narrow spreadsheet operation: replace existing data cells, keep every other spec field. */
export function reviseCanonicalWorkbook(source: CanonicalWorkbookSpec, filename: string, updates: readonly WorkbookCellUpdate[]): WorkbookSpec {
  const admitted = parseCanonicalWorkbookSpec(source);
  if (!admitted || updates.length === 0 || updates.length > ARTIFACT_LIMITS.maxCells) {
    throw new WorkbookRevisionError("UNSUPPORTED_ATTACHMENT_TYPE");
  }
  const result: WorkbookSpec = { ...admitted.spec, filename,
    worksheets: admitted.spec.worksheets.map(sheet => ({ ...sheet,
      columns: sheet.columns.map(column => ({ ...column })), rows: sheet.rows.map(row => [...row]) })) };
  const seen = new Set<string>();
  for (const update of updates) {
    const sheet = result.worksheets.find(entry => entry.name === update.sheet);
    const key = JSON.stringify([update.sheet, update.row, update.column]);
    if (!sheet || !Number.isInteger(update.row) || !Number.isInteger(update.column) || update.row < 1 ||
        update.row > sheet.rows.length || update.column < 1 || update.column > sheet.columns.length || seen.has(key)) {
      throw new WorkbookRevisionError("UNSUPPORTED_ATTACHMENT_TYPE");
    }
    seen.add(key);
    sheet.rows[update.row - 1][update.column - 1] = update.value;
  }
  const complete = admitWorkbookSpecSafely(result);
  if (!complete.ok) throw new WorkbookRevisionError("UNSUPPORTED_ATTACHMENT_TYPE");
  return complete.spec;
}

type LegacyCell = { type: string; text: string; formula?: boolean; bold?: boolean; metadata?: {
  row?: number; col?: number; rowSpan?: number; colSpan?: number; hidden?: boolean;
  valueType?: string; value?: string; numberFormat?: string;
} };
type LegacySheet = { type: string; metadata?: { sheetName?: string; hidden?: boolean };
  rows?: Array<{ type: string; metadata?: { hidden?: boolean }; cells?: LegacyCell[] }> };

/** Existing parser AST -> the existing values-only writer. No XML parser or formula evaluator. */
export function workbookFromOfficeAst(raw: unknown[], filename: string,
  physicalSheets: ReadonlyMap<string, ReturnType<typeof readSpreadsheetGrid>>): CanonicalWorkbookSpec {
  const unsupported = () => new WorkbookRevisionError("UNSUPPORTED_ATTACHMENT_TYPE");
  if (!raw.length || raw.length > ARTIFACT_LIMITS.maxWorksheets) throw unsupported();
  const worksheets: WorkbookSpec["worksheets"] = raw.map(value => {
    const sheet = value as LegacySheet;
    if (sheet.type !== "sheet" || !sheet.metadata?.sheetName || sheet.metadata.hidden || !sheet.rows) throw unsupported();
    const physical = physicalSheets.get(sheet.metadata.sheetName);
    if (!physical || physical.hasFormulas || physical.hasMergedCells ||
        (physical.headerRow !== 0 && physical.headerRow !== 1)) throw unsupported();
    const headerIndex = physical.headerRow;
    const width = physical.grid[headerIndex]?.length ?? 0;
    if (!width || width > ARTIFACT_LIMITS.maxColumnsPerSheet ||
        physical.grid.length > ARTIFACT_LIMITS.maxRowsPerSheet + headerIndex + 1 ||
        physical.grid.some(row => row.length > width)) throw unsupported();
    const grid: ArtifactCellValue[][] = physical.grid.map(() => Array<ArtifactCellValue>(width).fill(null));
    const formats = new Map<number, ArtifactNumberFormat>();
    const dateColumns = new Set<number>();
    const dateTextColumns = new Set<number>();
    for (const row of sheet.rows) {
      if (row.type !== "row" || row.metadata?.hidden) throw unsupported();
      for (const cell of row.cells ?? []) {
        const meta = cell.metadata;
        if (cell.type !== "cell" || !meta || cell.formula || meta.hidden ||
            !Number.isInteger(meta.row) || !Number.isInteger(meta.col) || meta.row! < 0 || meta.col! < 0 ||
            meta.row! > ARTIFACT_LIMITS.maxRowsPerSheet + 2 || meta.col! >= ARTIFACT_LIMITS.maxColumnsPerSheet ||
            (meta.rowSpan ?? 1) > 1 || (meta.colSpan ?? 1) > 1 || meta.row! >= grid.length || meta.col! >= width) throw unsupported();
        const cells = grid[meta.row!];
        if (cells[meta.col!] !== null) throw unsupported();
        let held: ArtifactCellValue = cell.text;
        const type = meta.valueType;
        if (type === "number" || type === "date" || type === "time") {
          const number = Number(meta.value ?? cell.text);
          if (!Number.isFinite(number)) throw unsupported();
          // The trusted writer accepts ISO date strings, not spreadsheet serials.
          if (type === "date") {
            const date = new Date(Date.UTC(1899, 11, 30) + number * 86_400_000);
            if (!Number.isFinite(date.getTime())) throw unsupported();
            held = date.toISOString().replace(/T00:00:00\.000Z$/, ""); dateColumns.add(meta.col!);
          } else held = number;
        } else if (type === "boolean") {
          const bool = (meta.value ?? cell.text).toLowerCase();
          if (!["true", "false", "1", "0"].includes(bool)) throw unsupported();
          held = bool === "true" || bool === "1";
        } else if (type === "error") throw unsupported();
        else if (parseArtifactDate(cell.text)) dateTextColumns.add(meta.col!);
        const format = meta.numberFormat;
        if (format && !["General", "general", "@"].includes(format)) {
          const named = (Object.entries(ARTIFACT_NUMBER_FORMATS).find(([, code]) => code === format)?.[0]) as ArtifactNumberFormat | undefined;
          if (!named || (formats.has(meta.col!) && formats.get(meta.col!) !== named)) throw unsupported();
          formats.set(meta.col!, named);
        }
        cells[meta.col!] = held;
      }
    }
    if ([...dateColumns].some(index => dateTextColumns.has(index))) throw unsupported();
    for (const key of physical.emptyTextCells ?? []) {
      const [row, column] = key.split(":").map(Number);
      if (!grid[row] || column >= width) throw unsupported();
      grid[row][column] = "";
    }
    const title = headerIndex === 1 ? grid[0][0] : undefined;
    if (headerIndex === 1 && (typeof title !== "string" || !title || grid[0].slice(1).some(value => value !== null))) throw unsupported();
    const header = grid[headerIndex];
    if (!header || !width || header.length > width || header.some(cell => typeof cell !== "string" || !cell)) throw unsupported();
    const columns = Array.from({ length: width }, (_, index) => {
      if (typeof header[index] !== "string" || !header[index]) throw unsupported();
      return { header: header[index] as string, type: dateColumns.has(index) ? "date" as const : "text" as const,
        ...(formats.has(index) ? { format: formats.get(index)! } : {}) };
    });
    const rows = grid.slice(headerIndex + 1).map(row => Array.from({ length: width }, (_, index) => row[index] ?? null));
    return { name: sheet.metadata.sheetName, ...(typeof title === "string" ? { title } : {}), columns, rows, freezeHeader: false };
  });
  const source = canonicalWorkbookSpecFor({ filename, format: "xlsx", worksheets, styleHeader: false }, "values");
  if (!source) throw new WorkbookRevisionError("ATTACHMENT_TEXT_TOO_LARGE");
  return source;
}

export async function prepareGeneratedWorkbookRevision(buffer: Buffer, canonicalSpec: unknown, filename = "workbook.xlsx"): Promise<CanonicalWorkbookSpec> {
  const source = parseCanonicalWorkbookSpec(canonicalSpec);
  if (source) return source;
  const { parseOfficeWorkbookSafely, OfficeTextOverflowError } = await import("@/lib/officeSecurity");
  try {
    const ast = await parseOfficeWorkbookSafely(buffer, MAX_EXTRACTED_ATTACHMENT_CHARACTERS, ARTIFACT_LIMITS.maxCells);
    const first = readSpreadsheetGrid(buffer, { mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      maxRows: ARTIFACT_LIMITS.maxRowsPerSheet + 1, maxValueLength: ARTIFACT_LIMITS.maxTextLength, preserveEmptyRows: true });
    const physical = new Map<string, ReturnType<typeof readSpreadsheetGrid>>([[first.sheetName, first]]);
    for (const sheet of first.sheetNames.slice(1)) physical.set(sheet, readSpreadsheetGrid(buffer, {
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sheet,
      maxRows: ARTIFACT_LIMITS.maxRowsPerSheet + 1, maxValueLength: ARTIFACT_LIMITS.maxTextLength, preserveEmptyRows: true }));
    return workbookFromOfficeAst(ast, filename, physical);
  }
  catch (error) {
    if (error instanceof WorkbookRevisionError) throw error;
    throw new WorkbookRevisionError(error instanceof OfficeTextOverflowError ? "ATTACHMENT_TEXT_TOO_LARGE" : "ATTACHMENT_UNREADABLE");
  }
}
