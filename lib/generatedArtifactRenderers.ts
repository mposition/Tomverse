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
  isArchiveDocumentEntry,
  requireArtifactFormat,
  type ArchiveSpec,
  type ArtifactArchiveDocumentEntry,
  type DocumentBatchSpec,
  type DocumentSpec,
  type PresentationSpec,
  type SupportedArtifactFormat,
  type TextFileSpec,
  type WorkbookSpec,
} from "@/lib/generatedArtifactCore";
import {
  DocxBatchError,
  buildDocxBatchEntries,
} from "@/lib/generatedArtifactDocxBatch";
import { renderDocumentDocx } from "@/lib/generatedArtifactDocx";
import { renderDocumentPdf } from "@/lib/generatedArtifactPdf";
import { renderPresentationPptx } from "@/lib/generatedArtifactPptx";
import {
  archiveTextEntryBytes,
  renderDocumentMarkdown,
  renderDocumentText,
  renderTextFile,
  zipArchiveEntries,
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

/**
 * One archive entry the server renders rather than the model authoring.
 *
 * Reuses the same four document writers a top-level document uses, so a `.docx`
 * inside a zip and a `.docx` on its own are the same file made the same way.
 */
const renderArchiveDocumentEntry = (
  entry: ArtifactArchiveDocumentEntry
): Uint8Array => {
  const spec: DocumentSpec = {
    // The entry's path is its name inside the archive; the writers take a
    // filename only to put it in document properties, and the path is the
    // honest answer to what this document is called.
    filename: entry.path,
    format: entry.documentFormat,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.subtitle !== undefined ? { subtitle: entry.subtitle } : {}),
    blocks: entry.blocks,
  };
  return renderDocumentArtifact(spec).bytes;
};

export const renderArchiveArtifact = (spec: ArchiveSpec): RenderedArtifact =>
  bounded(
    spec.format,
    zipArchiveEntries(
      spec.entries.map((entry) =>
        isArchiveDocumentEntry(entry)
          ? { path: entry.path, bytes: renderArchiveDocumentEntry(entry) }
          : { path: entry.path, bytes: archiveTextEntryBytes(entry) }
      )
    )
  );

/** What the batch renderer needs that the specification cannot carry. */
export type DocumentBatchInputs = {
  templateBytes: Uint8Array;
  dataBytes: Uint8Array;
  dataMediaType: string;
  now?: Date;
};

/**
 * The template batch: one archive, one document per data row.
 *
 * The bytes come from the turn's own attachments, resolved and
 * ownership-checked by the request layer before they reach here. Nothing in
 * `spec` is a path, a key or a URL -- it is two handles and a naming rule.
 */
export const renderDocumentBatchArtifact = (
  spec: DocumentBatchSpec,
  inputs: DocumentBatchInputs
): RenderedArtifact & { entryCount: number; sheetName: string } => {
  let built;
  try {
    built = buildDocxBatchEntries({
      templateBytes: inputs.templateBytes,
      dataBytes: inputs.dataBytes,
      dataMediaType: inputs.dataMediaType,
      ...(spec.sheet !== undefined ? { sheet: spec.sheet } : {}),
      filenameTemplate: spec.filenameTemplate,
      ...(spec.requiredPlaceholders
        ? { requiredPlaceholders: spec.requiredPlaceholders }
        : {}),
      ...(inputs.now ? { now: inputs.now } : {}),
    });
  } catch (error) {
    if (error instanceof DocxBatchError) {
      // Reported as a rendering failure with the batch's own message: the
      // model is told which row and which placeholder, because that is the
      // part it can put right on a second attempt.
      throw new ArtifactRenderError("GENERATION_FAILED", error.message);
    }
    throw error;
  }

  const rendered = bounded(spec.format, zipArchiveEntries(built.entries));
  return {
    ...rendered,
    entryCount: built.entries.length,
    sheetName: built.sheetName,
  };
};
