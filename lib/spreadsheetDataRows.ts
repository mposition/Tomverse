/**
 * Reading an uploaded spreadsheet as data records.
 *
 * Policy: docs/policy/generated-artifacts.md section 13.
 *
 * The attachment pipeline already extracts a spreadsheet's *text* so a model
 * can talk about it. That text is useless as a data source for generating one
 * document per row: it has no cell boundaries, no column identity, and a date
 * that Excel displayed as `1990-03-04` arrives as whatever the extractor felt
 * like. Filling a contract from it would mean asking a model to retype values
 * it read in a flattened blob -- which is exactly the step where a birth date
 * silently becomes the wrong person's.
 *
 * So the rows are read here, from the package, and the model never carries the
 * values at all. It names the file; the server reads it.
 *
 * Scope, stated rather than discovered later: the first row is the header and
 * its cells are the placeholder names. Values come back as strings, because a
 * placeholder in a Word document is a string -- number formatting decisions
 * are made once, here, where they can be tested.
 */

import { unzipSync, type Unzipped } from "fflate";

export const SPREADSHEET_DATA_ERROR_CODES = [
  "DATA_UNREADABLE",
  "DATA_NOT_SPREADSHEET",
  "DATA_SHEET_NOT_FOUND",
  "DATA_NO_HEADER",
  "DATA_DUPLICATE_COLUMN",
  "DATA_NO_ROWS",
  "DATA_TOO_MANY_ROWS",
] as const;

export type SpreadsheetDataErrorCode =
  (typeof SPREADSHEET_DATA_ERROR_CODES)[number];

export class SpreadsheetDataError extends Error {
  constructor(
    readonly code: SpreadsheetDataErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SpreadsheetDataError";
  }
}

export const SPREADSHEET_DATA_LIMITS = {
  /** Data rows read from one sheet. Well above the archive entry ceiling. */
  maxRows: 500,
  /** Columns read from the header row. */
  maxColumns: 64,
  /** Characters in one cell value. */
  maxValueLength: 4_000,
} as const;

export type SpreadsheetDataSet = {
  /** Header cells, in column order, with trailing empties dropped. */
  columns: string[];
  /** One record per data row, keyed by header cell. */
  rows: Array<Record<string, string>>;
  /** The sheet the records came from. */
  sheetName: string;
};

/* ------------------------------------------------------------------------ */
/* Minimal OOXML reading                                                      */
/* ------------------------------------------------------------------------ */

const decoder = new TextDecoder("utf-8");

/**
 * The text of one element, entities resolved.
 *
 * A hand-rolled reader rather than a DOM: this module reads four known parts
 * of a format whose shape it controls the expectations of, and pulling in an
 * XML parser to do it would add a dependency whose own entity handling would
 * then have to be argued about (XXE is a real thing, and the safest parser is
 * the one that does not resolve anything it was not asked to).
 */
const decodeXml = (value: string): string =>
  value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 10))
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/** Every `<t>` inside a fragment, concatenated. Rich text is several runs. */
const readSharedText = (fragment: string): string => {
  let text = "";
  for (const match of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
    text += decodeXml(match[1]);
  }
  // A `<t/>` run contributes nothing, which is already what this produces.
  return text;
};

const readSharedStrings = (parts: Unzipped): string[] => {
  const bytes = parts["xl/sharedStrings.xml"];
  if (!bytes) return [];
  const xml = decoder.decode(bytes);
  return Array.from(xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)).map(
    (match) => readSharedText(match[1])
  );
};

/* ------------------------------------------------------------------------ */
/* Number formats                                                             */
/* ------------------------------------------------------------------------ */

/** The built-in format ids that display a date, a time, or both. */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
]);
const BUILTIN_TIME_ONLY_FORMATS = new Set([18, 19, 20, 21, 45, 46, 47]);

/**
 * Whether a custom format code displays a date.
 *
 * Literal sections (`"..."`), colour and condition brackets (`[Red]`) and
 * escaped characters are stripped first, so a currency format whose literal
 * happens to contain the letter `d` is not mistaken for a date.
 */
const customFormatIsDate = (code: string): boolean => {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[ymd]/i.test(stripped);
};

const customFormatHasTime = (code: string): boolean => {
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  return /[hs]/i.test(stripped);
};

type StyleTable = {
  /** Style index -> whether the cell shows a date. */
  isDate: boolean[];
  /** Style index -> whether the cell also shows a time. */
  hasTime: boolean[];
};

const readStyles = (parts: Unzipped): StyleTable => {
  const bytes = parts["xl/styles.xml"];
  if (!bytes) return { isDate: [], hasTime: [] };
  const xml = decoder.decode(bytes);

  const customCodes = new Map<number, string>();
  for (const match of xml.matchAll(
    /<numFmt\s[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/>/g
  )) {
    customCodes.set(Number(match[1]), decodeXml(match[2]));
  }

  const cellXfsMatch = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  const isDate: boolean[] = [];
  const hasTime: boolean[] = [];
  if (!cellXfsMatch) return { isDate, hasTime };
  for (const xf of cellXfsMatch[1].matchAll(/<xf\b[^>]*\/?>/g)) {
    const numFmtId = Number(xf[0].match(/numFmtId="(\d+)"/)?.[1] ?? "0");
    const custom = customCodes.get(numFmtId);
    if (custom !== undefined) {
      isDate.push(customFormatIsDate(custom));
      hasTime.push(customFormatHasTime(custom));
    } else {
      isDate.push(BUILTIN_DATE_FORMATS.has(numFmtId));
      hasTime.push(BUILTIN_TIME_ONLY_FORMATS.has(numFmtId) || numFmtId === 22);
    }
  }
  return { isDate, hasTime };
};

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * An Excel serial number, as the date Excel displays.
 *
 * The epoch is 1899-12-30, not 1900-01-01, because Excel deliberately
 * reproduces a Lotus 1-2-3 bug in which 1900 is a leap year. Serial 60 is that
 * non-existent 1900-02-29; the two-day offset is what makes every serial after
 * it agree with what the user sees on screen, which is the only thing that
 * matters for a document that quotes the value back to them.
 */
export const excelSerialToDisplay = (
  serial: number,
  { withTime }: { withTime: boolean }
): string => {
  const milliseconds = Math.round(serial * 86_400_000);
  const date = new Date(Date.UTC(1899, 11, 30) + milliseconds);
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate()
  )}`;
  if (!withTime) return day;
  return `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
};

/** A plain number, without the exponent notation `String()` reaches for. */
const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
};

/* ------------------------------------------------------------------------ */
/* Sheets                                                                     */
/* ------------------------------------------------------------------------ */

const columnIndex = (reference: string): number => {
  const letters = reference.match(/^[A-Z]+/)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
};

type SheetEntry = { name: string; path: string };

const listSheets = (parts: Unzipped): SheetEntry[] => {
  const workbookBytes = parts["xl/workbook.xml"];
  if (!workbookBytes) {
    throw new SpreadsheetDataError(
      "DATA_NOT_SPREADSHEET",
      "The data file is not an Excel workbook."
    );
  }
  const workbook = decoder.decode(workbookBytes);
  const relsBytes = parts["xl/_rels/workbook.xml.rels"];
  const targets = new Map<string, string>();
  if (relsBytes) {
    const rels = decoder.decode(relsBytes);
    for (const match of rels.matchAll(/<Relationship\b[^>]*\/?>/g)) {
      const id = match[0].match(/Id="([^"]+)"/)?.[1];
      const target = match[0].match(/Target="([^"]+)"/)?.[1];
      if (!id || !target) continue;
      const normalized = target.replace(/^\/?xl\//, "").replace(/^\//, "");
      targets.set(id, `xl/${normalized}`);
    }
  }

  const sheets: SheetEntry[] = [];
  let fallbackIndex = 0;
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    fallbackIndex += 1;
    const name = decodeXml(match[0].match(/name="([^"]*)"/)?.[1] ?? "");
    const relationshipId = match[0].match(/r:id="([^"]+)"/)?.[1];
    const path =
      (relationshipId ? targets.get(relationshipId) : undefined) ??
      `xl/worksheets/sheet${fallbackIndex}.xml`;
    sheets.push({ name, path });
  }
  if (sheets.length === 0) {
    throw new SpreadsheetDataError(
      "DATA_NOT_SPREADSHEET",
      "The data file declares no worksheets."
    );
  }
  return sheets;
};

const readSheetGrid = (
  parts: Unzipped,
  sheet: SheetEntry,
  sharedStrings: string[],
  styles: StyleTable
): string[][] => {
  const bytes = parts[sheet.path];
  if (!bytes) {
    throw new SpreadsheetDataError(
      "DATA_SHEET_NOT_FOUND",
      `The worksheet "${sheet.name}" could not be read.`
    );
  }
  const xml = decoder.decode(bytes);
  const grid: string[][] = [];

  for (const rowMatch of xml.matchAll(
    /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g
  )) {
    const body = rowMatch[1];
    const cells: string[] = [];
    if (body) {
      for (const cellMatch of body.matchAll(
        /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
      )) {
        const attributes = cellMatch[1] ?? "";
        const inner = cellMatch[2] ?? "";
        const reference = attributes.match(/r="([A-Z]+\d+)"/)?.[1];
        const index = reference ? columnIndex(reference) : cells.length;
        const type = attributes.match(/t="([^"]+)"/)?.[1] ?? "n";
        const styleIndex = Number(attributes.match(/s="(\d+)"/)?.[1] ?? "-1");

        let value = "";
        if (type === "s") {
          const rawValue = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          const shared = sharedStrings[Number(rawValue)];
          value = shared ?? "";
        } else if (type === "inlineStr") {
          value = readSharedText(inner);
        } else if (type === "str") {
          // A cached formula result. Values only -- the formula itself is
          // never read, and never written into a generated document.
          value = decodeXml(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "");
        } else if (type === "b") {
          value = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] === "1" ? "TRUE" : "FALSE";
        } else if (type === "e") {
          value = "";
        } else {
          const rawValue = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          if (rawValue !== undefined && rawValue !== "") {
            const numeric = Number(rawValue);
            if (Number.isFinite(numeric)) {
              value =
                styleIndex >= 0 && styles.isDate[styleIndex]
                  ? excelSerialToDisplay(numeric, {
                      withTime: Boolean(styles.hasTime[styleIndex]),
                    })
                  : formatNumber(numeric);
            }
          }
        }

        while (cells.length < index) cells.push("");
        cells[index] = value.slice(0, SPREADSHEET_DATA_LIMITS.maxValueLength);
      }
    }
    grid.push(cells);
    if (grid.length > SPREADSHEET_DATA_LIMITS.maxRows + 1) {
      throw new SpreadsheetDataError(
        "DATA_TOO_MANY_ROWS",
        `The data file has more than ${SPREADSHEET_DATA_LIMITS.maxRows} data rows.`
      );
    }
  }

  return grid;
};

/* ------------------------------------------------------------------------ */
/* CSV                                                                        */
/* ------------------------------------------------------------------------ */

/** RFC 4180, with the BOM Excel writes and both line ending conventions. */
export const parseCsvGrid = (text: string): string[][] => {
  const source = text.replace(/^﻿/, "");
  const grid: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      grid.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    grid.push(row);
  }
  return grid;
};

/* ------------------------------------------------------------------------ */
/* The public reader                                                          */
/* ------------------------------------------------------------------------ */

const gridToDataSet = (
  grid: string[][],
  sheetName: string
): SpreadsheetDataSet => {
  const headerRow = grid.find((row) => row.some((cell) => cell.trim() !== ""));
  if (!headerRow) {
    throw new SpreadsheetDataError(
      "DATA_NO_HEADER",
      "The data file has no header row."
    );
  }
  const headerIndex = grid.indexOf(headerRow);

  const columns: string[] = [];
  for (const cell of headerRow.slice(0, SPREADSHEET_DATA_LIMITS.maxColumns)) {
    columns.push(cell.trim());
  }
  while (columns.length > 0 && columns[columns.length - 1] === "") {
    columns.pop();
  }
  if (columns.length === 0) {
    throw new SpreadsheetDataError(
      "DATA_NO_HEADER",
      "The data file's header row is empty."
    );
  }
  const seen = new Set<string>();
  for (const column of columns) {
    if (column === "") continue;
    if (seen.has(column)) {
      throw new SpreadsheetDataError(
        "DATA_DUPLICATE_COLUMN",
        `The data file has two columns named "${column}".`
      );
    }
    seen.add(column);
  }

  const rows: Array<Record<string, string>> = [];
  for (const row of grid.slice(headerIndex + 1)) {
    if (!row.some((cell) => cell.trim() !== "")) continue;
    const record: Record<string, string> = {};
    columns.forEach((column, index) => {
      if (column === "") return;
      record[column] = (row[index] ?? "").trim();
    });
    rows.push(record);
    if (rows.length > SPREADSHEET_DATA_LIMITS.maxRows) {
      throw new SpreadsheetDataError(
        "DATA_TOO_MANY_ROWS",
        `The data file has more than ${SPREADSHEET_DATA_LIMITS.maxRows} data rows.`
      );
    }
  }
  if (rows.length === 0) {
    throw new SpreadsheetDataError(
      "DATA_NO_ROWS",
      "The data file has a header but no data rows."
    );
  }

  return { columns: columns.filter(Boolean), rows, sheetName };
};

/**
 * Reads an uploaded .xlsx or .csv as records.
 *
 * `sheet` names a worksheet; without it the first is used, which is what a
 * person means when they attach a one-sheet workbook and say "one per row".
 */
export const readSpreadsheetDataRows = (
  bytes: Uint8Array,
  options: { mediaType: string; sheet?: string }
): SpreadsheetDataSet => {
  if (
    options.mediaType === "text/csv" ||
    options.mediaType === "text/plain"
  ) {
    return gridToDataSet(
      parseCsvGrid(decoder.decode(bytes)),
      options.sheet ?? "csv"
    );
  }

  let parts: Unzipped;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new SpreadsheetDataError(
      "DATA_UNREADABLE",
      "The data file could not be read as a spreadsheet."
    );
  }

  const sheets = listSheets(parts);
  const sheet = options.sheet
    ? sheets.find((entry) => entry.name === options.sheet)
    : sheets[0];
  if (!sheet) {
    throw new SpreadsheetDataError(
      "DATA_SHEET_NOT_FOUND",
      `The data file has no worksheet named "${options.sheet}".`
    );
  }

  const grid = readSheetGrid(
    parts,
    sheet,
    readSharedStrings(parts),
    readStyles(parts)
  );
  return gridToDataSet(grid, sheet.name);
};
