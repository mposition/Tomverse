/**
 * The trusted XLSX writer.
 *
 * Policy: docs/policy/generated-artifacts.md sections 3 and 6.
 *
 * This module is the whole reason a model is never allowed to emit bytes. It
 * takes an already-admitted `WorkbookSpec` (see lib/generatedArtifactCore.ts)
 * and produces an OOXML package by construction, from a fixed set of parts.
 * There is no template to inject into and no passthrough of caller-supplied
 * markup: every string the caller provides reaches the file through
 * `escapeXml`, and every structural element is written by this file.
 *
 * What the package deliberately does not contain, and cannot be made to
 * contain, because nothing here writes the part:
 *
 *   * `<f>` formula elements -- values only, always;
 *   * `xl/externalLinks/**` or any external workbook reference;
 *   * `xl/connections.xml` -- no remote data connection;
 *   * `vbaProject.bin` -- the package is `.xlsx`, never `.xlsm`;
 *   * hyperlink relationships of any kind;
 *   * `docProps/custom.xml`, which is where an "auto-open" macro name would go.
 *
 * Pure and dependency-light on purpose: `fflate` (already a dependency, used
 * by the import pipeline) is the only import, so the writer runs in a unit
 * test with no database, no network and no Office runtime.
 */

import { zipSync, type Zippable } from "fflate";

import {
  ARTIFACT_LIMITS,
  ARTIFACT_MEDIA_TYPES,
  ARTIFACT_NUMBER_FORMATS,
  csvCell,
  needsFormulaGuard,
  type ArtifactCellValue,
  type ArtifactColumn,
  type ArtifactNumberFormat,
  type SupportedArtifactFormat,
  type WorkbookSpec,
} from "@/lib/generatedArtifactCore";

/**
 * A fixed timestamp for every zip entry.
 *
 * Byte-identical output for identical input is what makes the idempotency key
 * in lib/generatedArtifactTool.ts meaningful: the same specification
 * generated twice must be recognisably the same file, and a wall-clock mtime
 * would make every regeneration a new one. 2020-01-01 rather than the epoch
 * because DOS timestamps cannot represent anything before 1980.
 */
const FIXED_ENTRY_TIME = Date.UTC(2020, 0, 1);

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/**
 * XML text escaping, plus removal of the code points XML 1.0 cannot carry.
 *
 * The strip is not cosmetic. A lone control character inside a `<t>` element
 * produces a package Excel refuses to open, and the caller of this writer is a
 * language model -- the one caller most likely to hand over a stray U+0001
 * lifted out of a user's pasted data.
 */
export const escapeXml = (value: string): string =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export const columnLetter = (index: number): string => {
  let remaining = index;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return letters;
};

/**
 * A JavaScript date as an Excel serial number.
 *
 * The epoch is 1899-12-30, not 1900-01-01, because Excel deliberately
 * reproduces Lotus 1-2-3's belief that 1900 was a leap year. Using the
 * intuitive epoch puts every date one day out, which is the kind of error that
 * survives review because the file opens perfectly.
 */
export const excelSerialFromDate = (date: Date): number => {
  const utcMidnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
  const days = (utcMidnight - Date.UTC(1899, 11, 30)) / 86_400_000;
  const timeOfDay =
    (date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds()) /
    86_400;
  return days + timeOfDay;
};

/**
 * A date-typed cell value, if it really is one.
 *
 * Only the unambiguous ISO forms are accepted. `new Date("03/04/2026")` parses
 * happily and means different months on either side of the Atlantic, so a
 * value that is not clearly a date stays text rather than becoming a
 * confidently wrong number.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;

export const parseArtifactDate = (value: ArtifactCellValue): Date | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed)) return null;
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const withZone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}${normalized.includes("T") ? "" : "T00:00:00"}Z`;
  const date = new Date(withZone.endsWith("Z") ? withZone : `${withZone}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/* ------------------------------------------------------------------------ */
/* Style table                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The style indices this writer can reference.
 *
 * Fixed slots rather than a builder, because the set is small and a fixed set
 * is one that can be read against `styles.xml` by eye. Format-specific slots
 * are appended after these four.
 */
const STYLE_DEFAULT = 0;
const STYLE_HEADER = 1;
const STYLE_QUOTED_TEXT = 2;
const STYLE_TITLE = 3;
const STYLE_FIXED_COUNT = 4;

type StyleTable = {
  xml: string;
  /** Style index for a column's declared display format, or the default. */
  indexFor: (format: ArtifactNumberFormat | undefined) => number;
};

const buildStyleTable = (spec: WorkbookSpec): StyleTable => {
  const usedFormats: ArtifactNumberFormat[] = [];
  const noteFormat = (named: ArtifactNumberFormat | undefined) => {
    if (!named) return;
    if (ARTIFACT_NUMBER_FORMATS[named] === null) return;
    if (!usedFormats.includes(named)) usedFormats.push(named);
  };
  for (const sheet of spec.worksheets) {
    for (const column of sheet.columns) {
      noteFormat(column.format);
      // A date column with no declared display format still needs one: an
      // unstyled serial renders as `46112`, which is not the value anybody
      // wrote. Both slots are reserved because `dataCell` picks between them
      // per value, depending on whether the value carried a time.
      if (column.type === "date" && !column.format) {
        noteFormat("date");
        noteFormat("datetime");
      }
    }
  }

  // Custom number-format ids start at 164; 0-163 are reserved by the spec.
  const numFmts = usedFormats.map((named, index) => ({
    named,
    id: 164 + index,
    code: ARTIFACT_NUMBER_FORMATS[named] as string,
  }));

  const numFmtXml = numFmts.length
    ? `<numFmts count="${numFmts.length}">${numFmts
        .map((entry) => `<numFmt numFmtId="${entry.id}" formatCode="${escapeXml(entry.code)}"/>`)
        .join("")}</numFmts>`
    : "";

  const formatXfs = numFmts
    .map(
      (entry) =>
        `<xf numFmtId="${entry.id}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
    )
    .join("");

  const xml =
    `${XML_DECLARATION}` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    numFmtXml +
    `<fonts count="3">` +
    `<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><b/><sz val="13"/><name val="Calibri"/><family val="2"/></font>` +
    `</fonts>` +
    // Slots 0 and 1 are mandated by the format and must be exactly these two.
    `<fills count="3">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF1F6F4A"/><bgColor indexed="64"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${STYLE_FIXED_COUNT + numFmts.length}">` +
    // 0: default
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    // 1: header
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
    // 2: forced text. `quotePrefix` is Excel's own "never reinterpret this"
    // marker -- the value is stored verbatim and is not a formula.
    `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1" applyNumberFormat="1"/>` +
    // 3: sheet title
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    formatXfs +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const indexByFormat = new Map<ArtifactNumberFormat, number>(
    numFmts.map((entry, index) => [entry.named, STYLE_FIXED_COUNT + index])
  );

  return {
    xml,
    indexFor: (format) =>
      format ? (indexByFormat.get(format) ?? STYLE_DEFAULT) : STYLE_DEFAULT,
  };
};

/* ------------------------------------------------------------------------ */
/* Cells                                                                      */
/* ------------------------------------------------------------------------ */

const inlineStringCell = (
  reference: string,
  text: string,
  styleIndex: number
): string =>
  `<c r="${reference}" t="inlineStr"${styleIndex ? ` s="${styleIndex}"` : ""}>` +
  `<is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;

const numericCell = (
  reference: string,
  value: number,
  styleIndex: number
): string =>
  `<c r="${reference}"${styleIndex ? ` s="${styleIndex}"` : ""}><v>${value}</v></c>`;

/**
 * One data cell.
 *
 * The column's declared type is a request, not a guarantee: a `number` column
 * carrying the string "n/a" writes the string. Coercing it would replace the
 * author's data with a zero, and a spreadsheet that silently reports zero
 * revenue for a quarter is worse than one that says "n/a".
 */
const dataCell = (
  reference: string,
  value: ArtifactCellValue,
  column: ArtifactColumn,
  styles: StyleTable
): string => {
  if (value === null || value === undefined) return "";

  const formatStyle = styles.indexFor(column.format);

  if (typeof value === "number") {
    return Number.isFinite(value) ? numericCell(reference, value, formatStyle) : "";
  }

  if (typeof value === "boolean") {
    return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }

  const text = String(value);

  if (column.type === "date") {
    const date = parseArtifactDate(text);
    if (date) {
      // A date column with no explicit display format still has to render as
      // a date; a bare serial number is not the value the author wrote.
      const style = column.format
        ? formatStyle
        : styles.indexFor(text.includes("T") || text.includes(" ") ? "datetime" : "date");
      return numericCell(reference, excelSerialFromDate(date), style);
    }
  }

  if (column.type === "number") {
    const numeric = Number(text.replace(/,/g, ""));
    if (text.trim() !== "" && Number.isFinite(numeric) && !needsFormulaGuard(text)) {
      return numericCell(reference, numeric, formatStyle);
    }
  }

  // Text. `quotePrefix` whenever the value could be read as the start of a
  // formula -- see `needsFormulaGuard` for why the value itself is untouched.
  return inlineStringCell(
    reference,
    text,
    needsFormulaGuard(text) ? STYLE_QUOTED_TEXT : formatStyle
  );
};

/* ------------------------------------------------------------------------ */
/* Worksheets                                                                 */
/* ------------------------------------------------------------------------ */

const worksheetXml = (
  sheet: WorkbookSpec["worksheets"][number],
  styles: StyleTable,
  styleHeader: boolean
): string => {
  const columnCount = sheet.columns.length;
  const rows: string[] = [];
  let rowNumber = 1;

  if (sheet.title) {
    rows.push(
      `<row r="${rowNumber}">` +
        inlineStringCell(`A${rowNumber}`, sheet.title, STYLE_TITLE) +
        `</row>`
    );
    rowNumber += 1;
  }

  const headerRowNumber = rowNumber;
  rows.push(
    `<row r="${rowNumber}">` +
      sheet.columns
        .map((column, index) =>
          inlineStringCell(
            `${columnLetter(index)}${headerRowNumber}`,
            column.header,
            styleHeader ? STYLE_HEADER : STYLE_DEFAULT
          )
        )
        .join("") +
      `</row>`
  );
  rowNumber += 1;

  for (const row of sheet.rows) {
    const cells = row
      .map((value, index) =>
        dataCell(
          `${columnLetter(index)}${rowNumber}`,
          value,
          sheet.columns[index]!,
          styles
        )
      )
      .join("");
    // An all-null row still occupies its row number, so the row element is
    // written even when every cell was skipped.
    rows.push(`<row r="${rowNumber}">${cells}</row>`);
    rowNumber += 1;
  }

  const lastRow = rowNumber - 1;
  const dimension = `A1:${columnLetter(columnCount - 1)}${lastRow}`;

  const freezeRow = headerRowNumber + 1;
  const sheetView = sheet.freezeHeader
    ? `<sheetView workbookViewId="0">` +
      `<pane ySplit="${headerRowNumber}" topLeftCell="A${freezeRow}" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="A${freezeRow}" sqref="A${freezeRow}"/>` +
      `</sheetView>`
    : `<sheetView workbookViewId="0"/>`;

  const cols = sheet.columns.some((column) => column.width)
    ? `<cols>` +
      sheet.columns
        .map((column, index) =>
          column.width
            ? `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`
            : ""
        )
        .join("") +
      `</cols>`
    : "";

  // autoFilter over the header row: a convenience that adds no relationship,
  // no external reference and no script.
  const autoFilter = `<autoFilter ref="A${headerRowNumber}:${columnLetter(
    columnCount - 1
  )}${lastRow}"/>`;

  return (
    `${XML_DECLARATION}` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dimension}"/>` +
    `<sheetViews>${sheetView}</sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    cols +
    `<sheetData>${rows.join("")}</sheetData>` +
    autoFilter +
    `</worksheet>`
  );
};

/* ------------------------------------------------------------------------ */
/* Package                                                                    */
/* ------------------------------------------------------------------------ */

export type GeneratedArtifactBytes = {
  format: SupportedArtifactFormat;
  mediaType: string;
  bytes: Uint8Array;
};

export class ArtifactGenerationError extends Error {
  constructor(
    readonly code: "OUTPUT_TOO_LARGE" | "GENERATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "ArtifactGenerationError";
  }
}

/** The OOXML package for an admitted workbook specification. */
export const renderWorkbookXlsx = (spec: WorkbookSpec): Uint8Array => {
  const styles = buildStyleTable(spec);
  const encoder = new TextEncoder();

  const sheetParts = spec.worksheets.map((sheet, index) => ({
    path: `xl/worksheets/sheet${index + 1}.xml`,
    xml: worksheetXml(sheet, styles, spec.styleHeader),
  }));

  const contentTypes =
    `${XML_DECLARATION}` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheetParts
      .map(
        (part) =>
          `<Override PartName="/${part.path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;

  const rootRels =
    `${XML_DECLARATION}` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `</Relationships>`;

  const workbook =
    `${XML_DECLARATION}` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    spec.worksheets
      .map(
        (sheet, index) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
      )
      .join("") +
    `</sheets>` +
    `</workbook>`;

  const workbookRels =
    `${XML_DECLARATION}` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheetParts
      .map(
        (part, index) =>
          `<Relationship Id="rId${index + 1}" ` +
          `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
          `Target="worksheets/sheet${index + 1}.xml"/>`
      )
      .join("") +
    `<Relationship Id="rId${sheetParts.length + 1}" ` +
    `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  // Fixed metadata, so the package carries no clock and no identity. The
  // creator string names the product rather than the model: the file is this
  // application's output, produced from a specification, and attributing it to
  // a provider would be a claim about authorship nobody checked.
  const coreProperties =
    `${XML_DECLARATION}` +
    `<cp:coreProperties ` +
    `xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:creator>Tomverse Insight</dc:creator>` +
    `<cp:lastModifiedBy>Tomverse Insight</cp:lastModifiedBy>` +
    `</cp:coreProperties>`;

  const files: Zippable = {
    "[Content_Types].xml": encoder.encode(contentTypes),
    "_rels/.rels": encoder.encode(rootRels),
    "docProps/core.xml": encoder.encode(coreProperties),
    "xl/workbook.xml": encoder.encode(workbook),
    "xl/_rels/workbook.xml.rels": encoder.encode(workbookRels),
    "xl/styles.xml": encoder.encode(styles.xml),
  };
  for (const part of sheetParts) files[part.path] = encoder.encode(part.xml);

  return zipSync(files, { level: 6, mtime: FIXED_ENTRY_TIME });
};

/**
 * The CSV rendering of the same specification.
 *
 * One worksheet only. A CSV file cannot hold several, and writing the first
 * sheet while silently dropping the rest would be the "quiet substitution"
 * this domain exists to refuse -- so a multi-sheet request in CSV is a
 * generation failure, stated as one.
 */
export const renderWorkbookCsv = (spec: WorkbookSpec): Uint8Array => {
  if (spec.worksheets.length !== 1) {
    throw new ArtifactGenerationError(
      "GENERATION_FAILED",
      "CSV holds a single sheet; this workbook has " +
        `${spec.worksheets.length}. Ask for .xlsx instead.`
    );
  }
  const sheet = spec.worksheets[0]!;
  const lines: string[] = [];
  if (sheet.title) lines.push(csvCell(sheet.title));
  lines.push(sheet.columns.map((column) => csvCell(column.header)).join(","));
  for (const row of sheet.rows) {
    lines.push(
      row
        .map((value) =>
          value === null || value === undefined
            ? ""
            : typeof value === "number" || typeof value === "boolean"
              ? String(value)
              : csvCell(value)
        )
        .join(",")
    );
  }
  // A BOM, so Excel opens a UTF-8 CSV as UTF-8 rather than as the local
  // code page -- without it a Korean file name's contents arrive as mojibake.
  return new TextEncoder().encode(`\ufeff${lines.join("\r\n")}\r\n`);
};

/** Renders an admitted specification, and enforces the output size ceiling. */
export const renderWorkbook = (
  spec: WorkbookSpec,
  format: SupportedArtifactFormat
): GeneratedArtifactBytes => {
  const bytes =
    format === "csv" ? renderWorkbookCsv(spec) : renderWorkbookXlsx(spec);

  if (bytes.byteLength > ARTIFACT_LIMITS.maxOutputBytes) {
    throw new ArtifactGenerationError(
      "OUTPUT_TOO_LARGE",
      `Generated ${bytes.byteLength} bytes, over the ` +
        `${ARTIFACT_LIMITS.maxOutputBytes} byte limit.`
    );
  }

  return { format, mediaType: ARTIFACT_MEDIA_TYPES[format], bytes };
};
