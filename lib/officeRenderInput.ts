/**
 * What an office document really expands to, measured before the renderer
 * sees it.
 *
 * Policy: docs/policy/generated-artifacts.md section 15.3.
 *
 * The renderer is a shared service: one document that expands to gigabytes
 * takes it down for everyone's conversions. The text readers only inflate the
 * parts they read (an HWPX's sections, not its BinData), so a bomb hidden in
 * a picture would pass them and reach LibreOffice. This inflates *every*
 * compressed part a step at a time (lib/boundedInflate.ts), counts the bytes
 * that come out and drops them, and refuses past the ceiling -- before the
 * file is sent.
 *
 *   * A ZIP-based document (OOXML, ODF, HWPX, iWork): every entry.
 *   * HWP 5.x: every stream, whatever the header says about compression.
 *   * Other compound files (.doc, .xls, .ppt): nothing to inflate; their size
 *     is the upload's.
 */

import "server-only";

import { BoundedInflateError, inflateRawBounded } from "@/lib/boundedInflate";
import {
  ExpansionLimitError,
  createExpansionCounter,
  measurePackage,
} from "@/lib/packageExpansion";
import { createLegacyParseBudget, LegacyOfficeError } from "@/lib/legacyOffice/budget";
import { hasCompoundFileSignature, openCompoundFile, readCompoundStream } from "@/lib/legacyOffice/cfbf";

export const RENDER_INPUT_LIMITS = {
  /** Bytes every compressed part together may really expand to. */
  maxExpandedBytes: 200 * 1024 * 1024,
  maxZipEntries: 20_000,
} as const;

export type RenderInputVerdict = { ok: true } | { ok: false; reason: "EXPANDS_TOO_FAR" | "UNREADABLE" };

const isZip = (bytes: Uint8Array) =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

class Overflow extends Error {}

/**
 * Every entry, and every container compressed inside one -- an embedded
 * workbook, an iWork index, Snappy-compressed .iwa records -- against one
 * running total (lib/packageExpansion.ts).
 */
const measureZip = (bytes: Uint8Array): RenderInputVerdict => {
  let entries = 0;
  try {
    measurePackage(bytes, createExpansionCounter(RENDER_INPUT_LIMITS.maxExpandedBytes), {
      entry: () => {
        entries += 1;
        if (entries > RENDER_INPUT_LIMITS.maxZipEntries) throw new Overflow();
      },
    });
  } catch (error) {
    if (error instanceof Overflow || error instanceof ExpansionLimitError) {
      return { ok: false, reason: "EXPANDS_TOO_FAR" };
    }
    if (error instanceof BoundedInflateError) return { ok: false, reason: "UNREADABLE" };
    throw error;
  }
  return { ok: true };
};

const HWP_SIGNATURE = "HWP Document File";
/**
 * The ways a stream may be compressed: raw DEFLATE, as HWP writes it, and the
 * same behind a zlib header, which a reader may accept as well.
 */
const inflatable = (stream: Uint8Array): Uint8Array[] => {
  const zlib = stream.length > 2 && (stream[0] & 0x0f) === 8 && ((stream[0] << 8) | stream[1]) % 31 === 0;
  return zlib ? [stream, stream.subarray(2)] : [stream];
};

const measureHwp = (bytes: Uint8Array): RenderInputVerdict => {
  // The container is read under a byte budget of its own: a compound file's
  // streams are claimed before they are allocated (lib/legacyOffice/cfbf.ts).
  const budget = createLegacyParseBudget({
    maxBytes: RENDER_INPUT_LIMITS.maxExpandedBytes,
    maxCharacters: 1,
  });
  try {
    const file = openCompoundFile(bytes, budget);
    const header = readCompoundStream(file, "FileHeader");
    if (!header || header.byteLength < 40) return { ok: true };
    if (String.fromCharCode(...header.subarray(0, HWP_SIGNATURE.length)) !== HWP_SIGNATURE) {
      return { ok: true };
    }
    // The header's compression bit is the document's default, not a promise:
    // a BinData item can be compressed on its own in an uncompressed
    // document, and the filter inflates it. So every stream is tried, whatever
    // the header says, and whatever really comes out is counted.
    let expanded = 0;
    const charge = (chunk: Uint8Array) => {
      expanded += chunk.length;
      if (expanded > RENDER_INPUT_LIMITS.maxExpandedBytes) throw new Overflow();
    };
    // Every stream, not one per name: two storages may hold streams of the
    // same name, and the renderer reads both.
    for (const entry of file.allStreams) {
      const stream = file.read(entry);
      for (const candidate of inflatable(stream)) {
        try {
          inflateRawBounded(candidate, charge);
          break;
        } catch (error) {
          if (error instanceof Overflow) throw error;
          // Not DEFLATE (an uncompressed record, a picture): what it is, it
          // is at its upload size. The bytes it did yield stay counted.
        }
      }
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof Overflow) return { ok: false, reason: "EXPANDS_TOO_FAR" };
    if (error instanceof LegacyOfficeError) {
      return error.code === "LEGACY_OFFICE_TOO_LARGE"
        ? { ok: false, reason: "EXPANDS_TOO_FAR" }
        : { ok: false, reason: "UNREADABLE" };
    }
    throw error;
  }
};

/** Whether this document may be sent to the renderer. */
export const measureRenderInput = (mediaType: string, bytes: Uint8Array): RenderInputVerdict => {
  if (isZip(bytes)) return measureZip(bytes);
  if (hasCompoundFileSignature(bytes) && /hwp/i.test(mediaType)) return measureHwp(bytes);
  return { ok: true };
};
