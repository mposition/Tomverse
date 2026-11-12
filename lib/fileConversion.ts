/**
 * File conversion: the part that reads and writes bytes.
 *
 * Policy: docs/policy/generated-artifacts.md section 14.
 *
 * Everything here works on files the *user* attached to the turn being
 * answered, resolved and ownership-checked by the request layer before this
 * module is reached. The model contributes handles and an instruction
 * (lib/fileConversionCore.ts) and never a byte.
 *
 * Three libraries, each for the one thing nothing here should hand-write:
 *
 *   * `pdf-lib` copies pages between PDFs and places images on pages. Its
 *     parser and writer yield to the event loop between batches of objects,
 *     which is why it can run on the request thread.
 *   * `sharp` decodes, orients, resizes and re-encodes images.
 *   * PDFium, built to WebAssembly (`@hyzyla/pdfium`), draws a PDF page to
 *     pixels, in a worker thread so the drawing does not stall other
 *     requests. Not pdf.js: pdf.js draws through `@napi-rs/canvas`, a native
 *     module that crashed the whole process when a worker that had loaded it
 *     was terminated -- reproduced locally with one worker at a time. A
 *     WebAssembly engine has no native code to crash, so a worker can be
 *     stopped on a timeout like any other.
 */

import "server-only";

import { Worker } from "node:worker_threads";

import { PDFDocument, degrees } from "pdf-lib";

import {
  FILE_CONVERSION_LIMITS,
  FileConversionError,
  PageSelectionError,
  conversionSourceKind,
  isOfficeRenderable,
  parsePageSelection,
  type ConversionAttachment,
  type ConversionImageFormat,
  type ConversionSourceKind,
  type FileConversionOperation,
  type FileConversionSpec,
  type PreparedConversion,
} from "@/lib/fileConversionCore";
import {
  ARTIFACT_LIMITS,
  admitDocumentSpec,
  admitWorkbookSpecSafely,
  sanitizeArtifactFilename,
  type ArtifactCellValue,
} from "@/lib/generatedArtifactCore";
import { renderDocumentPdf } from "@/lib/generatedArtifactPdf";
import { zipArchiveEntries } from "@/lib/generatedArtifactText";
import { renderWorkbook } from "@/lib/generatedArtifactXlsx";
import { XLSX_MEDIA_TYPE } from "@/lib/messageAttachmentCore";
import {
  officeRendererConfig,
  renderOfficeDocumentToPdf,
  type OfficeDocument,
  type OfficeRenderResult,
} from "@/lib/officeRenderer";
import {
  SpreadsheetDataError,
  readSpreadsheetGrid,
} from "@/lib/spreadsheetDataRows";

export { FileConversionError } from "@/lib/fileConversionCore";

/* ------------------------------------------------------------------------ */
/* Sources                                                                    */
/* ------------------------------------------------------------------------ */

type ResolvedSource = {
  handle: string;
  name: string;
  mediaType: string;
  kind: ConversionSourceKind;
  bytes: Uint8Array;
  pages: string | undefined;
  rotate: number;
};

const ACCEPTED_KINDS: Record<
  FileConversionOperation,
  readonly ConversionSourceKind[]
> = {
  to_pdf: ["image", "pdf"],
  split_pdf: ["pdf"],
  pdf_to_images: ["pdf"],
  convert_images: ["image"],
  convert_spreadsheet: ["spreadsheet"],
};

const KIND_NOUN: Record<ConversionSourceKind, string> = {
  image: "an image (png, jpg, webp, gif)",
  pdf: "a PDF",
  spreadsheet: "a spreadsheet (.xlsx or .csv)",
  office: "an office document (Word, PowerPoint, Excel, HWP, ODF, Pages, Numbers)",
};

/**
 * Renders one office document to PDF. Injected by tests; the default is the
 * renderer service from the environment, or none when office rendering is off.
 */
export type OfficeRender = (document: OfficeDocument) => Promise<OfficeRenderResult>;

export type FileConversionOptions = {
  /** null turns office rendering off whatever the environment says. */
  renderOffice?: OfficeRender | null;
};

const defaultOfficeRender = (): OfficeRender | null => {
  const config = officeRendererConfig();
  return config ? (document) => renderOfficeDocumentToPdf(config, document) : null;
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const describeAttached = (
  attachments: ReadonlyMap<string, ConversionAttachment>
): string =>
  attachments.size === 0
    ? "No files are attached to this message."
    : `The files attached to this message are: ${Array.from(attachments)
        .map(([handle, file]) => `${handle} ("${file.name}")`)
        .join(", ")}.`;

const resolveSources = (
  spec: FileConversionSpec,
  attachments: ReadonlyMap<string, ConversionAttachment>,
  officeRendering: boolean
): ResolvedSource[] => {
  const accepted: readonly ConversionSourceKind[] =
    spec.operation === "to_pdf" && officeRendering
      ? [...ACCEPTED_KINDS.to_pdf, "office"]
      : ACCEPTED_KINDS[spec.operation];
  return spec.sources.map((source) => {
    const file = attachments.get(source.attachment);
    if (!file) {
      throw new FileConversionError(
        "SOURCE_MISSING",
        `There is no file ${source.attachment} on this message. ` +
          `${describeAttached(attachments)} A file from an earlier message ` +
          "has to be attached again to be converted."
      );
    }
    // An office file into a PDF is laid out by the renderer, an .xlsx
    // included: "this workbook as a PDF" means the sheet as it prints, while
    // a table of its values is what convert_spreadsheet makes.
    const officeSource = spec.operation === "to_pdf" && isOfficeRenderable(file.mediaType);
    if (officeSource && !officeRendering) {
      throw new FileConversionError(
        "SOURCE_TYPE",
        `${source.attachment} ("${file.name}") cannot be turned into a PDF with its layout here. ` +
          "Offer to rebuild its content as a PDF with create_document instead, and say " +
          "that the layout is rebuilt rather than copied."
      );
    }
    const kind: ConversionSourceKind | null = officeSource
      ? "office"
      : conversionSourceKind(file.mediaType);
    if (!kind || !accepted.includes(kind)) {
      throw new FileConversionError(
        "SOURCE_TYPE",
        `${source.attachment} ("${file.name}") cannot be used for ` +
          `${spec.operation}: it needs ${accepted
            .map((entry) => KIND_NOUN[entry])
            .join(" or ")}.`
      );
    }
    if (source.pages !== undefined && kind !== "pdf" && kind !== "office") {
      throw new FileConversionError(
        "PAGES_INVALID",
        `${source.attachment} ("${file.name}") is not a PDF, so it has no pages to select.`
      );
    }
    return {
      handle: source.attachment,
      name: file.name,
      mediaType: file.mediaType,
      kind,
      bytes: file.bytes,
      pages: source.pages,
      rotate: source.rotate ?? 0,
    };
  });
};

/* ------------------------------------------------------------------------ */
/* Names                                                                      */
/* ------------------------------------------------------------------------ */

/** A file's name without its extension, safe to use inside an archive. */
const baseNameOf = (name: string): string => {
  const leaf = name.split(/[\\/]/).pop() ?? "";
  const withoutExtension = leaf.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  // The sanitiser appends an extension it owns; ".txt" is taken back off.
  return sanitizeArtifactFilename(withoutExtension || "file", "txt").slice(0, -4);
};

/**
 * Entry paths for a .zip, made unique without changing the first of a name.
 *
 * Checked against the paths actually handed out, not against a count per
 * name: "scan.jpg", "scan (2).jpg" and "scan.png" converted to one format
 * would otherwise mint "scan (2)" twice, and the archive writer keys entries
 * by path -- the second would silently replace the first. Compared without
 * case, because the archive is opened on file systems that fold it.
 */
const uniquePaths = () => {
  const used = new Set<string>();
  return (base: string, extension: string): string => {
    let path = `${base}.${extension}`;
    for (let count = 2; used.has(path.toLowerCase()); count += 1) {
      path = `${base} (${count}).${extension}`;
    }
    used.add(path.toLowerCase());
    return path;
  };
};

const assertOutputSize = (bytes: Uint8Array, hint: string): Uint8Array => {
  if (bytes.byteLength > FILE_CONVERSION_LIMITS.maxOutputBytes) {
    throw new FileConversionError(
      "OUTPUT_TOO_LARGE",
      `The converted file would be ${Math.ceil(bytes.byteLength / 1024 / 1024)} MB, over the ` +
        `${FILE_CONVERSION_LIMITS.maxOutputBytes / 1024 / 1024} MB limit. ${hint}`
    );
  }
  return bytes;
};

/**
 * The bytes a multi-file conversion is holding, checked as each file is made.
 *
 * Every conversion that writes several files keeps them in memory until the
 * archive is built, and a source may be named twenty times. Checked once at
 * the end, twenty copies of one large image are all held before the refusal;
 * checked here, the work stops at the first file past the ceiling.
 */
const outputBudget = (hint: string) => {
  let held = 0;
  return (bytes: Uint8Array): Uint8Array => {
    held += bytes.byteLength;
    if (held > FILE_CONVERSION_LIMITS.maxOutputBytes) {
      throw new FileConversionError(
        "OUTPUT_TOO_LARGE",
        `The converted files would be over ${Math.ceil(held / 1024 / 1024)} MB, past the ` +
          `${FILE_CONVERSION_LIMITS.maxOutputBytes / 1024 / 1024} MB limit. ${hint}`
      );
    }
    return bytes;
  };
};

/* ------------------------------------------------------------------------ */
/* PDF reading                                                                */
/* ------------------------------------------------------------------------ */

const loadPdf = async (source: ResolvedSource): Promise<PDFDocument> => {
  try {
    return await PDFDocument.load(source.bytes, { updateMetadata: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/encrypted/i.test(message)) {
      throw new FileConversionError(
        "PDF_ENCRYPTED",
        `${source.handle} ("${source.name}") is password-protected, so its pages cannot be ` +
          "copied. The user has to remove the password and attach it again."
      );
    }
    throw new FileConversionError(
      "PDF_UNREADABLE",
      `${source.handle} ("${source.name}") could not be read as a PDF.`
    );
  }
};

/** One loaded document per attachment, however many sources name it. */
const pdfLoader = () => {
  const loaded = new Map<string, Promise<PDFDocument>>();
  return (source: ResolvedSource): Promise<PDFDocument> => {
    let pending = loaded.get(source.handle);
    if (!pending) {
      pending = loadPdf(source);
      loaded.set(source.handle, pending);
    }
    return pending;
  };
};

const selectPages = (
  source: ResolvedSource,
  pageCount: number,
  maxPages: number
): number[] => {
  try {
    return parsePageSelection(source.pages, pageCount, maxPages);
  } catch (error) {
    if (error instanceof PageSelectionError) {
      throw new FileConversionError(
        error.reason === "too_many" ? "TOO_MANY_PAGES" : "PAGES_INVALID",
        `${source.handle} ("${source.name}"): ${error.message}` +
          (error.reason === "too_many" ? " Offer a smaller page range." : "")
      );
    }
    throw error;
  }
};

/* ------------------------------------------------------------------------ */
/* Images                                                                     */
/* ------------------------------------------------------------------------ */

type EncodedImage = { data: Buffer; width: number; height: number };

const encodeImage = async (
  input: Uint8Array,
  options: {
    name: string;
    handle: string;
    rotate: number;
    maxEdge?: number;
    format: ConversionImageFormat;
    quality?: number;
  }
): Promise<EncodedImage> => {
  const sharp = (await import("sharp")).default;
  // Read the header first, on its own. A file that fails *here* is not an
  // image this can read, and the user needs a different file; a failure past
  // this point is the conversion's, and trying again is the right advice.
  try {
    await sharp(Buffer.from(input), {
      limitInputPixels: FILE_CONVERSION_LIMITS.maxImagePixels,
    }).metadata();
  } catch (error) {
    if (!(error instanceof Error && /pixel limit/i.test(error.message))) {
      throw new FileConversionError(
        "IMAGE_UNREADABLE",
        `${options.handle} ("${options.name}") could not be read as an image.`
      );
    }
  }
  try {
    // `autoOrient` first: a phone photograph is stored sideways with a note
    // saying which way is up, and a PDF page has nowhere to keep the note.
    let pipeline = sharp(Buffer.from(input), {
      limitInputPixels: FILE_CONVERSION_LIMITS.maxImagePixels,
      failOn: "error",
    }).autoOrient();
    if (options.rotate) pipeline = pipeline.rotate(options.rotate);
    if (options.maxEdge) {
      pipeline = pipeline.resize({
        width: options.maxEdge,
        height: options.maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    pipeline = pipeline.toColourspace("srgb");
    switch (options.format) {
      case "jpg":
        // JPEG has no transparency; without this a transparent PNG turns black.
        pipeline = pipeline
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: options.quality ?? 85 });
        break;
      case "webp":
        pipeline = pipeline.webp({ quality: options.quality ?? 82 });
        break;
      default:
        pipeline = pipeline.png({ compressionLevel: 9 });
        break;
    }
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      throw new FileConversionError(
        "OUTPUT_TOO_LARGE",
        `${options.handle} ("${options.name}") has more than ` +
          `${FILE_CONVERSION_LIMITS.maxImagePixels / 1_000_000} million pixels, ` +
          "which is the most one image may have. Offer to convert a smaller image."
      );
    }
    // Decoded the header and still failed: the file is an image, so the
    // failure is the conversion's -- "try again", not "attach another file".
    throw new FileConversionError(
      "CONVERSION_FAILED",
      `${options.handle} ("${options.name}") could not be converted. Offer to try again.`
    );
  }
};

const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
} as const;

/** Points of margin around an image fitted to a paper size. */
const PAGE_MARGIN = 18;
/** Points per pixel for a page sized to its image (96 dpi). */
const POINTS_PER_PIXEL = 0.75;

/* ------------------------------------------------------------------------ */
/* to_pdf                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * How large an image may be on its way into a PDF, tried in order.
 *
 * The first step is print quality on A4; the later ones exist only for the
 * request whose photographs would otherwise put the file over the output
 * ceiling. A smaller file the user gets is better than a sharper one they do
 * not.
 */
const PDF_IMAGE_STEPS = [
  { maxEdge: FILE_CONVERSION_LIMITS.pdfImageMaxEdge, quality: 85 },
  { maxEdge: 1754, quality: 76 },
  { maxEdge: 1240, quality: 68 },
] as const;

/**
 * Office sources, rendered to PDF and handed on as PDFs.
 *
 * Rendered once per attachment however many sources name it, and one at a
 * time: the renderer is a shared service, and a request with five decks
 * should not hold five of its slots.
 */
const renderOfficeSources = async (
  sources: ResolvedSource[],
  render: OfficeRender
): Promise<ResolvedSource[]> => {
  const rendered = new Map<string, Uint8Array>();
  const out: ResolvedSource[] = [];
  for (const source of sources) {
    if (source.kind !== "office") {
      out.push(source);
      continue;
    }
    let pdf = rendered.get(source.handle);
    if (!pdf) {
      const result = await render({ mediaType: source.mediaType, bytes: source.bytes });
      if (!result.ok) {
        switch (result.failure) {
          case "UNREADABLE":
            throw new FileConversionError(
              "OFFICE_UNREADABLE",
              `${source.handle} ("${source.name}") could not be opened to lay it out. ` +
                "It may be damaged or password-protected."
            );
          case "TOO_LARGE":
            throw new FileConversionError(
              "OUTPUT_TOO_LARGE",
              `${source.handle} ("${source.name}") would be a PDF over the ` +
                `${FILE_CONVERSION_LIMITS.maxOutputBytes / 1024 / 1024} MB limit.`
            );
          default:
            throw new FileConversionError(
              "RENDERER_UNAVAILABLE",
              "Laying out office documents is not available right now. Offer to try again shortly."
            );
        }
      }
      pdf = result.pdf;
      rendered.set(source.handle, pdf);
    }
    out.push({ ...source, kind: "pdf", mediaType: "application/pdf", bytes: pdf });
  }
  return out;
};

const prepareToPdf = async (
  spec: FileConversionSpec,
  resolved: ResolvedSource[],
  render: OfficeRender | null
): Promise<PreparedConversion> => {
  const sources = render ? await renderOfficeSources(resolved, render) : resolved;
  // The page size places an image on paper. PDF pages keep their own size,
  // so on a request with no image it would be an instruction nothing reads.
  if (spec.pageSize !== undefined && !sources.some((source) => source.kind === "image")) {
    throw new FileConversionError(
      "SOURCE_TYPE",
      "pageSize places images on pages; these sources are all PDFs, whose pages keep their own size. Leave out pageSize."
    );
  }
  const load = pdfLoader();
  const plan: Array<
    | { source: ResolvedSource; kind: "image" }
    | { source: ResolvedSource; kind: "pdf"; indices: number[] }
  > = [];
  let pageTotal = 0;
  for (const source of sources) {
    if (source.kind === "pdf") {
      const document = await load(source);
      const indices = selectPages(
        source,
        document.getPageCount(),
        FILE_CONVERSION_LIMITS.maxPdfPages
      );
      pageTotal += indices.length;
      plan.push({ source, kind: "pdf", indices });
    } else {
      pageTotal += 1;
      plan.push({ source, kind: "image" });
    }
  }
  if (pageTotal > FILE_CONVERSION_LIMITS.maxPdfPages) {
    throw new FileConversionError(
      "TOO_MANY_PAGES",
      `That would be ${pageTotal} pages; one PDF can hold at most ` +
        `${FILE_CONVERSION_LIMITS.maxPdfPages}.`
    );
  }

  const build = async (
    step: (typeof PDF_IMAGE_STEPS)[number]
  ): Promise<Uint8Array> => {
    const output = await PDFDocument.create();
    output.setProducer("Tomverse");
    output.setCreator("Tomverse");
    for (const entry of plan) {
      if (entry.kind === "pdf") {
        const pages = await output.copyPages(
          await load(entry.source),
          entry.indices
        );
        for (const page of pages) {
          if (entry.source.rotate) {
            page.setRotation(
              degrees((page.getRotation().angle + entry.source.rotate) % 360)
            );
          }
          output.addPage(page);
        }
        continue;
      }

      const image = await encodeImage(entry.source.bytes, {
        name: entry.source.name,
        handle: entry.source.handle,
        rotate: entry.source.rotate,
        maxEdge: step.maxEdge,
        format: "jpg",
        quality: step.quality,
      });
      const embedded = await output.embedJpg(image.data);
      const pageSize = spec.pageSize ?? "a4";
      if (pageSize === "fit") {
        const width = image.width * POINTS_PER_PIXEL;
        const height = image.height * POINTS_PER_PIXEL;
        output.addPage([width, height]).drawImage(embedded, {
          x: 0,
          y: 0,
          width,
          height,
        });
        continue;
      }
      const [short, long] = PAGE_SIZES[pageSize];
      // The paper turns to suit the picture, as a person would turn it.
      const landscape = image.width > image.height;
      const pageWidth = landscape ? long : short;
      const pageHeight = landscape ? short : long;
      // Shrunk to fit, never enlarged past 96 dpi: a 50-pixel icon stretched
      // over A4 is a blur, not the user's image.
      const scale = Math.min(
        (pageWidth - PAGE_MARGIN * 2) / image.width,
        (pageHeight - PAGE_MARGIN * 2) / image.height,
        POINTS_PER_PIXEL
      );
      const width = image.width * scale;
      const height = image.height * scale;
      output.addPage([pageWidth, pageHeight]).drawImage(embedded, {
        x: (pageWidth - width) / 2,
        y: (pageHeight - height) / 2,
        width,
        height,
      });
    }
    return output.save();
  };

  const hasImages = plan.some((entry) => entry.kind === "image");
  const fileCount = new Set(sources.map((source) => source.handle)).size;
  return {
    format: "pdf",
    render: async () => {
      let bytes: Uint8Array | null = null;
      for (const step of hasImages ? PDF_IMAGE_STEPS : PDF_IMAGE_STEPS.slice(0, 1)) {
        bytes = await build(step);
        if (bytes.byteLength <= FILE_CONVERSION_LIMITS.maxOutputBytes) break;
      }
      return {
        bytes: assertOutputSize(
          bytes!,
          "Offer to convert fewer files or fewer pages at a time."
        ),
        parts: `${plural(pageTotal, "page")} from ${plural(fileCount, "file")}`,
      };
    },
  };
};

/* ------------------------------------------------------------------------ */
/* split_pdf                                                                  */
/* ------------------------------------------------------------------------ */

const prepareSplitPdf = async (
  spec: FileConversionSpec,
  sources: ResolvedSource[]
): Promise<PreparedConversion> => {
  const load = pdfLoader();
  const first = sources[0];
  const document = await load(first);
  const pageCount = document.getPageCount();

  // Each part carries its own rotation: sources may name the same PDF several
  // times, and "pages 1-2 as they are, page 5 turned" is two different parts.
  let parts: Array<{ indices: number[]; rotate: number }>;
  const everyPage = sources.length === 1 && first.pages === undefined;
  if (spec.splitEvery !== undefined || everyPage) {
    const size = spec.splitEvery ?? 1;
    const all = selectPages(first, pageCount, FILE_CONVERSION_LIMITS.maxPdfPages);
    parts = [];
    for (let start = 0; start < all.length; start += size) {
      parts.push({ indices: all.slice(start, start + size), rotate: first.rotate });
    }
  } else {
    parts = sources.map((source) => ({
      indices: selectPages(source, pageCount, FILE_CONVERSION_LIMITS.maxPdfPages),
      rotate: source.rotate,
    }));
  }
  if (parts.length > FILE_CONVERSION_LIMITS.maxSplitParts) {
    throw new FileConversionError(
      "TOO_MANY_PAGES",
      `That would be ${parts.length} files; one split can produce at most ` +
        `${FILE_CONVERSION_LIMITS.maxSplitParts}. Use a larger splitEvery.`
    );
  }

  const base = baseNameOf(first.name);
  const digits = String(parts.length).length;
  // "Pages 2 to 5 as a PDF" is one part: a PDF, not a zip holding one.
  if (parts.length === 1) {
    const [part] = parts;
    return {
      format: "pdf",
      render: async () => {
        const output = await PDFDocument.create();
        output.setProducer("Tomverse");
        output.setCreator("Tomverse");
        for (const page of await output.copyPages(document, part.indices)) {
          if (part.rotate) {
            page.setRotation(degrees((page.getRotation().angle + part.rotate) % 360));
          }
          output.addPage(page);
        }
        return {
          bytes: assertOutputSize(await output.save(), "Offer a smaller range of pages."),
          parts: `${plural(part.indices.length, "page")} from ${plural(pageCount, "page")}`,
        };
      },
    };
  }
  return {
    format: "zip",
    render: async () => {
      const entries: Array<{ path: string; bytes: Uint8Array }> = [];
      const hold = outputBudget("Offer to split a smaller range of pages.");
      for (const [index, part] of parts.entries()) {
        const output = await PDFDocument.create();
        output.setProducer("Tomverse");
        output.setCreator("Tomverse");
        const pages = await output.copyPages(document, part.indices);
        for (const page of pages) {
          if (part.rotate) {
            page.setRotation(
              degrees((page.getRotation().angle + part.rotate) % 360)
            );
          }
          output.addPage(page);
        }
        const bytes = hold(await output.save());
        entries.push({
          path: `${base}_${String(index + 1).padStart(Math.max(2, digits), "0")}.pdf`,
          bytes,
        });
      }
      return {
        bytes: assertOutputSize(
          zipArchiveEntries(entries),
          "Offer to split a smaller range of pages."
        ),
        parts: `${plural(parts.length, "PDF file")} from ${plural(pageCount, "page")}`,
      };
    },
  };
};

/* ------------------------------------------------------------------------ */
/* pdf_to_images                                                              */
/* ------------------------------------------------------------------------ */

const RASTER_TIMEOUT_MS = 90_000;
/** Pixels in one drawn page. A4 at 300 dpi is under nine million. */
const RASTER_MAX_PAGE_PIXELS = 40_000_000;

/**
 * The worker's whole program. A string, so the server bundle never carries
 * PDFium; it is loaded from node_modules when the worker starts, as
 * lib/mediaSecurity.ts loads sharp and pdf.js for its own checks.
 */
const rasterWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");

(async () => {
    let library;
    let document;
    try {
        const { PDFiumLibrary } = require("@hyzyla/pdfium");
        library = await PDFiumLibrary.init();
        document = await library.loadDocument(new Uint8Array(workerData.buffer));
        for (const index of workerData.pageIndices) {
            const page = document.getPage(index);
            const size = page.getOriginalSize();
            const pixels =
                Math.ceil(size.originalWidth * workerData.scale) *
                Math.ceil(size.originalHeight * workerData.scale);
            if (!(pixels > 0) || pixels > workerData.maxPagePixels) throw new Error("PAGE_TOO_LARGE");
            const image = await page.render({ scale: workerData.scale, render: "bitmap" });
            page.close();
            // Copied out of the WebAssembly heap, then handed over, one page
            // at a time: the next page is drawn only when this one is taken.
            const data = Uint8Array.from(image.data).buffer;
            parentPort.postMessage(
                { type: "page", width: image.width, height: image.height, data },
                [data]
            );
            await new Promise((resolve) => parentPort.once("message", resolve));
        }
        document.destroy();
        library.destroy();
        parentPort.postMessage({ type: "done" });
    } catch (error) {
        try {
            if (document) document.destroy();
            if (library) library.destroy();
        } catch {}
        const message = error && typeof error.message === "string" ? error.message : "";
        const code =
            message === "PAGE_TOO_LARGE"
                ? message
                : error && error.code === "MODULE_NOT_FOUND"
                  ? "UNAVAILABLE"
                  : "RENDER_FAILED";
        parentPort.postMessage({ type: "failed", code });
    }
})();
`;

type RasterMessage =
  | { type: "page"; width: number; height: number; data: ArrayBuffer }
  | { type: "done" }
  | { type: "failed"; code: string };

/**
 * Draws the named pages of one PDF to PNG, off the request thread.
 *
 * The worker runs WebAssembly only and hands back raw pixels; PNG is encoded
 * here, by sharp on its own thread pool. sharp is native, and a worker that
 * is stopped on a timeout must hold no native module -- that is the failure
 * this engine was chosen to avoid.
 */
const rasterizePdfPages = (
  source: ResolvedSource,
  pageIndices: number[],
  dpi: number
): Promise<Uint8Array[]> =>
  new Promise((resolve, reject) => {
    // A copy, so transferring it to the worker leaves the caller's bytes whole.
    const buffer = Uint8Array.from(source.bytes).buffer;
    // Constructed here and named nowhere else, so the string above is the
    // whole of what the worker can run.
    const worker = new Worker(rasterWorkerSource, {
      eval: true,
      workerData: {
        buffer,
        pageIndices,
        scale: dpi / 72,
        maxPagePixels: RASTER_MAX_PAGE_PIXELS,
      },
      transferList: [buffer],
      resourceLimits: {
        maxOldGenerationSizeMb: 512,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 4,
      },
    });

    const pages: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const finish = (error: FileConversionError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(pages);
    };
    const tooLarge = () =>
      new FileConversionError(
        "OUTPUT_TOO_LARGE",
        `The pages of ${source.handle} ("${source.name}") are too large to draw at ` +
          `${dpi} dpi. Offer a lower dpi or fewer pages.`
      );
    const failed = () =>
      new FileConversionError(
        "CONVERSION_FAILED",
        `${source.handle} ("${source.name}") could not be drawn as images.`
      );
    const timeout = setTimeout(
      () =>
        finish(
          new FileConversionError(
            "CONVERSION_FAILED",
            `Drawing ${source.handle} ("${source.name}") took too long. Offer fewer pages or a lower dpi.`
          )
        ),
      RASTER_TIMEOUT_MS
    );

    worker.on("message", (message: RasterMessage) => {
      if (settled) return;
      if (message?.type === "page") {
        void (async () => {
          try {
            const sharp = (await import("sharp")).default;
            const png = await sharp(Buffer.from(message.data), {
              raw: { width: message.width, height: message.height, channels: 4 },
            })
              .png({ compressionLevel: 6 })
              .toBuffer();
            total += png.byteLength;
            // Raw PNG is larger than what is finally stored; this only stops
            // a runaway before it exhausts memory.
            if (total > FILE_CONVERSION_LIMITS.maxOutputBytes * 4) {
              finish(tooLarge());
              return;
            }
            pages.push(new Uint8Array(png));
            if (!settled) worker.postMessage("next");
          } catch {
            finish(failed());
          }
        })();
        return;
      }
      if (message?.type === "done") {
        finish(null);
        return;
      }
      if (message?.type === "failed" && message.code === "PAGE_TOO_LARGE") {
        finish(tooLarge());
        return;
      }
      if (message?.type === "failed" && message.code === "UNAVAILABLE") {
        finish(
          new FileConversionError(
            "RASTER_UNAVAILABLE",
            "Drawing PDF pages as images is not available right now."
          )
        );
        return;
      }
      finish(failed());
    });
    worker.once("error", () => finish(failed()));
    // Any exit that was not preceded by an answer is a failure, a clean one
    // included: `finish` ignores this once the message above has settled it.
    worker.once("exit", () => finish(failed()));
  });

const IMAGE_EXTENSION: Record<ConversionImageFormat, string> = {
  png: "png",
  jpg: "jpg",
  webp: "webp",
};

const preparePdfToImages = async (
  spec: FileConversionSpec,
  sources: ResolvedSource[]
): Promise<PreparedConversion> => {
  const load = pdfLoader();
  const groups: Array<{ source: ResolvedSource; indices: number[] }> = [];
  let pageTotal = 0;
  for (const source of sources) {
    const document = await load(source);
    const indices = selectPages(
      source,
      document.getPageCount(),
      FILE_CONVERSION_LIMITS.maxRasterPages
    );
    pageTotal += indices.length;
    groups.push({ source, indices });
  }
  if (pageTotal > FILE_CONVERSION_LIMITS.maxRasterPages) {
    throw new FileConversionError(
      "TOO_MANY_PAGES",
      `That would be ${pageTotal} images; one request can draw at most ` +
        `${FILE_CONVERSION_LIMITS.maxRasterPages} pages. Offer a page range.`
    );
  }

  const imageFormat = spec.imageFormat ?? "png";
  const extension = IMAGE_EXTENSION[imageFormat];
  const dpi = spec.dpi ?? FILE_CONVERSION_LIMITS.defaultDpi;
  return {
    format: pageTotal === 1 ? imageFormat : "zip",
    render: async () => {
      const nameFor = uniquePaths();
      const entries: Array<{ path: string; bytes: Uint8Array }> = [];
      const hold = outputBudget("Offer a lower dpi, JPG instead of PNG, or fewer pages.");
      for (const { source, indices } of groups) {
        const pages = await rasterizePdfPages(source, indices, dpi);
        const base = baseNameOf(source.name);
        for (const [position, png] of pages.entries()) {
          const image = await encodeImage(png, {
            name: source.name,
            handle: source.handle,
            rotate: source.rotate,
            format: imageFormat,
            ...(spec.quality !== undefined ? { quality: spec.quality } : {}),
          });
          entries.push({
            path: nameFor(`${base}_p${indices[position] + 1}`, extension),
            bytes: hold(image.data),
          });
        }
      }
      const hint = "Offer a lower dpi, JPG instead of PNG, or fewer pages.";
      return {
        bytes: assertOutputSize(
          entries.length === 1 ? entries[0].bytes : zipArchiveEntries(entries),
          hint
        ),
        parts: `${plural(pageTotal, `${imageFormat.toUpperCase()} image`)} at ${dpi} dpi`,
      };
    },
  };
};

/* ------------------------------------------------------------------------ */
/* convert_images                                                             */
/* ------------------------------------------------------------------------ */

const prepareConvertImages = async (
  spec: FileConversionSpec,
  sources: ResolvedSource[]
): Promise<PreparedConversion> => {
  const imageFormat = spec.imageFormat!;
  const extension = IMAGE_EXTENSION[imageFormat];
  return {
    format: sources.length === 1 ? imageFormat : "zip",
    render: async () => {
      const nameFor = uniquePaths();
      const entries: Array<{ path: string; bytes: Uint8Array }> = [];
      const hold = outputBudget("Offer a smaller maxDimension or a lower quality.");
      let last: EncodedImage | null = null;
      for (const source of sources) {
        last = await encodeImage(source.bytes, {
          name: source.name,
          handle: source.handle,
          rotate: source.rotate,
          format: imageFormat,
          ...(spec.maxDimension !== undefined ? { maxEdge: spec.maxDimension } : {}),
          ...(spec.quality !== undefined ? { quality: spec.quality } : {}),
        });
        entries.push({
          path: nameFor(baseNameOf(source.name), extension),
          bytes: hold(last.data),
        });
      }
      const single = entries.length === 1 && last;
      return {
        bytes: assertOutputSize(
          single ? entries[0].bytes : zipArchiveEntries(entries),
          "Offer a smaller maxDimension or a lower quality."
        ),
        parts: single
          ? `${imageFormat.toUpperCase()} image, ${last!.width}x${last!.height} pixels`
          : plural(entries.length, `${imageFormat.toUpperCase()} image`),
      };
    },
  };
};

/* ------------------------------------------------------------------------ */
/* convert_spreadsheet                                                        */
/* ------------------------------------------------------------------------ */

/**
 * A cell that is unambiguously a plain number.
 *
 * Deliberately narrow. "007", "1e5", "+82-10" and a sixteen-digit card number
 * are all things a spreadsheet would happily reinterpret and a person would
 * not thank it for; they stay text. What is left is written as a number so a
 * converted workbook can be summed and a converted CSV is not guarded as if
 * "-5" were a formula.
 *
 * The shape alone is not enough: "999999999999999.99" has the shape and does
 * not survive a double. So the value must also print back as exactly the text
 * it was read from -- anything a number cannot hold, or would restyle
 * ("1.50"), stays the text the user wrote.
 */
const PLAIN_NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/;

/**
 * Significant digits in a plain decimal: what a spreadsheet can hold is
 * fifteen, and a value past that is rounded the moment it is read back
 * ("123456789012345.6" reopens as 123456789012346).
 */
const significantDigits = (value: string): number =>
  value.replace(/^-/, "").replace(".", "").replace(/^0+/, "").length;

const toCell = (value: string): ArtifactCellValue => {
  if (value === "") return null;
  return PLAIN_NUMBER.test(value) &&
    String(Number(value)) === value &&
    significantDigits(value) <= 15
    ? Number(value)
    : value;
};

/** Excel's rules for a worksheet name, applied to a name we did not choose. */
const worksheetName = (name: string): string =>
  name.replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").slice(0, 31).trim() ||
  "Sheet1";

const prepareConvertSpreadsheet = async (
  spec: FileConversionSpec,
  sources: ResolvedSource[]
): Promise<PreparedConversion> => {
  const source = sources[0];
  const target = spec.targetFormat!;
  const sourceFormat = source.mediaType.startsWith(XLSX_MEDIA_TYPE) ? "xlsx" : "csv";
  if (sourceFormat === "csv" && spec.sheet !== undefined) {
    throw new FileConversionError(
      "SOURCE_TYPE",
      `${source.handle} ("${source.name}") is a CSV file, which has no worksheets; leave out sheet.`
    );
  }
  if (sourceFormat === target) {
    throw new FileConversionError(
      "SOURCE_TYPE",
      `${source.handle} ("${source.name}") is already a .${target} file.`
    );
  }

  let table: ReturnType<typeof readSpreadsheetGrid>;
  try {
    table = readSpreadsheetGrid(source.bytes, {
      mediaType: sourceFormat === "csv" ? "text/csv" : source.mediaType,
      ...(spec.sheet !== undefined ? { sheet: spec.sheet } : {}),
      maxRows: FILE_CONVERSION_LIMITS.maxSpreadsheetRows,
      maxValueLength: ARTIFACT_LIMITS.maxTextLength,
    });
  } catch (error) {
    if (error instanceof SpreadsheetDataError) {
      throw new FileConversionError(
        "SPREADSHEET_UNREADABLE",
        `${source.handle} ("${source.name}"): ${error.message}`
      );
    }
    throw error;
  }
  if (table.grid.length === 0) {
    throw new FileConversionError(
      "SPREADSHEET_UNREADABLE",
      `${source.handle} ("${source.name}") has no rows to convert.`
    );
  }

  const width = table.grid.reduce((max, row) => Math.max(max, row.length), 0);
  const columnLimit =
    target === "pdf"
      ? ARTIFACT_LIMITS.maxDocumentTableColumns
      : ARTIFACT_LIMITS.maxColumnsPerSheet;
  const dataRows = table.grid.length - 1;
  if (width > columnLimit) {
    throw new FileConversionError(
      "TOO_MANY_PAGES",
      `The sheet has ${width} columns; a .${target} conversion holds at most ${columnLimit}.`
    );
  }
  if (target === "pdf" && dataRows > ARTIFACT_LIMITS.maxDocumentTableRows) {
    throw new FileConversionError(
      "TOO_MANY_PAGES",
      `The sheet has ${dataRows} rows; a PDF table holds at most ` +
        `${ARTIFACT_LIMITS.maxDocumentTableRows}. Offer xlsx or csv instead.`
    );
  }

  // The first row goes where a header goes, because every table format here
  // has one -- but it is written exactly as it was read. Whether it *is* a
  // header is not this code's to decide, and a blank cell in it stays blank.
  const firstRow = Array.from({ length: width }, (_, index) => table.grid[0][index] ?? "");
  const rows = table.grid
    .slice(1)
    .map((row) =>
      Array.from({ length: width }, (_, index) => toCell(row[index] ?? ""))
    );
  const otherSheets = table.sheetNames.length > 1;
  const parts =
    `${plural(table.grid.length, "row")}, ${plural(width, "column")}` +
    (sourceFormat === "xlsx" ? ` from worksheet "${table.sheetName}"` : "") +
    (otherSheets
      ? ` (the workbook has ${table.sheetNames.length} worksheets; only this one was converted)`
      : "");

  if (target === "pdf") {
    // Drawing runs on the request thread, so the work is bounded before it
    // starts: the same character budget as one authored text file. The page
    // count is checked again on the result, against the PDF page ceiling.
    const characters = table.grid.reduce(
      (total, row) => total + row.reduce((sum, cell) => sum + cell.length, 0),
      0
    );
    if (characters > ARTIFACT_LIMITS.maxTextFileCharacters) {
      throw new FileConversionError(
        "TOO_MANY_PAGES",
        `The sheet holds ${characters} characters; a PDF table holds at most ` +
          `${ARTIFACT_LIMITS.maxTextFileCharacters}. Offer xlsx or csv instead.`
      );
    }
    const numberColumns = firstRow
      .map((_, index) => index)
      .filter(
        (index) =>
          rows.some((row) => row[index] !== null) &&
          rows.every((row) => row[index] === null || typeof row[index] === "number")
      );
    const admission = admitDocumentSpec({
      filename: spec.filename,
      format: "pdf",
      ...(sourceFormat === "xlsx" ? { title: table.sheetName } : {}),
      blocks: [
        {
          type: "table",
          // Stand-ins, for the reason the workbook path uses them: the
          // authoring rules for a column heading (300 characters) are not the
          // rules for a converted first row, which is the user's data and may
          // hold a cell as long as any other. The real row goes back below.
          columns: firstRow.map(() => ""),
          rows,
          ...(numberColumns.length ? { pdfNumberColumns: numberColumns } : {}),
        },
      ],
    });
    if (!admission.ok) {
      throw new FileConversionError("SPREADSHEET_UNREADABLE", admission.detail);
    }
    const tableBlock = admission.spec.blocks[0];
    if (tableBlock.type === "table") {
      // Checked by the reader already: no cell, first row included, is longer
      // than ARTIFACT_LIMITS.maxTextLength.
      tableBlock.columns = [...firstRow];
    }
    return {
      format: "pdf",
      render: async () => {
        const bytes = assertOutputSize(
          renderDocumentPdf(admission.spec),
          "Offer xlsx or csv instead."
        );
        const pages = (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount();
        if (pages > FILE_CONVERSION_LIMITS.maxPdfPages) {
          throw new FileConversionError(
            "TOO_MANY_PAGES",
            `The table would be ${pages} pages; a PDF holds at most ` +
              `${FILE_CONVERSION_LIMITS.maxPdfPages}. Offer xlsx or csv instead.`
          );
        }
        return { bytes, parts: `${parts}, ${plural(pages, "page")}` };
      },
    };
  }

  // Admitted with stand-in headers, because the authoring schema requires a
  // header to have text and a converted first row may not; every other rule
  // (worksheet name, cell count, cell length) is the authoring one. The real
  // first row is put back before anything is written, and the header styling
  // is left off: the source did not say its first row was a header.
  const admission = admitWorkbookSpecSafely({
    filename: spec.filename,
    format: target,
    styleHeader: false,
    worksheets: [
      {
        name: worksheetName(table.sheetName),
        columns: firstRow.map((_, index) => ({ header: `c${index + 1}` })),
        rows,
        freezeHeader: false,
      },
    ],
  });
  if (!admission.ok) {
    throw new FileConversionError("SPREADSHEET_UNREADABLE", admission.detail);
  }
  // The stand-ins were admitted so the authoring rule "a header has text"
  // does not refuse a blank first-row cell. Every other rule a header has is
  // checked on the real values here, before they are written: a string, no
  // longer than a cell may be. The writer escapes header text the same way
  // it escapes cells, and a blank header writes an empty cell.
  for (const header of firstRow) {
    if (typeof header !== "string" || header.length > ARTIFACT_LIMITS.maxTextLength) {
      throw new FileConversionError(
        "SPREADSHEET_UNREADABLE",
        `A first-row cell holds more than ${ARTIFACT_LIMITS.maxTextLength} characters.`
      );
    }
  }
  admission.spec.worksheets[0].columns.forEach((column, index) => {
    column.header = firstRow[index];
  });
  return {
    format: target,
    render: async () => ({
      bytes: assertOutputSize(
        renderWorkbook(admission.spec, admission.spec.format).bytes,
        "Offer a smaller range of rows."
      ),
      parts,
    }),
  };
};

/* ------------------------------------------------------------------------ */
/* Entry point                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Checks a conversion against the turn's own files and says what it will make.
 *
 * Throws `FileConversionError` for everything that is the request's fault or
 * the file's -- a handle that is not on the turn, a photograph offered as a
 * PDF, page 9 of a six-page file, a password-protected PDF. Nothing has been
 * written when it throws.
 */
export const prepareFileConversion = async (
  spec: FileConversionSpec,
  attachments: ReadonlyMap<string, ConversionAttachment>,
  options: FileConversionOptions = {}
): Promise<PreparedConversion> => {
  const render =
    options.renderOffice === undefined ? defaultOfficeRender() : options.renderOffice;
  const sources = resolveSources(spec, attachments, render !== null);
  switch (spec.operation) {
    case "to_pdf":
      return prepareToPdf(spec, sources, render);
    case "split_pdf":
      return prepareSplitPdf(spec, sources);
    case "pdf_to_images":
      return preparePdfToImages(spec, sources);
    case "convert_images":
      return prepareConvertImages(spec, sources);
    case "convert_spreadsheet":
      return prepareConvertSpreadsheet(spec, sources);
  }
};

/**
 * One page of an attached PDF, drawn as a PNG.
 *
 * For a document's image block (lib/documentImages.ts): a figure on a page of
 * a PDF the user attached. The same reading, page check and drawing the
 * conversions use, so a page that does not exist or a password-protected file
 * is refused the same way.
 */
export const renderAttachmentPdfPage = async (
  handle: string,
  file: ConversionAttachment,
  pageNumber: number,
  dpi: number
): Promise<Uint8Array> => {
  const source: ResolvedSource = {
    handle,
    name: file.name,
    mediaType: file.mediaType,
    kind: "pdf",
    bytes: file.bytes,
    pages: String(pageNumber),
    rotate: 0,
  };
  const document = await loadPdf(source);
  const [index] = selectPages(source, document.getPageCount(), 1);
  const [png] = await rasterizePdfPages(source, [index], dpi);
  return png;
};
