/**
 * Generated artifacts: what a model may ask for, and what a client may be told.
 *
 * Policy: docs/policy/generated-artifacts.md.
 *
 * Deliberately pure -- no `server-only`, no Prisma, no R2, no `ai`. Three very
 * different callers read this file: the tool definition on the server, the
 * message card in the browser, and the unit tests. The limits and the
 * sanitisers are the part that must be identical in all three, so they live
 * where all three can import them and where a test can reach them without a
 * database.
 *
 * The one rule the whole domain rests on: **the model never produces bytes.**
 * It produces a specification, this file decides whether that specification is
 * admissible, and a trusted server-side generator turns an admissible one into
 * a file. A model that could emit base64 could emit anything.
 */

import { z } from "zod";

/* ------------------------------------------------------------------------ */
/* Formats                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Every format the artifact domain knows about, including the ones that are
 * not built.
 *
 * Listing the unsupported ones is the point. "This app cannot make a .docx
 * yet" is a true sentence the product can say; silence is how a model ends up
 * inventing a download link for a file nobody wrote. `SUPPORTED_ARTIFACT_FORMATS`
 * below is the subset a generator actually exists for, and it is the only list
 * anything is allowed to produce from.
 */
export const ARTIFACT_FORMATS = [
  "xlsx",
  "csv",
  "json",
  "txt",
  "md",
  "docx",
  "pptx",
  "pdf",
] as const;

export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

/**
 * The formats that have a real generator behind them today.
 *
 * MVP ships the spreadsheet pair. `csv` is here because the same workbook
 * specification produces it for free -- **not** as a substitute: a request for
 * `.xlsx` is answered with `.xlsx` or refused, never quietly downgraded to
 * comma-separated text (policy section 4).
 */
export const SUPPORTED_ARTIFACT_FORMATS = ["xlsx", "csv"] as const;

export type SupportedArtifactFormat = (typeof SUPPORTED_ARTIFACT_FORMATS)[number];

export const isSupportedArtifactFormat = (
  value: string
): value is SupportedArtifactFormat =>
  (SUPPORTED_ARTIFACT_FORMATS as readonly string[]).includes(value);

export const ARTIFACT_MEDIA_TYPES: Readonly<
  Record<SupportedArtifactFormat, string>
> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

export const ARTIFACT_FILE_EXTENSIONS: Readonly<
  Record<SupportedArtifactFormat, string>
> = {
  xlsx: ".xlsx",
  csv: ".csv",
};

/* ------------------------------------------------------------------------ */
/* Limits                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Explicit ceilings on everything the model controls.
 *
 * Each one bounds a different resource, so none of them is redundant:
 * `maxCells` bounds the work, `maxTextLength` bounds a single value, and
 * `maxOutputBytes` bounds the result after compression has had its say -- a
 * specification well inside the cell limit can still deflate to something no
 * download route should stream.
 */
export const ARTIFACT_LIMITS = {
  /** Worksheets in one workbook. */
  maxWorksheets: 10,
  /** Data rows in one worksheet, excluding the header. */
  maxRowsPerSheet: 10_000,
  /** Columns in one worksheet. */
  maxColumnsPerSheet: 64,
  /** Cells across the whole workbook, header rows included. */
  maxCells: 100_000,
  /** Characters in one cell value or one column header. */
  maxTextLength: 8_000,
  /** Characters in the optional per-sheet title row. */
  maxTitleLength: 200,
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
  const extension = ARTIFACT_FILE_EXTENSIONS[format];
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
  const lowered = base.toLowerCase();
  for (const known of ARTIFACT_FORMATS) {
    if (lowered.endsWith(`.${known}`)) {
      base = base.slice(0, base.length - known.length - 1).trim();
      break;
    }
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
  const extension = ARTIFACT_FILE_EXTENSIONS[format];
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
/* Workbook specification                                                     */
/* ------------------------------------------------------------------------ */

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
  currency_krw: '\u20a9#,##0',
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
    filename: z.string().min(1).max(ARTIFACT_LIMITS.maxFilenameLength),
    format: z.enum(SUPPORTED_ARTIFACT_FORMATS).optional().default("xlsx"),
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
] as const;

export type ArtifactRejectionCode = (typeof ARTIFACT_REJECTION_CODES)[number];

export type WorkbookAdmission =
  | { ok: true; spec: WorkbookSpec; cellCount: number }
  | { ok: false; code: ArtifactRejectionCode; detail: string };

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
 * Whether this specification may be generated, and the shape it generates as.
 *
 * Returns a *normalised* spec rather than validating in place: sheet names are
 * made unique and legal, rows are padded to the column count, and the whole
 * thing is counted. Everything downstream then works on a structure that is
 * already true, instead of re-deriving the same invariants and disagreeing
 * about one of them.
 */
export const admitWorkbookSpec = (input: unknown): WorkbookAdmission => {
  const parsed = workbookSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "SCHEMA_INVALID",
      detail: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }

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

export class WorkbookAdmissionError extends Error {
  constructor(
    readonly code: ArtifactRejectionCode,
    message: string
  ) {
    super(message);
    this.name = "WorkbookAdmissionError";
  }
}

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

const isSupportedFormatValue = (value: unknown): value is SupportedArtifactFormat =>
  typeof value === "string" && isSupportedArtifactFormat(value);

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
  if (!isSupportedFormatValue(record.format)) return null;
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
