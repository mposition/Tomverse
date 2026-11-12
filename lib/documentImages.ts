/**
 * Image blocks, resolved to the pictures they name.
 *
 * Policy: docs/policy/generated-artifacts.md section 16.
 *
 * A document's image block names a file the user attached to this turn and,
 * for a figure, the region of it that holds the picture. This cuts that
 * region out of the user's own bytes -- a photograph, or a page of a PDF drawn
 * by the same engine the conversions use -- and hands the writers a JPEG. The
 * model contributes a handle and four fractions; it writes no pixels.
 */

import "server-only";

import {
  ARTIFACT_LIMITS,
  type DocumentSpec,
  type ResolvedDocumentImage,
  type ResolvedDocumentImages,
} from "@/lib/generatedArtifactCore";
import {
  FILE_CONVERSION_LIMITS,
  FileConversionError,
  conversionSourceKind,
  type ConversionAttachment,
} from "@/lib/fileConversionCore";
import { renderAttachmentPdfPage } from "@/lib/fileConversion";

/** The long edge a placed picture is stored at: sharp in print at A4 width. */
const PLACED_IMAGE_MAX_EDGE = 1600;
/** PDF pages are drawn at this resolution before a figure is cut out. */
const PAGE_DPI = 150;

const describeAttached = (attachments: ReadonlyMap<string, ConversionAttachment>) =>
  attachments.size === 0
    ? "No files are attached to this message."
    : `The files attached to this message are: ${Array.from(attachments)
        .map(([handle, file]) => `${handle} ("${file.name}")`)
        .join(", ")}.`;

/**
 * Every image block of the document, resolved, by block index.
 *
 * Throws `FileConversionError` -- the same refusals the conversions give, so
 * the card the user sees reads the same: a handle not on this turn, a file
 * that is not a picture or a PDF, a page that does not exist.
 */
export const resolveDocumentImages = async (
  spec: DocumentSpec,
  attachments: ReadonlyMap<string, ConversionAttachment>
): Promise<ResolvedDocumentImages> => {
  const resolved = new Map<number, ResolvedDocumentImage>();
  // One drawing per page however many figures are cut from it.
  const pages = new Map<string, Uint8Array>();
  let total = 0;

  for (const [index, block] of spec.blocks.entries()) {
    if (block.type !== "image") continue;
    const file = attachments.get(block.attachment);
    if (!file) {
      throw new FileConversionError(
        "SOURCE_MISSING",
        `There is no file ${block.attachment} on this message. ${describeAttached(attachments)} ` +
          "A picture can only come from a file attached to the message being answered."
      );
    }

    const kind = conversionSourceKind(file.mediaType);
    let source: Uint8Array;
    if (kind === "image") {
      if (block.page !== undefined && block.page !== 1) {
        throw new FileConversionError(
          "PAGES_INVALID",
          `${block.attachment} ("${file.name}") is an image, so it has no page ${block.page}.`
        );
      }
      source = file.bytes;
    } else if (kind === "pdf") {
      const key = `${block.attachment}#${block.page ?? 1}`;
      let page = pages.get(key);
      if (!page) {
        page = await renderAttachmentPdfPage(block.attachment, file, block.page ?? 1, PAGE_DPI);
        pages.set(key, page);
      }
      source = page;
    } else {
      throw new FileConversionError(
        "SOURCE_TYPE",
        `${block.attachment} ("${file.name}") cannot be placed as a picture: it needs an image or a PDF.`
      );
    }

    const sharp = (await import("sharp")).default;
    let oriented: { data: Buffer; info: { width: number; height: number } };
    try {
      // Upright first, so the crop fractions mean what the model saw.
      oriented = await sharp(Buffer.from(source), {
        limitInputPixels: FILE_CONVERSION_LIMITS.maxImagePixels,
        failOn: "error",
      })
        .autoOrient()
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      throw new FileConversionError(
        error instanceof Error && /pixel limit/i.test(error.message)
          ? "OUTPUT_TOO_LARGE"
          : "IMAGE_UNREADABLE",
        `${block.attachment} ("${file.name}") could not be read as a picture.`
      );
    }

    let pipeline = sharp(oriented.data);
    if (block.crop) {
      const { width, height } = oriented.info;
      const left = Math.min(width - 1, Math.floor(block.crop.x * width));
      const top = Math.min(height - 1, Math.floor(block.crop.y * height));
      pipeline = pipeline.extract({
        left,
        top,
        width: Math.max(1, Math.min(width - left, Math.round(block.crop.width * width))),
        height: Math.max(1, Math.min(height - top, Math.round(block.crop.height * height))),
      });
    }
    let encoded: { data: Buffer; info: { width: number; height: number } };
    try {
      encoded = await pipeline
        .resize({
          width: PLACED_IMAGE_MAX_EDGE,
          height: PLACED_IMAGE_MAX_EDGE,
          fit: "inside",
          withoutEnlargement: true,
        })
        // A PDF image object of JPEG is DeviceRGB here: no alpha, three
        // channels, baseline -- what every reader draws.
        .flatten({ background: "#ffffff" })
        .toColourspace("srgb")
        .jpeg({ quality: 82, progressive: false })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new FileConversionError(
        "CONVERSION_FAILED",
        `The picture from ${block.attachment} ("${file.name}") could not be prepared. Offer to try again.`
      );
    }

    total += encoded.data.byteLength;
    if (total > ARTIFACT_LIMITS.maxConvertedOutputBytes) {
      throw new FileConversionError(
        "OUTPUT_TOO_LARGE",
        "The pictures together are over the size a document may be. Offer fewer pictures."
      );
    }
    resolved.set(index, {
      jpeg: new Uint8Array(encoded.data),
      width: encoded.info.width,
      height: encoded.info.height,
    });
  }
  return resolved;
};
