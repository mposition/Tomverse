/**
 * Generated artifacts: what a model may ask for, and what a client may be told.
 *
 * Policy: docs/policy/generated-artifacts.md.
 *
 * Deliberately pure -- no `server-only`, no Prisma, no R2, no `ai`. Three very
 * different callers read this file: the tool definitions on the server, the
 * message card in the browser, and the unit tests. The limits and the
 * sanitisers are the part that must be identical in all three, so they live
 * where all three can import them and where a test can reach them without a
 * database.
 *
 * The one rule the whole domain rests on: **the model never produces bytes for
 * a format that has structure.** For a spreadsheet, a document, a deck or an
 * archive it produces a *specification*, this file decides whether that
 * specification is admissible, and a trusted server-side generator turns an
 * admissible one into a file.
 *
 * Source code, markup and config files are the deliberate exception, and the
 * exception proves the rule: there is no specification for a Python module
 * that is not simply its text. So for those the model does author the content
 * -- and everything that made a specification safe is applied to the text
 * instead: a bounded size, an extension this application chose, a structural
 * check where malformed means useless, and a delivery path that downloads
 * rather than renders.
 */

import { z } from "zod";

import {
  ARCHIVE_ENTRY_FORMATS,
  ARTIFACT_FORMAT_TABLE,
  formatIdsOfKind,
  isSupportedArtifactFormat,
  requireArtifactFormat,
  type ArtifactKind,
} from "@/lib/generatedArtifactFormats";

export {
  ARCHIVE_ENTRY_FORMATS,
  ARTIFACT_FORMAT_TABLE,
  ARTIFACT_KINDS,
  ARTIFACT_LABEL_GROUPS,
  REFUSED_ARTIFACT_EXTENSIONS,
  SUPPORTED_ARTIFACT_FORMATS,
  artifactFormat,
  formatIdsOfKind,
  formatsOfKind,
  isRefusedArtifactExtension,
  isSupportedArtifactFormat,
  requireArtifactFormat,
  type ArtifactFormatDescriptor,
  type ArtifactKind,
  type ArtifactLabelGroup,
  type ArtifactTextValidation,
} from "@/lib/generatedArtifactFormats";

/**
 * A format id that has passed `isSupportedArtifactFormat`.
 *
 * A plain string alias, and that is the honest type: the set of formats is a
 * table that grows by a line of data, not a union the compiler can enumerate.
 * The guarantee moved with it -- every entry point validates against the table
 * at runtime, and `requireArtifactFormat` throws rather than returning
 * `undefined` for anything that slipped past.
 */
export type SupportedArtifactFormat = string;

/* ------------------------------------------------------------------------ */
/* Limits                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Explicit ceilings on everything the model controls.
 *
 * Grouped by what they bound rather than by which tool reads them, because a
 * ceiling exists to protect a resource: `maxCells` and `maxDocumentBlocks`
 * bound the work, `maxTextLength` bounds a single value, `maxOutputBytes`
 * bounds the result after compression has had its say -- a specification well
 * inside every other limit can still deflate to something no download route
 * should stream.
 */
export const ARTIFACT_LIMITS = {
  // Spreadsheets
  /** Worksheets in one workbook. */
  maxWorksheets: 10,
  /** Data rows in one worksheet, excluding the header. */
  maxRowsPerSheet: 10_000,
  /** Columns in one worksheet. */
  maxColumnsPerSheet: 64,
  /** Cells across the whole workbook, header rows included. */
  maxCells: 100_000,

  // Documents
  /** Blocks in one document. */
  maxDocumentBlocks: 2_000,
  /** Items in one list block. */
  maxListItems: 200,
  /** Rows in a document's table block, excluding the header. */
  maxDocumentTableRows: 500,
  /** Columns in a document's table block. */
  maxDocumentTableColumns: 20,

  // Presentations
  /** Slides in one deck. */
  maxSlides: 100,
  /** Bullets on one slide. */
  maxSlideBullets: 20,

  // Text files
  /** Characters in an authored text file. */
  maxTextFileCharacters: 400_000,

  // Archives
  /** Entries in one archive. */
  maxArchiveEntries: 100,
  /** Characters across every entry of one archive, before compression. */
  maxArchiveCharacters: 2_000_000,
  /** Characters in one archive entry path. */
  maxArchivePathLength: 200,

  // Shared
  /** Characters in one cell value, one column header or one document block. */
  maxTextLength: 20_000,
  /** Characters in a title or a heading. */
  maxTitleLength: 300,
  /** Characters in the requested file name, extension included. */
  maxFilenameLength: 120,
  /** Bytes in the generated file. Checked after generation, not guessed. */
  maxOutputBytes: 5 * 1024 * 1024,
  /** Artifacts one assistant turn may produce. */
  maxArtifactsPerMessage: 3,
} as const;

/* ------------------------------------------------------------------------ */
/* File names                                                                 */
/* ------------------------------------------------------------------------ */

const RESERVED_WINDOWS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

const KNOWN_EXTENSIONS = new Set(
  ARTIFACT_FORMAT_TABLE.map((format) => format.id)
);

/**
 * A model-supplied name, reduced to something that is only ever a file name.
 *
 * Path separators, `..`, control characters, RTL overrides and the Windows
 * reserved device names are all removed rather than rejected: the user asked
 * for a file, and failing their request because the model chose a colon would
 * be a worse answer than giving them the file under a name that works. The
 * extension is decided here from the format, never taken from the input --
 * `report.xlsx.exe` and `report.pdf` both come back as `report.xlsx` when the
 * format is xlsx.
 *
 * Korean, Japanese and other non-ASCII names survive intact. They are carried
 * to the browser by RFC 5987's `filename*`, which is the field that can hold
 * them; see `artifactContentDisposition`.
 */
export const sanitizeArtifactFilename = (
  requested: string,
  format: SupportedArtifactFormat
): string => {
  const extension = requireArtifactFormat(format).extension;
  let base = String(requested ?? "")
    // Everything after the last path separator, so a traversal attempt loses
    // its path rather than its meaning.
    .split(/[\\/]/)
    .pop()!
    // C0/C1 controls, and the bidirectional overrides that let "xlsx.exe"
    // render as "exe.xlsx".
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    // Reserved on Windows, and `%` because a literal one in a quoted
    // `filename` is ambiguous with percent-encoding.
    .replace(/[<>:"|?*%]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // A name that is only dots is a relative path, not a name.
  base = base.replace(/^\.+/, "").trim();

  // Drop a trailing extension the caller supplied -- ours is authoritative.
  const lastDot = base.lastIndexOf(".");
  if (lastDot > 0) {
    const suffix = base.slice(lastDot + 1).toLowerCase();
    if (KNOWN_EXTENSIONS.has(suffix)) base = base.slice(0, lastDot).trim();
  }

  if (RESERVED_WINDOWS_NAMES.has(base.toLowerCase())) base = `${base}-file`;
  if (!base) base = "generated";

  const room = ARTIFACT_LIMITS.maxFilenameLength - extension.length;
  if (base.length > room) base = base.slice(0, room).trim() || "generated";

  return `${base}${extension}`;
};

/**
 * The ASCII half of `Content-Disposition`.
 *
 * A quoted `filename` is defined to be literal, so percent-escapes written
 * into it arrive on disk as the escapes themselves. Anything non-ASCII is
 * therefore dropped here and carried by `filename*` instead -- the same
 * two-field split the conversation export settled on.
 */
export const asciiArtifactFilename = (
  filename: string,
  format: SupportedArtifactFormat
): string => {
  const extension = requireArtifactFormat(format).extension;
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .trim();
  const base = ascii.endsWith(extension)
    ? ascii.slice(0, ascii.length - extension.length)
    : "";
  // "분기별_매출.xlsx" strips down to "_.xlsx", which is a worse name on disk
  // than an honest generic one: a base made only of separators carries none of
  // what the author wrote, so the fallback says so instead of pretending.
  // Anything real is still there in `filename*`, which is the field that can
  // hold it.
  return /[A-Za-z0-9]/.test(base) ? ascii : `generated${extension}`;
};

/** Both fields, built together so they cannot disagree. */
export const artifactContentDisposition = (
  filename: string,
  format: SupportedArtifactFormat
): string =>
  `attachment; filename="${asciiArtifactFilename(filename, format)}"; ` +
  `filename*=UTF-8''${encodeURIComponent(filename)}`;

/* ------------------------------------------------------------------------ */
/* Spreadsheet formula neutralisation                                         */
/* ------------------------------------------------------------------------ */

/**
 * Leading characters a spreadsheet may read as the start of a formula.
 *
 * `=`, `+`, `-` and `@` are the classic four; the tab and carriage return are
 * here because Excel skips leading whitespace before deciding, so `"\t=cmd"`
 * is the same attack with one character of cover.
 */
const FORMULA_LEAD = /^[\t\r=+\-@]/;

/**
 * Whether a value must be written as forced text.
 *
 * Worth being exact about what this defends against, because the two formats
 * are not equally exposed. In OOXML a formula is an `<f>` element and nothing
 * else is: an inline string beginning with `=` is already inert, and this
 * repository's writer never emits `<f>` at all. What the flag buys there is
 * the `quotePrefix` cell style -- Excel's own "this is text, do not
 * reinterpret" marker -- so the value stays text if the user later edits the
 * cell, and stays *exactly* the value the model asked for.
 *
 * CSV has no such structure. There, `csvCell` prefixes the value, and the
 * apostrophe is visible. That difference is deliberate and documented rather
 * than smoothed over: preserving the byte matters more in the format that can
 * express the intent, and refusing execution matters more in the one that
 * cannot.
 */
export const needsFormulaGuard = (value: string): boolean =>
  FORMULA_LEAD.test(value);

/** A CSV field: formula-guarded, then quoted if it needs quoting. */
export const csvCell = (value: string): string => {
  const guarded = needsFormulaGuard(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

/* ------------------------------------------------------------------------ */
/* Shared schema pieces                                                       */
/* ------------------------------------------------------------------------ */

const formatEnum = (kind: ArtifactKind) => {
  const ids = formatIdsOfKind(kind);
  return z.enum(ids as [string, ...string[]]);
};

const filenameField = z.string().min(1).max(ARTIFACT_LIMITS.maxFilenameLength);

/**
 * The cell value shapes a model may send.
 *
 * There is no `formula` member and there will not be one until formulas have
 * a validation contract of their own: an expression is code, and accepting one
 * from a model would make every downstream reader of the file an execution
 * surface (policy section 6).
 */
const cellValueSchema = z.union([
  z.string().max(ARTIFACT_LIMITS.maxTextLength),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export type ArtifactCellValue = z.infer<typeof cellValueSchema>;

/* ------------------------------------------------------------------------ */
/* Workbook specification (xlsx, csv)                                         */
/* ------------------------------------------------------------------------ */

export const ARTIFACT_COLUMN_TYPES = ["text", "number", "date"] as const;
export type ArtifactColumnType = (typeof ARTIFACT_COLUMN_TYPES)[number];

/**
 * Display formats a column may ask for, by name.
 *
 * Names, not raw `numFmt` codes. A code is a small language, and accepting one
 * from a model would mean parsing that language here to be sure it cannot
 * carry anything else. The named set covers what a report actually needs and
 * grows by a reviewed line of code rather than by a model's imagination.
 */
export const ARTIFACT_NUMBER_FORMATS = {
  general: null,
  integer: "#,##0",
  decimal: "#,##0.00",
  percent: "0.0%",
  currency_krw: "\u20a9#,##0",
  currency_usd: '"$"#,##0.00',
  date: "yyyy-mm-dd",
  datetime: "yyyy-mm-dd hh:mm",
  duration: "[h]:mm:ss",
} as const;

export type ArtifactNumberFormat = keyof typeof ARTIFACT_NUMBER_FORMATS;

const columnSchema = z
  .object({
    key: z.string().min(1).max(120).optional(),
    header: z.string().min(1).max(ARTIFACT_LIMITS.maxTextLength),
    type: z.enum(ARTIFACT_COLUMN_TYPES).optional().default("text"),
    format: z
      .enum(
        Object.keys(ARTIFACT_NUMBER_FORMATS) as [
          ArtifactNumberFormat,
          ...ArtifactNumberFormat[],
        ]
      )
      .optional(),
    /** Character width, as Excel measures it. Clamped, never trusted. */
    width: z.number().int().min(4).max(120).optional(),
  })
  .strict();

export type ArtifactColumn = z.infer<typeof columnSchema>;

const worksheetSchema = z
  .object({
    name: z.string().min(1).max(120),
    title: z.string().max(ARTIFACT_LIMITS.maxTitleLength).optional(),
    columns: z
      .array(columnSchema)
      .min(1)
      .max(ARTIFACT_LIMITS.maxColumnsPerSheet),
    rows: z
      .array(z.array(cellValueSchema).max(ARTIFACT_LIMITS.maxColumnsPerSheet))
      .max(ARTIFACT_LIMITS.maxRowsPerSheet),
    freezeHeader: z.boolean().optional().default(true),
  })
  .strict();

export type ArtifactWorksheetSpec = z.infer<typeof worksheetSchema>;

export const workbookSpecSchema = z
  .object({
    filename: filenameField,
    format: formatEnum("spreadsheet").optional().default("xlsx"),
    worksheets: z
      .array(worksheetSchema)
      .min(1)
      .max(ARTIFACT_LIMITS.maxWorksheets),
    /** Bold, filled header row. On by default because reports want it. */
    styleHeader: z.boolean().optional().default(true),
  })
  .strict();

export type WorkbookSpec = z.infer<typeof workbookSpecSchema>;

/* ------------------------------------------------------------------------ */
/* Document specification (docx, pdf, md, txt)                                */
/* ------------------------------------------------------------------------ */

const blockText = z.string().max(ARTIFACT_LIMITS.maxTextLength);

/**
 * The blocks a document is made of.
 *
 * A flow of blocks rather than a string of Markdown, and the reason is the
 * same one the workbook has a schema: four very different writers read this
 * (Word, PDF, Markdown, plain text), and only a structure they all understand
 * lets a heading be a heading in each of them. A Markdown string would make
 * the Word and PDF writers into Markdown parsers, and a parser is where a
 * "document" quietly becomes whatever the model's markup happened to mean.
 *
 * There is no `html`, no `image` and no `link` block. Each would put content
 * this application cannot check into a file it signs its name to.
 */
const blockSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("heading"),
      level: z.number().int().min(1).max(4),
      text: z.string().min(1).max(ARTIFACT_LIMITS.maxTitleLength),
    })
    .strict(),
  z.object({ type: z.literal("paragraph"), text: blockText }).strict(),
  z
    .object({
      type: z.literal("bullets"),
      items: z.array(blockText).min(1).max(ARTIFACT_LIMITS.maxListItems),
    })
    .strict(),
  z
    .object({
      type: z.literal("numbers"),
      items: z.array(blockText).min(1).max(ARTIFACT_LIMITS.maxListItems),
    })
    .strict(),
  z.object({ type: z.literal("quote"), text: blockText }).strict(),
  z
    .object({
      type: z.literal("code"),
      language: z.string().max(40).optional(),
      text: blockText,
    })
    .strict(),
  z
    .object({
      type: z.literal("table"),
      columns: z
        .array(z.string().max(ARTIFACT_LIMITS.maxTitleLength))
        .min(1)
        .max(ARTIFACT_LIMITS.maxDocumentTableColumns),
      rows: z
        .array(
          z
            .array(cellValueSchema)
            .max(ARTIFACT_LIMITS.maxDocumentTableColumns)
        )
        .max(ARTIFACT_LIMITS.maxDocumentTableRows),
    })
    .strict(),
  z.object({ type: z.literal("divider") }).strict(),
  z.object({ type: z.literal("pageBreak") }).strict(),
]);

export type ArtifactDocumentBlock = z.infer<typeof blockSchema>;

export const documentSpecSchema = z
  .object({
    filename: filenameField,
    format: formatEnum("document"),
    title: z.string().max(ARTIFACT_LIMITS.maxTitleLength).optional(),
    subtitle: z.string().max(ARTIFACT_LIMITS.maxTitleLength).optional(),
    blocks: z
      .array(blockSchema)
      .min(1)
      .max(ARTIFACT_LIMITS.maxDocumentBlocks),
  })
  .strict();

export type DocumentSpec = z.infer<typeof documentSpecSchema>;

/* ------------------------------------------------------------------------ */
/* Presentation specification (pptx)                                          */
/* ------------------------------------------------------------------------ */

export const ARTIFACT_SLIDE_LAYOUTS = [
  "title",
  "titleAndContent",
  "sectionHeader",
] as const;

export type ArtifactSlideLayout = (typeof ARTIFACT_SLIDE_LAYOUTS)[number];

const slideSchema = z
  .object({
    layout: z.enum(ARTIFACT_SLIDE_LAYOUTS).optional().default("titleAndContent"),
    title: z.string().min(1).max(ARTIFACT_LIMITS.maxTitleLength),
    subtitle: z.string().max(ARTIFACT_LIMITS.maxTitleLength).optional(),
    bullets: z
      .array(z.string().max(ARTIFACT_LIMITS.maxTitleLength))
      .max(ARTIFACT_LIMITS.maxSlideBullets)
      .optional(),
    /** Speaker notes. Present in the file, never on the slide. */
    notes: z.string().max(ARTIFACT_LIMITS.maxTextLength).optional(),
  })
  .strict();

export type ArtifactSlideSpec = z.infer<typeof slideSchema>;

export const presentationSpecSchema = z
  .object({
    filename: filenameField,
    format: formatEnum("presentation").optional().default("pptx"),
    slides: z.array(slideSchema).min(1).max(ARTIFACT_LIMITS.maxSlides),
  })
  .strict();

export type PresentationSpec = z.infer<typeof presentationSpecSchema>;

/* ------------------------------------------------------------------------ */
/* Text file specification (source, markup, config)                           */
/* ------------------------------------------------------------------------ */

export const textFileSpecSchema = z
  .object({
    filename: filenameField,
    format: formatEnum("text"),
    content: z.string().min(1).max(ARTIFACT_LIMITS.maxTextFileCharacters),
  })
  .strict();

export type TextFileSpec = z.infer<typeof textFileSpecSchema>;

/* ------------------------------------------------------------------------ */
/* Archive specification (zip)                                                */
/* ------------------------------------------------------------------------ */

const archiveEntrySchema = z
  .object({
    /** A relative path inside the archive, `/`-separated. */
    path: z.string().min(1).max(ARTIFACT_LIMITS.maxArchivePathLength),
    format: z.enum(ARCHIVE_ENTRY_FORMATS as [string, ...string[]]),
    content: z.string().min(1).max(ARTIFACT_LIMITS.maxTextFileCharacters),
  })
  .strict();

export type ArtifactArchiveEntry = z.infer<typeof archiveEntrySchema>;

export const archiveSpecSchema = z
  .object({
    filename: filenameField,
    format: formatEnum("archive").optional().default("zip"),
    entries: z
      .array(archiveEntrySchema)
      .min(1)
      .max(ARTIFACT_LIMITS.maxArchiveEntries),
  })
  .strict();

export type ArchiveSpec = z.infer<typeof archiveSpecSchema>;

/* ------------------------------------------------------------------------ */
/* Admissibility                                                              */
/* ------------------------------------------------------------------------ */

export const ARTIFACT_REJECTION_CODES = [
  "SCHEMA_INVALID",
  "TOO_MANY_CELLS",
  "DUPLICATE_SHEET_NAME",
  "ROW_WIDER_THAN_COLUMNS",
  "EMPTY_WORKBOOK",
  "OUTPUT_TOO_LARGE",
  "FORMAT_UNSUPPORTED",
  "CONTENT_MALFORMED",
  "UNSAFE_PATH",
  "ARCHIVE_TOO_LARGE",
] as const;

export type ArtifactRejectionCode = (typeof ARTIFACT_REJECTION_CODES)[number];

export type ArtifactAdmission<TSpec> =
  | { ok: true; spec: TSpec; cellCount: number }
  | { ok: false; code: ArtifactRejectionCode; detail: string };

export type WorkbookAdmission = ArtifactAdmission<WorkbookSpec>;

export class WorkbookAdmissionError extends Error {
  constructor(
    readonly code: ArtifactRejectionCode,
    message: string
  ) {
    super(message);
    this.name = "WorkbookAdmissionError";
  }
}

const schemaFailure = (error: z.ZodError): ArtifactAdmission<never> => ({
  ok: false,
  code: "SCHEMA_INVALID",
  detail: error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; "),
});

/**
 * Excel's own worksheet-name rules, applied before the file exists.
 *
 * A workbook Excel refuses to open is indistinguishable, to the person who
 * asked for it, from a workbook that was never made -- except that this one
 * was paid for and downloaded first.
 */
const normalizeSheetName = (name: string, index: number): string => {
  const cleaned = name
    .replace(/[\\/?*[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
};

/**
 * Whether this workbook may be generated, and the shape it generates as.
 *
 * Returns a *normalised* spec rather than validating in place: sheet names are
 * made unique and legal, rows are padded to the column count, and the whole
 * thing is counted. Everything downstream then works on a structure that is
 * already true, instead of re-deriving the same invariants and disagreeing
 * about one of them.
 */
export const admitWorkbookSpec = (input: unknown): WorkbookAdmission => {
  const parsed = workbookSpecSchema.safeParse(input);
  if (!parsed.success) return schemaFailure(parsed.error);

  const spec = parsed.data;
  const seenNames = new Set<string>();
  let cellCount = 0;

  const worksheets = spec.worksheets.map((sheet, index) => {
    let name = normalizeSheetName(sheet.name, index);
    if (seenNames.has(name.toLowerCase())) {
      // Excel refuses duplicates outright, so a second "Q1" is renamed rather
      // than rejected: the data is fine, only the label collided.
      let suffix = 2;
      let candidate = `${name.slice(0, 28)} (${suffix})`;
      while (seenNames.has(candidate.toLowerCase())) {
        suffix += 1;
        candidate = `${name.slice(0, 28)} (${suffix})`;
      }
      name = candidate;
    }
    seenNames.add(name.toLowerCase());

    const columnCount = sheet.columns.length;
    for (const row of sheet.rows) {
      if (row.length > columnCount) {
        throw new WorkbookAdmissionError(
          "ROW_WIDER_THAN_COLUMNS",
          `Worksheet "${sheet.name}" has a row with ${row.length} values for ${columnCount} columns.`
        );
      }
    }

    // Header row plus data rows, at full column width -- the cost of the file
    // is the rectangle, not the values that happen to be present.
    cellCount += columnCount * (sheet.rows.length + 1);
    if (sheet.title) cellCount += 1;

    return {
      ...sheet,
      name,
      rows: sheet.rows.map((row) =>
        row.length === columnCount
          ? row
          : [...row, ...Array<null>(columnCount - row.length).fill(null)]
      ),
    };
  });

  if (cellCount === 0) {
    return { ok: false, code: "EMPTY_WORKBOOK", detail: "No cells to write." };
  }
  if (cellCount > ARTIFACT_LIMITS.maxCells) {
    return {
      ok: false,
      code: "TOO_MANY_CELLS",
      detail: `${cellCount} cells exceeds the ${ARTIFACT_LIMITS.maxCells} cell limit.`,
    };
  }

  return { ok: true, spec: { ...spec, worksheets }, cellCount };
};

/** `admitWorkbookSpec`, with the thrown row-width failure folded back in. */
export const admitWorkbookSpecSafely = (input: unknown): WorkbookAdmission => {
  try {
    return admitWorkbookSpec(input);
  } catch (error) {
    if (error instanceof WorkbookAdmissionError) {
      return { ok: false, code: error.code, detail: error.message };
    }
    throw error;
  }
};

/**
 * Whether this document may be generated.
 *
 * The count returned is blocks rather than cells; both feed the same "how much
 * work is this" report the tool gives back to the model, and a document's
 * blocks are the unit a reader would recognise.
 */
export const admitDocumentSpec = (
  input: unknown
): ArtifactAdmission<DocumentSpec> => {
  const parsed = documentSpecSchema.safeParse(input);
  if (!parsed.success) return schemaFailure(parsed.error);
  const spec = parsed.data;

  for (const block of spec.blocks) {
    if (block.type !== "table") continue;
    for (const row of block.rows) {
      if (row.length > block.columns.length) {
        return {
          ok: false,
          code: "ROW_WIDER_THAN_COLUMNS",
          detail: `A table row has ${row.length} values for ${block.columns.length} columns.`,
        };
      }
    }
  }

  // Rows are padded here for the same reason the workbook's are: four writers
  // read this, and none of them should have to decide what a short row means.
  const blocks = spec.blocks.map((block) =>
    block.type === "table"
      ? {
          ...block,
          rows: block.rows.map((row) =>
            row.length === block.columns.length
              ? row
              : [
                  ...row,
                  ...Array<null>(block.columns.length - row.length).fill(null),
                ]
          ),
        }
      : block
  );

  return { ok: true, spec: { ...spec, blocks }, cellCount: blocks.length };
};

export const admitPresentationSpec = (
  input: unknown
): ArtifactAdmission<PresentationSpec> => {
  const parsed = presentationSpecSchema.safeParse(input);
  if (!parsed.success) return schemaFailure(parsed.error);
  return { ok: true, spec: parsed.data, cellCount: parsed.data.slides.length };
};

export const admitTextFileSpec = (
  input: unknown
): ArtifactAdmission<TextFileSpec> => {
  const parsed = textFileSpecSchema.safeParse(input);
  if (!parsed.success) return schemaFailure(parsed.error);
  return {
    ok: true,
    spec: parsed.data,
    cellCount: parsed.data.content.split("\n").length,
  };
};

/**
 * A path an archive entry may occupy.
 *
 * Refused rather than sanitised, and that is the difference from a file name.
 * A name is a label and a mangled one still names the file the user asked for;
 * a path is a *location*, and quietly moving `../../etc/passwd` to
 * `etc/passwd` would deliver an archive whose contents are not where the model
 * said they would be. An archive is read by tools that trust their entries.
 */
export const isSafeArchivePath = (path: string): boolean => {
  if (!path || path.length > ARTIFACT_LIMITS.maxArchivePathLength) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return true;
};

export const admitArchiveSpec = (
  input: unknown
): ArtifactAdmission<ArchiveSpec> => {
  const parsed = archiveSpecSchema.safeParse(input);
  if (!parsed.success) return schemaFailure(parsed.error);
  const spec = parsed.data;

  const seen = new Set<string>();
  let characters = 0;
  for (const entry of spec.entries) {
    if (!isSafeArchivePath(entry.path)) {
      return {
        ok: false,
        code: "UNSAFE_PATH",
        detail: `"${entry.path.slice(0, 80)}" is not a relative path inside the archive.`,
      };
    }
    if (seen.has(entry.path)) {
      return {
        ok: false,
        code: "UNSAFE_PATH",
        detail: `"${entry.path.slice(0, 80)}" appears twice.`,
      };
    }
    seen.add(entry.path);
    characters += entry.content.length;
  }

  if (characters > ARTIFACT_LIMITS.maxArchiveCharacters) {
    return {
      ok: false,
      code: "ARCHIVE_TOO_LARGE",
      detail: `${characters} characters exceeds the ${ARTIFACT_LIMITS.maxArchiveCharacters} character limit.`,
    };
  }

  return { ok: true, spec, cellCount: spec.entries.length };
};

/* ------------------------------------------------------------------------ */
/* Transport                                                                  */
/* ------------------------------------------------------------------------ */

export const ARTIFACT_STATUSES = ["ready", "failed", "blocked"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/**
 * The subset a `MessageArtifact` row may hold.
 *
 * `blocked` is missing on purpose, and the difference is not a technicality:
 * it is the state of a guest turn, which has no account to write a row under.
 * Allowing it in the database would create a status nothing can ever query
 * for. This list is what the migration's CHECK enforces, and
 * scripts/check-enum-constraints.mjs holds the two together.
 */
export const PERSISTED_ARTIFACT_STATUSES = ["ready", "failed"] as const;
export type PersistedArtifactStatus =
  (typeof PERSISTED_ARTIFACT_STATUSES)[number];

/**
 * Why an artifact the user asked for does not exist.
 *
 * `sign_in_required` is not an error: it is the guest policy stated out loud
 * (policy section 7). The MVP does not store guest artifacts, and the answer
 * to that is a card with a sign-in call to action -- never a Python snippet
 * dressed up as a result.
 */
export const ARTIFACT_FAILURE_CODES = [
  "sign_in_required",
  "generation_failed",
  "storage_failed",
  "spec_rejected",
  "format_unsupported",
  "limit_exceeded",
  "turn_incomplete",
] as const;

export type ArtifactFailureCode = (typeof ARTIFACT_FAILURE_CODES)[number];

/**
 * What a client is told about one generated file.
 *
 * An allowlist, and short on purpose. `objectKey`, the bucket, the signed URL
 * and anything the provider said are all absent by construction: this type is
 * the only shape that reaches the browser, so a field that is not here cannot
 * leak through a spread somewhere else (policy section 5).
 */
export type ChatStreamArtifact = {
  /** The MessageArtifact row id, and the only handle a download needs. */
  id: string;
  /** Position within the turn, so a retry can replace a card in place. */
  ordinal: number;
  format: SupportedArtifactFormat;
  filename: string;
  mediaType: string;
  byteSize: number;
  status: ArtifactStatus;
  /** Present only when `status` is not "ready". */
  failureCode?: ArtifactFailureCode;
  /** Which model's answer produced it, for multi-model attribution. */
  modelId?: string;
};

/**
 * Reads one artifact entry from an untrusted payload.
 *
 * The trailer is parsed by the browser from a stream, and a stored transcript
 * can outlive the server that wrote it, so this validates rather than casts.
 * A malformed entry is dropped, not repaired: a card describing a file that
 * does not exist is worse than no card.
 */
export const parseChatStreamArtifact = (
  value: unknown
): ChatStreamArtifact | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.format !== "string" || !isSupportedArtifactFormat(record.format)) {
    return null;
  }
  if (typeof record.filename !== "string" || !record.filename) return null;
  if (typeof record.mediaType !== "string" || !record.mediaType) return null;
  const status = record.status;
  if (
    typeof status !== "string" ||
    !(ARTIFACT_STATUSES as readonly string[]).includes(status)
  ) {
    return null;
  }
  const byteSize =
    typeof record.byteSize === "number" && Number.isSafeInteger(record.byteSize)
      ? Math.max(0, record.byteSize)
      : 0;
  const ordinal =
    typeof record.ordinal === "number" && Number.isSafeInteger(record.ordinal)
      ? Math.max(0, record.ordinal)
      : 0;
  const failureCode =
    typeof record.failureCode === "string" &&
    (ARTIFACT_FAILURE_CODES as readonly string[]).includes(record.failureCode)
      ? (record.failureCode as ArtifactFailureCode)
      : undefined;

  return {
    id: record.id,
    ordinal,
    format: record.format,
    filename: record.filename,
    mediaType: record.mediaType,
    byteSize,
    status: status as ArtifactStatus,
    ...(failureCode ? { failureCode } : {}),
    ...(typeof record.modelId === "string" && record.modelId
      ? { modelId: record.modelId }
      : {}),
  };
};

export const parseChatStreamArtifacts = (
  value: unknown
): ChatStreamArtifact[] | null => {
  if (!Array.isArray(value)) return null;
  const parsed = value
    .slice(0, ARTIFACT_LIMITS.maxArtifactsPerMessage)
    .map(parseChatStreamArtifact)
    .filter((entry): entry is ChatStreamArtifact => entry !== null);
  return parsed.length > 0 ? parsed : null;
};

/** `/api/artifacts/{id}` -- the only download URL a client may use. */
export const artifactDownloadPath = (artifactId: string): string =>
  `/api/artifacts/${encodeURIComponent(artifactId)}`;

/** Human-sized bytes, for the card. Locale-independent by design. */
export const formatArtifactSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
  const megabytes = kilobytes / 1024;
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
};
