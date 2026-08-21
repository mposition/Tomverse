/**
 * Which generator builds which format, and the ceiling all of them share.
 *
 * Policy: docs/policy/generated-artifacts.md section 4.
 *
 * The format adapter seam. Adding a format is: a row in
 * `lib/generatedArtifactFormats.ts`, a branch here, and a migration widening
 * the `format` CHECK. Nothing else in the domain -- not the tool wiring, not
 * the collector, not storage, not the download route, not the card -- has a
 * per-format branch in it, which is the property this file exists to keep.
 */

import "server-only";

import {
  ARTIFACT_LIMITS,
  requireArtifactFormat,
  type ArchiveSpec,
  type DocumentSpec,
  type PresentationSpec,
  type SupportedArtifactFormat,
  type TextFileSpec,
  type WorkbookSpec,
} from "@/lib/generatedArtifactCore";
import { renderDocumentDocx } from "@/lib/generatedArtifactDocx";
import { renderDocumentPdf } from "@/lib/generatedArtifactPdf";
import { renderPresentationPptx } from "@/lib/generatedArtifactPptx";
import {
  renderArchive,
  renderDocumentMarkdown,
  renderDocumentText,
  renderTextFile,
} from "@/lib/generatedArtifactText";
import { renderWorkbook } from "@/lib/generatedArtifactXlsx";

export class ArtifactRenderError extends Error {
  constructor(
    readonly code: "OUTPUT_TOO_LARGE" | "GENERATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "ArtifactRenderError";
  }
}

export type RenderedArtifact = {
  format: SupportedArtifactFormat;
  mediaType: string;
  bytes: Uint8Array;
};

const encoder = new TextEncoder();

/**
 * Enforces the output ceiling in one place.
 *
 * Every generator routes through here rather than checking for itself, because
 * a generator that forgot would be a generator whose output the download route
 * refuses to stream -- a file that exists and cannot be fetched.
 */
const bounded = (
  format: SupportedArtifactFormat,
  bytes: Uint8Array
): RenderedArtifact => {
  if (bytes.byteLength <= 0) {
    throw new ArtifactRenderError(
      "GENERATION_FAILED",
      "The generator produced an empty file."
    );
  }
  if (bytes.byteLength > ARTIFACT_LIMITS.maxOutputBytes) {
    throw new ArtifactRenderError(
      "OUTPUT_TOO_LARGE",
      `Generated ${bytes.byteLength} bytes, over the ` +
        `${ARTIFACT_LIMITS.maxOutputBytes} byte limit.`
    );
  }
  return { format, mediaType: requireArtifactFormat(format).mediaType, bytes };
};

export const renderSpreadsheetArtifact = (spec: WorkbookSpec): RenderedArtifact =>
  bounded(spec.format, renderWorkbook(spec, spec.format).bytes);

export const renderDocumentArtifact = (spec: DocumentSpec): RenderedArtifact => {
  switch (spec.format) {
    case "docx":
      return bounded(spec.format, renderDocumentDocx(spec));
    case "pdf":
      return bounded(spec.format, renderDocumentPdf(spec));
    case "md":
      return bounded(spec.format, encoder.encode(renderDocumentMarkdown(spec)));
    case "txt":
      return bounded(spec.format, encoder.encode(renderDocumentText(spec)));
    default:
      throw new ArtifactRenderError(
        "GENERATION_FAILED",
        `No document generator for "${spec.format}".`
      );
  }
};

export const renderPresentationArtifact = (
  spec: PresentationSpec
): RenderedArtifact => bounded(spec.format, renderPresentationPptx(spec));

export const renderTextArtifact = (spec: TextFileSpec): RenderedArtifact =>
  bounded(spec.format, renderTextFile(spec));

export const renderArchiveArtifact = (spec: ArchiveSpec): RenderedArtifact =>
  bounded(spec.format, renderArchive(spec));
