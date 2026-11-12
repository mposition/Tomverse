/**
 * File conversion: what a model may ask for, decided without touching a file.
 *
 * Policy: docs/policy/generated-artifacts.md section 14.
 *
 * Pure -- no `server-only`, no storage, no image or PDF library. The schema,
 * the page-selection grammar and the ceilings are the parts that need testing
 * against every shape a model can send, and none of them needs a file to be
 * tested.
 *
 * The rule this domain adds to the artifact tools: **a conversion never asks
 * the model for bytes.** The five authoring tools take a specification the
 * model writes; this one takes the handles of files the user attached
 * (`att_1`, `att_2`) and an instruction, and the application reads, converts
 * and writes every byte itself. A model that could be handed a photograph to
 * retype would retype it as base64, which is the failure section 1 of the
 * policy exists to prevent.
 */

import { z } from "zod";

import { ARTIFACT_LIMITS } from "@/lib/generatedArtifactCore";
import { XLSX_MEDIA_TYPE } from "@/lib/messageAttachmentCore";

/* ------------------------------------------------------------------------ */
/* Operations                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The five things a conversion can be.
 *
 * Named for the result the user asked for. `to_pdf` is one operation rather
 * than three because "these photos as a PDF", "merge these PDFs" and "pages 2
 * to 5 of this PDF, rotated" are the same act -- an ordered list of pages from
 * the user's own files, written to one PDF.
 */
export const FILE_CONVERSION_OPERATIONS = [
  "to_pdf",
  "split_pdf",
  "pdf_to_images",
  "convert_images",
  "convert_spreadsheet",
] as const;

export type FileConversionOperation = (typeof FILE_CONVERSION_OPERATIONS)[number];

export const CONVERSION_IMAGE_FORMATS = ["png", "jpg", "webp"] as const;
export type ConversionImageFormat = (typeof CONVERSION_IMAGE_FORMATS)[number];

export const CONVERSION_SPREADSHEET_TARGETS = ["xlsx", "csv", "pdf"] as const;
export type ConversionSpreadsheetTarget =
  (typeof CONVERSION_SPREADSHEET_TARGETS)[number];

export const CONVERSION_PAGE_SIZES = ["a4", "letter", "fit"] as const;
export type ConversionPageSize = (typeof CONVERSION_PAGE_SIZES)[number];

/**
 * Ceilings on everything a conversion can be asked to do.
 *
 * `maxOutputBytes` is deliberately larger than `ARTIFACT_LIMITS.maxOutputBytes`.
 * That limit bounds what a model can make the application *author*; a
 * conversion's output is a rearrangement of bytes the user already uploaded,
 * and two merged 4 MB scans are 8 MB however carefully they are written. It
 * is set to the request's own attachment ceiling, so a conversion can never
 * store more than the request was allowed to carry in.
 */
export const FILE_CONVERSION_LIMITS = {
  /** Entries in `sources`. The same file may be named more than once. */
  maxSources: 20,
  /** Pages in any PDF this application writes from the user's files. */
  maxPdfPages: 500,
  /** PDF pages drawn to images in one call. Rasterising is the costly path. */
  maxRasterPages: 30,
  /** Files in a split. */
  maxSplitParts: 100,
  /** Decoded pixels of one input image. */
  maxImagePixels: 60_000_000,
  /** The long edge of an image placed on a PDF page, in pixels. */
  pdfImageMaxEdge: 2480,
  minDpi: 50,
  maxDpi: 300,
  defaultDpi: 150,
  maxDimension: 8000,
  /** Data rows read from a sheet being converted to another table format. */
  maxSpreadsheetRows: ARTIFACT_LIMITS.maxRowsPerSheet,
  maxOutputBytes: ARTIFACT_LIMITS.maxConvertedOutputBytes,
} as const;

/* ------------------------------------------------------------------------ */
/* Sources                                                                    */
/* ------------------------------------------------------------------------ */

export type ConversionSourceKind = "image" | "pdf" | "spreadsheet";

const IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const PDF_MEDIA_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const SPREADSHEET_MEDIA_TYPES = new Set([XLSX_MEDIA_TYPE, "text/csv"]);

/**
 * What a conversion can read a file *as*, or null when it cannot read it.
 *
 * Decided from the media type the server stored for the attachment, never
 * from a name: a `.pdf` that is a photograph was already repaired or refused
 * at upload, and a second opinion here would be a second place to be wrong.
 */
export const conversionSourceKind = (
  mediaType: string
): ConversionSourceKind | null => {
  const normalized = mediaType.split(";")[0].trim().toLowerCase();
  if (IMAGE_MEDIA_TYPES.has(normalized)) return "image";
  if (PDF_MEDIA_TYPES.has(normalized)) return "pdf";
  if (SPREADSHEET_MEDIA_TYPES.has(normalized)) return "spreadsheet";
  return null;
};

/** Whether any file on this turn is something a conversion could read. */
export const turnHasConvertibleAttachment = (
  attachments: readonly { mediaType: string }[] | undefined
): boolean =>
  Boolean(
    attachments?.some(
      (attachment) => conversionSourceKind(attachment.mediaType) !== null
    )
  );

/* ------------------------------------------------------------------------ */
/* Page selection                                                             */
/* ------------------------------------------------------------------------ */

export class PageSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageSelectionError";
  }
}

/**
 * Turns "1-3,5,8-" into zero-based page indices, in the order written.
 *
 * Order is kept and repeats are allowed because both are things a person asks
 * for: "3,1,2" is a reorder and "1,1" is two copies of a cover page. A range
 * may run backwards ("5-1") for the same reason. What is refused is anything
 * that names a page the file does not have -- silently clamping "1-9" to a
 * six-page file would deliver a document the user did not describe.
 */
export const parsePageSelection = (
  selection: string | undefined,
  pageCount: number,
  maxPages: number = FILE_CONVERSION_LIMITS.maxPdfPages
): number[] => {
  const text = (selection ?? "").trim().toLowerCase();
  const indices: number[] = [];
  const push = (page: number) => {
    indices.push(page - 1);
    if (indices.length > maxPages) {
      throw new PageSelectionError(
        `The selection names more than ${maxPages} pages.`
      );
    }
  };

  if (text === "" || text === "all") {
    for (let page = 1; page <= pageCount; page += 1) push(page);
    return indices;
  }

  for (const rawPart of text.split(",")) {
    const part = rawPart.trim();
    if (part === "") continue;
    const match = part.match(/^(\d{1,5})?\s*(-)?\s*(\d{1,5})?$/);
    if (!match || (!match[1] && !match[3])) {
      throw new PageSelectionError(
        `"${part.slice(0, 20)}" is not a page or a page range. Write pages as "1-3,5".`
      );
    }
    const isRange = Boolean(match[2]);
    const first = match[1] ? Number(match[1]) : 1;
    const last = isRange ? (match[3] ? Number(match[3]) : pageCount) : first;
    for (const page of [first, last]) {
      if (page < 1 || page > pageCount) {
        throw new PageSelectionError(
          `Page ${page} does not exist: the file has ${pageCount} page${pageCount === 1 ? "" : "s"}.`
        );
      }
    }
    if (first <= last) {
      for (let page = first; page <= last; page += 1) push(page);
    } else {
      for (let page = first; page >= last; page -= 1) push(page);
    }
  }

  if (indices.length === 0) {
    throw new PageSelectionError("The page selection is empty.");
  }
  return indices;
};

/* ------------------------------------------------------------------------ */
/* The specification                                                          */
/* ------------------------------------------------------------------------ */

const handleField = z
  .string()
  .regex(/^att_[1-9][0-9]{0,2}$/, "Reference an attached file as att_1, att_2, ...");

const sourceSchema = z
  .object({
    attachment: handleField.describe(
      "The handle of a file attached to this message: att_1, att_2, ..."
    ),
    pages: z
      .string()
      .max(200)
      .optional()
      .describe(
        'PDF sources only. Pages to take, in the order written, e.g. "1-3,5" or "3,1,2". Omit for every page.'
      ),
    rotate: z
      .number()
      .int()
      .optional()
      .describe("Clockwise rotation in degrees: 90, 180 or 270."),
  })
  .strict();

/**
 * One flat object rather than a union per operation.
 *
 * A discriminated union is the more exact type and the less portable schema:
 * the providers this is sent to disagree about `oneOf`, and a model handed a
 * shape its provider flattened badly sends something no branch accepts. The
 * per-operation rules are therefore checked in `admitFileConversionSpec`,
 * where the answer is a sentence the model can act on rather than a schema
 * error.
 */
export const fileConversionSpecSchema = z
  .object({
    operation: z.enum(FILE_CONVERSION_OPERATIONS).describe(
      "to_pdf: images and/or PDF pages, in order, into ONE PDF (image to PDF, merge, extract, reorder, rotate). " +
        "split_pdf: one PDF into several PDFs in a .zip. " +
        "pdf_to_images: PDF pages as PNG/JPG/WebP images. " +
        "convert_images: change an image's format, size or quality. " +
        "convert_spreadsheet: an .xlsx or .csv into xlsx, csv or a PDF table."
    ),
    filename: z
      .string()
      .min(1)
      .max(ARTIFACT_LIMITS.maxFilenameLength)
      .describe("Name of the file that comes back. The extension is added for you."),
    sources: z
      .array(sourceSchema)
      .min(1)
      .max(FILE_CONVERSION_LIMITS.maxSources)
      .describe("The attached files to read, in output order."),
    pageSize: z
      .enum(CONVERSION_PAGE_SIZES)
      .optional()
      .describe(
        'to_pdf, image sources: "a4" (default) or "letter" fits each image on a page; "fit" makes each page the size of its image.'
      ),
    splitEvery: z
      .number()
      .int()
      .min(1)
      .max(FILE_CONVERSION_LIMITS.maxPdfPages)
      .optional()
      .describe(
        "split_pdf with one source: pages per output file. Omit and give several sources with `pages` to split by ranges instead."
      ),
    imageFormat: z
      .enum(CONVERSION_IMAGE_FORMATS)
      .optional()
      .describe("pdf_to_images (default png) and convert_images (required)."),
    dpi: z
      .number()
      .int()
      .min(FILE_CONVERSION_LIMITS.minDpi)
      .max(FILE_CONVERSION_LIMITS.maxDpi)
      .optional()
      .describe("pdf_to_images: resolution, default 150."),
    maxDimension: z
      .number()
      .int()
      .min(16)
      .max(FILE_CONVERSION_LIMITS.maxDimension)
      .optional()
      .describe("convert_images: shrink so the longer side is at most this many pixels."),
    quality: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("JPG and WebP quality, 1-100. Lower is smaller."),
    targetFormat: z
      .enum(CONVERSION_SPREADSHEET_TARGETS)
      .optional()
      .describe("convert_spreadsheet (required): xlsx, csv or pdf."),
    sheet: z
      .string()
      .max(120)
      .optional()
      .describe("convert_spreadsheet: worksheet name, when the workbook has several."),
  })
  .strict();

export type FileConversionSpec = z.infer<typeof fileConversionSpecSchema>;
export type FileConversionSource = FileConversionSpec["sources"][number];

export type FileConversionAdmission =
  | { ok: true; spec: FileConversionSpec }
  | { ok: false; detail: string };

const ROTATIONS = new Set([0, 90, 180, 270]);

/**
 * The specification, re-checked inside `execute`.
 *
 * Shapes only. Whether `att_2` exists, is the caller's, and is a PDF is
 * decided against the turn's resolved attachments by the conversion itself --
 * a schema cannot answer a question about a file.
 */
export const admitFileConversionSpec = (
  input: unknown
): FileConversionAdmission => {
  const parsed = fileConversionSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      detail: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }
  const spec = parsed.data;

  for (const source of spec.sources) {
    if (source.rotate !== undefined && !ROTATIONS.has(source.rotate)) {
      return { ok: false, detail: "rotate must be 90, 180 or 270." };
    }
  }

  const distinct = new Set(spec.sources.map((source) => source.attachment));
  switch (spec.operation) {
    case "split_pdf":
      if (spec.splitEvery !== undefined && spec.sources.length !== 1) {
        return {
          ok: false,
          detail: "splitEvery splits ONE source. Give exactly one source with it.",
        };
      }
      if (distinct.size !== 1) {
        return {
          ok: false,
          detail:
            "split_pdf splits one PDF. Name the same attachment in every source, each with its own `pages`.",
        };
      }
      break;
    case "convert_images":
      if (!spec.imageFormat) {
        return { ok: false, detail: "convert_images needs imageFormat: png, jpg or webp." };
      }
      break;
    case "convert_spreadsheet":
      if (!spec.targetFormat) {
        return {
          ok: false,
          detail: "convert_spreadsheet needs targetFormat: xlsx, csv or pdf.",
        };
      }
      if (spec.sources.length !== 1) {
        return { ok: false, detail: "convert_spreadsheet converts one file per call." };
      }
      break;
    default:
      break;
  }

  return { ok: true, spec };
};

/* ------------------------------------------------------------------------ */
/* The conversion itself, as the tool sees it                                 */
/* ------------------------------------------------------------------------ */

export const FILE_CONVERSION_ERROR_CODES = [
  "SOURCE_MISSING",
  "SOURCE_TYPE",
  "PAGES_INVALID",
  "PDF_ENCRYPTED",
  "PDF_UNREADABLE",
  "IMAGE_UNREADABLE",
  "SPREADSHEET_UNREADABLE",
  "TOO_MANY_PAGES",
  "OUTPUT_TOO_LARGE",
  "RASTER_UNAVAILABLE",
  "CONVERSION_FAILED",
] as const;

export type FileConversionErrorCode =
  (typeof FILE_CONVERSION_ERROR_CODES)[number];

/**
 * A conversion that cannot be done, with a sentence the model can repeat.
 *
 * The message is written to be read by the model and, through it, the user:
 * it names files by the handle and the name the user gave them and says what
 * would work instead. It never carries file content.
 */
export class FileConversionError extends Error {
  constructor(
    readonly code: FileConversionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FileConversionError";
  }
}

export type ConversionAttachment = {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
};

export type ConvertedFile = {
  bytes: Uint8Array;
  /** Human-readable size of the work, e.g. "3 pages from 2 files". */
  parts: string;
};

/**
 * A conversion that has been checked and not yet run.
 *
 * Split in two because the caller has to know the output format *before* the
 * work starts -- the progress chip and the failure card are both labelled
 * with it -- and the format of some conversions depends on the files (one
 * page drawn to an image is an image; five are a .zip).
 */
export type PreparedConversion = {
  /** An artifact format id: pdf, zip, png, jpg, webp, xlsx or csv. */
  format: string;
  render: () => Promise<ConvertedFile>;
};

/**
 * A conservative allowance for what the tool definition itself costs.
 *
 * Counted separately from `ARTIFACT_TOOL_DEFINITION_TOKENS` because the tool
 * is registered only on a turn that carries a file it could read, and folding
 * it into that constant would price it into every request that never sends it.
 * Measured against the rendered schema and description (about 3,500
 * characters, roughly 1,000 tokens) and rounded up by the same margin the
 * batch tool's allowance carries, so the reservation is never short.
 */
export const FILE_CONVERSION_TOOL_DEFINITION_TOKENS = 1500;
