/**
 * The five artifact tools, and the per-turn collector behind them.
 *
 * Policy: docs/policy/generated-artifacts.md sections 3, 4 and 8.
 *
 * One tool per *kind*, not per format. A spreadsheet, a document, a deck, a
 * text file and an archive are five genuinely different things to describe;
 * xlsx and csv are one thing written two ways. So the format is a field on the
 * specification and the tool is chosen by what the model is making -- which is
 * also why adding a format costs a row in `lib/generatedArtifactFormats.ts`
 * and nothing here.
 *
 * Each tool's contract with the model is narrow on purpose: it accepts a
 * *specification* and returns a short report. It never returns bytes, a URL,
 * an object key or the artifact's own id -- everything a model is handed can
 * end up quoted in the answer, and a model that could quote a download link
 * could also invent one.
 *
 * The collector is what makes a tool call survivable. A chat turn can end four
 * ways after a tool has already run (finished, cancelled, failed over to
 * another model, or died mid-stream), and only the first of them writes a
 * message row for the artifact to hang from. So the collector holds what was
 * stored, the route persists it in the message transaction, and every other
 * ending calls `discard()`.
 */

import "server-only";

import { createHash } from "node:crypto";
import { tool } from "ai";
import type { ToolSet } from "ai";

import {
  ARTIFACT_LIMITS,
  admitArchiveSpec,
  admitDocumentBatchSpec,
  admitDocumentSpec,
  admitPresentationSpec,
  admitTextFileSpec,
  admitWorkbookSpecSafely,
  archiveSpecSchema,
  artifactFormat,
  documentBatchSpecSchema,
  documentSpecSchema,
  presentationSpecSchema,
  requireArtifactFormat,
  sanitizeArtifactFilename,
  textFileSpecSchema,
  workbookSpecSchema,
  type ArtifactAdmission,
  type ArtifactFailureCode,
  type ArchiveSpec,
  type ArtifactKind,
  type ChatStreamArtifact,
  type DocumentBatchSpec,
  type DocumentSpec,
  type PresentationSpec,
  type SupportedArtifactFormat,
  type TextFileSpec,
  type WorkbookSpec,
} from "@/lib/generatedArtifactCore";
import {
  ArtifactRenderError,
  renderArchiveArtifact,
  renderDocumentArtifact,
  renderDocumentBatchArtifact,
  renderPresentationArtifact,
  renderSpreadsheetArtifact,
  renderTextArtifact,
  type RenderedArtifact,
} from "@/lib/generatedArtifactRenderers";
import { ArtifactGenerationError } from "@/lib/generatedArtifactXlsx";
import { PdfGenerationError } from "@/lib/generatedArtifactPdf";
import { TextContentError } from "@/lib/generatedArtifactText";
import {
  discardStoredArtifacts,
  putArtifactObject,
  type StoredArtifact,
} from "@/lib/generatedArtifactStorage";
import type { ArtifactToolMode } from "@/lib/generatedArtifactToolPolicy";

/**
 * The tool name for each kind.
 *
 * Named for what the user asked for rather than for the format, so the model
 * picking a tool is making the same decision the user already made. A model
 * that wants a `.py` file reaches for `create_text_file` with
 * `format: "py"` -- there is no `create_python_file`, and there is no format
 * whose support depends on a tool existing for it.
 */
export const ARTIFACT_TOOL_NAMES = {
  spreadsheet: "create_spreadsheet",
  document: "create_document",
  presentation: "create_presentation",
  text: "create_text_file",
  archive: "create_archive",
} as const satisfies Record<ArtifactKind, string>;

export const CREATE_SPREADSHEET_TOOL_NAME = ARTIFACT_TOOL_NAMES.spreadsheet;

/**
 * The batch tool, which is not one of the five.
 *
 * It is not keyed by kind because it is not a sixth kind of file: it produces
 * an `archive`, exactly like `create_archive`, from inputs the model does not
 * author. Registered only on a turn that actually carries a Word template, so
 * its schema is not priced into every request and a model with nothing to fill
 * cannot reach for it.
 */
export const CREATE_DOCUMENT_BATCH_TOOL_NAME = "create_document_batch";

export const ALL_ARTIFACT_TOOL_NAMES: readonly string[] = [
  ...Object.values(ARTIFACT_TOOL_NAMES),
  CREATE_DOCUMENT_BATCH_TOOL_NAME,
];

/**
 * Steps one turn may take when the tools are registered.
 *
 * Four, not two: one for the tool call, one for the answer that follows it,
 * and two of slack for a model that makes a second file (a report and the
 * spreadsheet behind it is an ordinary request, and it is two calls).
 * `maxArtifactsPerMessage` is the real ceiling on how much work that slack can
 * buy -- the step budget only bounds the round trips.
 */
export const GENERATED_ARTIFACT_MAX_STEPS = 4;

/** What a failed call is labelled with when the format never got decided. */
const FALLBACK_FORMAT = {
  spreadsheet: "xlsx",
  document: "docx",
  presentation: "pptx",
  text: "txt",
  archive: "zip",
} as const satisfies Record<ArtifactKind, string>;

/** The template a batch fills. Word only -- there is no other template shape. */
const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** What a batch may read records from: a workbook, or a plain CSV. */
const BATCH_DATA_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
]);

type FailedArtifact = {
  ordinal: number;
  format: SupportedArtifactFormat;
  filename: string;
  mediaType: string;
  failureCode: ArtifactFailureCode;
  modelId: string | null;
};

export type ArtifactToolReport =
  | {
      status: "created";
      filename: string;
      format: SupportedArtifactFormat;
      /** Human-readable size of the work, e.g. "2 worksheets, 40 rows". */
      parts: string;
      /** Restates the delivery rule at the moment the model is most likely to break it. */
      note: string;
    }
  | { status: "unchanged"; filename: string; note: string }
  | { status: "sign_in_required"; note: string }
  | { status: "failed"; reason: string; note: string };

/**
 * Every specification any tool can admit.
 *
 * A union rather than a generic, because the point of the table below is that
 * `run()` never learns which member it has: it admits, renders, describes and
 * stores through the same four calls whatever the model asked for.
 */
type ArtifactSpec =
  | WorkbookSpec
  | DocumentSpec
  | PresentationSpec
  | TextFileSpec
  | ArchiveSpec;

/**
 * Everything one kind needs, so `run()` has no per-kind branch in it.
 *
 * `admit` re-checks the input the provider already saw a schema for, `render`
 * turns an admitted specification into bytes, and `describe` says how much was
 * in it. Adding a kind is adding a row; the lifecycle around it -- idempotency,
 * ordinals, storage, failure recording, logging -- is written once.
 */
type KindHandler = {
  admit(input: unknown): ArtifactAdmission<ArtifactSpec>;
  render(spec: ArtifactSpec): RenderedArtifact;
  describe(spec: ArtifactSpec): string;
  /** What the provider is told the tool is for. */
  description: string;
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

const HANDLERS: Record<ArtifactKind, KindHandler> = {
  spreadsheet: {
    admit: admitWorkbookSpecSafely,
    render: renderSpreadsheetArtifact,
    describe: (spec: WorkbookSpec) =>
      `${plural(spec.worksheets.length, "worksheet")}, ` +
      plural(
        spec.worksheets.reduce((total, sheet) => total + sheet.rows.length, 0),
        "row"
      ),
    description:
      "Create a real, downloadable spreadsheet file (.xlsx or .csv) from " +
      "structured data and attach it to your reply. Use this whenever the " +
      "user asks for a spreadsheet, an Excel file, a .xlsx or a CSV. You " +
      "supply the data; the application writes the file. Never write file " +
      "bytes, base64 or a download link yourself.",
  },
  document: {
    admit: admitDocumentSpec,
    render: renderDocumentArtifact,
    describe: (spec: DocumentSpec) => plural(spec.blocks.length, "block"),
    description:
      "Create a real, downloadable document (.docx, .pdf, .md or .txt) and " +
      "attach it to your reply. Use this for reports, letters, summaries, " +
      "proposals and any prose document the user wants as a file. You supply " +
      "the content as a flow of blocks (headings, paragraphs, lists, tables, " +
      "quotes, code); the application writes the file. Never write file " +
      "bytes, base64 or a download link yourself.",
  },
  presentation: {
    admit: admitPresentationSpec,
    render: renderPresentationArtifact,
    describe: (spec: PresentationSpec) => plural(spec.slides.length, "slide"),
    description:
      "Create a real, downloadable PowerPoint deck (.pptx) and attach it to " +
      "your reply. Use this whenever the user asks for slides, a deck or a " +
      "presentation. You supply the slides; the application writes the file. " +
      "Never write file bytes, base64 or a download link yourself.",
  },
  text: {
    admit: admitTextFileSpec,
    render: renderTextArtifact,
    describe: (spec: TextFileSpec) =>
      plural(spec.content.split("\n").length, "line"),
    description:
      "Create a real, downloadable text file and attach it to your reply. " +
      "This covers source code and structured text: json, yaml, xml, sql, " +
      "html, svg, css, and language files such as py, ts, tsx, js, go, rs, " +
      "java, sh and many more. You author the file's exact text; the " +
      "application stores it and gives the user a download. Use this instead " +
      "of a long code block whenever the user asks for a file. Never write " +
      "base64 or a download link yourself.",
  },
  archive: {
    admit: admitArchiveSpec,
    render: renderArchiveArtifact,
    describe: (spec: ArchiveSpec) => plural(spec.entries.length, "entry"),
    description:
      "Create a real, downloadable .zip archive of several files and attach " +
      "it to your reply. Use this whenever the user asks for more than one " +
      "file -- a project, a starter, a set of reports. Each entry is either " +
      "an authored text file (`path`, `format`, `content`) or a document the " +
      "application renders for you (`path`, `documentFormat` such as docx or " +
      "pdf, and `blocks`). One archive may hold up to " +
      `${ARTIFACT_LIMITS.maxArchiveEntries} entries and counts as ONE of the ` +
      `${ARTIFACT_LIMITS.maxArtifactsPerMessage} files an answer may attach, ` +
      "so this is how you deliver ten documents at once. Never write file " +
      "bytes, base64 or a download link yourself.",
  },
};

/**
 * Which failure the user's card should name.
 *
 * The distinction that earns its keep is "too big" against "broken": one has
 * an obvious next request (a smaller file) and the other does not, and the
 * card's copy differs accordingly.
 */
const renderFailureCode = (error: unknown): ArtifactFailureCode => {
  if (error instanceof ArtifactRenderError) {
    return error.code === "OUTPUT_TOO_LARGE" ? "limit_exceeded" : "generation_failed";
  }
  if (error instanceof ArtifactGenerationError) {
    return error.code === "OUTPUT_TOO_LARGE" ? "limit_exceeded" : "generation_failed";
  }
  // A model wrote malformed JSON, YAML or XML. Rejected content, not a broken
  // generator -- and the model can fix it on a second attempt.
  if (error instanceof TextContentError) return "spec_rejected";
  if (error instanceof PdfGenerationError) return "generation_failed";
  return "generation_failed";
};

export type GeneratedArtifactCollectorOptions = {
  mode: ArtifactToolMode;
  userId: string | null;
  conversationId: string | null;
  /** Reported per artifact so a comparison turn attributes each file correctly. */
  modelId: string;
  traceId: string;
  /**
   * Announces that generation has started, as an out-of-band stream chunk.
   *
   * Optional because the collector is also driven directly by tests and by
   * the guest path, neither of which has a stream controller. Called once per
   * accepted specification, before any work, so the status is shown while it
   * is still true.
   */
  emitProgress?: (format: SupportedArtifactFormat) => void;
  /**
   * The files the user attached to the turn being answered, by opaque handle.
   *
   * Resolved and ownership-checked by the request layer before the collector
   * exists, which is the only reason the batch tool can be synchronous and the
   * only reason a handle is safe to give a model: it addresses this map and
   * nothing else. Empty on a turn with no attachments, which is almost all of
   * them.
   */
  turnAttachments?: ReadonlyMap<
    string,
    { name: string; mediaType: string; bytes: Uint8Array }
  >;
  /** Injectable so a test can assert the date folder in a batch path. */
  now?: Date;
};

/**
 * Everything one turn's tool calls produced.
 *
 * `modelId` is mutable because a hard fallback replaces the model mid-turn:
 * the file was produced by whichever model actually called the tool, and
 * attributing it to the one the request was addressed to would put another
 * model's name on another model's work.
 */
export class GeneratedArtifactCollector {
  private readonly seenSpecHashes = new Map<string, StoredArtifact | FailedArtifact>();
  private readonly storedArtifacts: StoredArtifact[] = [];
  private readonly failedArtifacts: FailedArtifact[] = [];
  private nextOrdinal = 0;
  private invocations = 0;
  private modelId: string;

  constructor(private readonly options: GeneratedArtifactCollectorOptions) {
    this.modelId = options.modelId;
  }

  /** Called when a fallback swapped the model that is answering. */
  setModelId(modelId: string) {
    this.modelId = modelId;
  }

  get stored(): StoredArtifact[] {
    return this.storedArtifacts;
  }

  get failed(): FailedArtifact[] {
    return this.failedArtifacts;
  }

  get isEmpty(): boolean {
    return this.storedArtifacts.length === 0 && this.failedArtifacts.length === 0;
  }

  /**
   * Whether the model called a tool at all, however that call ended.
   *
   * Distinct from `isEmpty`, and the distinction matters exactly once: a call
   * this collector refused without recording anything (no conversation to
   * attach to, one file too many) still put a tool call and a tool result into
   * the provider's response messages. The route reads this to decide whether
   * those messages are safe to store for replay -- see
   * `serializeProviderResponseMessages`.
   */
  get wasInvoked(): boolean {
    return this.invocations > 0;
  }

  /**
   * What the client is told.
   *
   * Built from the collector rather than from the database, because a guest
   * turn and a failed turn have no rows and still have something to say. Every
   * field here is in the `ChatStreamArtifact` allowlist; nothing else can get
   * out through this method.
   */
  toStreamArtifacts(): ChatStreamArtifact[] {
    return [
      ...this.storedArtifacts.map(
        (artifact): ChatStreamArtifact => ({
          id: artifact.id,
          ordinal: artifact.ordinal,
          format: artifact.format,
          filename: artifact.filename,
          mediaType: artifact.mediaType,
          byteSize: artifact.byteSize,
          status: "ready",
          ...(artifact.modelId ? { modelId: artifact.modelId } : {}),
        })
      ),
      ...this.failedArtifacts.map(
        (artifact): ChatStreamArtifact => ({
          // A failed artifact has no row while the turn is still streaming, so
          // the id is synthetic and names the position rather than a record.
          // The card it draws has no download button, so there is nothing for
          // an id to address.
          id: `pending:${artifact.ordinal}`,
          ordinal: artifact.ordinal,
          format: artifact.format,
          filename: artifact.filename,
          mediaType: artifact.mediaType,
          byteSize: 0,
          status:
            artifact.failureCode === "sign_in_required" ? "blocked" : "failed",
          failureCode: artifact.failureCode,
          ...(artifact.modelId ? { modelId: artifact.modelId } : {}),
        })
      ),
    ].sort((left, right) => left.ordinal - right.ordinal);
  }

  /**
   * The same list, re-pointed at the rows that were just written.
   *
   * A failed artifact gets a real id once its row exists, so the card the user
   * sees after a reload and the card they saw while it streamed are the same
   * card. Matching is by ordinal, which is exactly what the unique index is
   * on.
   */
  withPersistedIds(rows: Array<{ id: string; ordinal: number }>): ChatStreamArtifact[] {
    const byOrdinal = new Map(rows.map((row) => [row.ordinal, row.id]));
    return this.toStreamArtifacts().map((artifact) => {
      const persisted = byOrdinal.get(artifact.ordinal);
      return persisted ? { ...artifact, id: persisted } : artifact;
    });
  }

  /** Reclaims the objects this turn stored. Used by every non-persisting exit. */
  async discard(): Promise<void> {
    if (this.storedArtifacts.length === 0) return;
    const toDiscard = this.storedArtifacts.splice(0, this.storedArtifacts.length);
    this.seenSpecHashes.clear();
    await discardStoredArtifacts(toDiscard);
  }

  private recordFailure(
    filename: string,
    format: SupportedArtifactFormat,
    failureCode: ArtifactFailureCode,
    specHash: string | null
  ): FailedArtifact {
    const entry: FailedArtifact = {
      ordinal: this.nextOrdinal,
      format,
      filename,
      mediaType: requireArtifactFormat(format).mediaType,
      failureCode,
      modelId: this.modelId,
    };
    this.nextOrdinal += 1;
    this.failedArtifacts.push(entry);
    if (specHash) this.seenSpecHashes.set(specHash, entry);
    return entry;
  }

  /**
   * The format a *rejected* call should be labelled with.
   *
   * Read back off the raw input when it named one this kind actually has, so a
   * failed `.pdf` request draws a PDF card rather than a Word one. A rejected
   * specification is untrusted by definition, hence the membership check
   * rather than a cast.
   */
  private failureFormat(kind: ArtifactKind, rawInput: unknown): SupportedArtifactFormat {
    const requested =
      rawInput && typeof rawInput === "object"
        ? (rawInput as Record<string, unknown>).format
        : undefined;
    if (typeof requested === "string") {
      const descriptor = artifactFormat(requested);
      if (descriptor && descriptor.kind === kind) return requested;
    }
    return FALLBACK_FORMAT[kind];
  }

  /**
   * One tool call, whichever tool it was.
   *
   * Idempotent on the specification, not on the call: a provider that replays
   * an identical tool call (a retried step, a duplicated stream frame) gets
   * `unchanged` and the turn keeps one file. A *different* specification is a
   * different file even if the model asked for the same name -- that is the
   * "edit produces a new version" rule (policy section 9), and it is why the
   * key is the content and not the name.
   */
  async run(kind: ArtifactKind, rawInput: unknown): Promise<ArtifactToolReport> {
    this.invocations += 1;
    const handler = HANDLERS[kind];

    if (this.options.mode === "sign_in_required") {
      const format = this.failureFormat(kind, rawInput);
      const requestedName =
        rawInput && typeof rawInput === "object"
          ? (rawInput as Record<string, unknown>).filename
          : undefined;
      const filename = sanitizeArtifactFilename(
        typeof requestedName === "string" ? requestedName : "generated",
        format
      );
      this.recordFailure(filename, format, "sign_in_required", null);
      return {
        status: "sign_in_required",
        note:
          "File generation requires a signed-in account. Tell the user that, " +
          "briefly. Do not write the contents as a table, as code, or as a link.",
      };
    }

    if (!this.options.userId || !this.options.conversationId) {
      // Nothing to attach the file to. Reported rather than thrown so the turn
      // still produces an answer.
      return {
        status: "failed",
        reason: "no_conversation",
        note: "The file could not be attached to this conversation. Say so.",
      };
    }

    if (
      this.storedArtifacts.length + this.failedArtifacts.length >=
      ARTIFACT_LIMITS.maxArtifactsPerMessage
    ) {
      return {
        status: "failed",
        reason: "too_many_files",
        note:
          `This answer already has ${ARTIFACT_LIMITS.maxArtifactsPerMessage} ` +
          "top-level files, which is the limit. It is not a limit on how many " +
          "documents you can deliver: put them in one archive instead, which " +
          `holds up to ${ARTIFACT_LIMITS.maxArchiveEntries} files.`,
      };
    }

    const admission = handler.admit(rawInput);
    if (!admission.ok) {
      const format = this.failureFormat(kind, rawInput);
      this.recordFailure(
        sanitizeArtifactFilename("generated", format),
        format,
        admission.code === "TOO_MANY_CELLS" ||
          admission.code === "ARCHIVE_TOO_LARGE" ||
          admission.code === "OUTPUT_TOO_LARGE"
          ? "limit_exceeded"
          : "spec_rejected",
        null
      );
      return {
        status: "failed",
        reason: admission.detail.slice(0, 300),
        note:
          "The file was not created. Tell the user what went wrong and offer a " +
          "smaller or corrected version. Do not describe a file that does not exist.",
      };
    }

    const spec = admission.spec;
    const format: SupportedArtifactFormat = spec.format;
    const filename = sanitizeArtifactFilename(spec.filename, format);

    // The hash covers the normalised specification and the resolved name, so
    // two calls that differ only in a character the sanitiser removes are one
    // file rather than two.
    const specHash = createHash("sha256")
      .update(JSON.stringify({ kind, ...spec, filename }))
      .digest("hex");

    const already = this.seenSpecHashes.get(specHash);
    if (already) {
      return {
        status: "unchanged",
        filename: already.filename,
        note:
          "That exact file was already created for this answer. Do not call the " +
          "tool again for it; just describe it.",
      };
    }

    return this.renderAndStore({
      kind,
      format,
      filename,
      specHash,
      render: () => handler.render(spec),
      describe: () => handler.describe(spec),
    });
  }

  /**
   * `create_document_batch`: one archive, one document per spreadsheet row.
   *
   * Shares the whole lifecycle above -- the per-answer ceiling, the ordinal,
   * the idempotency hash, storage, failure recording -- and differs only in
   * where the bytes come from. The model supplies two opaque handles and a
   * naming rule; the files themselves are the user's own, resolved before this
   * collector was constructed.
   */
  async runDocumentBatch(rawInput: unknown): Promise<ArtifactToolReport> {
    this.invocations += 1;

    if (this.options.mode === "sign_in_required") {
      const filename = sanitizeArtifactFilename("documents", "zip");
      this.recordFailure(filename, "zip", "sign_in_required", null);
      return {
        status: "sign_in_required",
        note:
          "File generation requires a signed-in account. Tell the user that, " +
          "briefly. Do not write the contents as a table, as code, or as a link.",
      };
    }
    if (!this.options.userId || !this.options.conversationId) {
      return {
        status: "failed",
        reason: "no_conversation",
        note: "The file could not be attached to this conversation. Say so.",
      };
    }
    if (
      this.storedArtifacts.length + this.failedArtifacts.length >=
      ARTIFACT_LIMITS.maxArtifactsPerMessage
    ) {
      return {
        status: "failed",
        reason: "too_many_files",
        note:
          `This answer already has ${ARTIFACT_LIMITS.maxArtifactsPerMessage} files. ` +
          "That is the limit on top-level files, not on documents: one archive " +
          "can hold up to " +
          `${ARTIFACT_LIMITS.maxArchiveEntries} of them.`,
      };
    }

    const admission = admitDocumentBatchSpec(rawInput);
    if (!admission.ok) {
      this.recordFailure(
        sanitizeArtifactFilename("documents", "zip"),
        "zip",
        "spec_rejected",
        null
      );
      return {
        status: "failed",
        reason: admission.detail.slice(0, 300),
        note:
          "The files were not created. Tell the user what went wrong. Do not " +
          "describe files that do not exist.",
      };
    }

    const spec: DocumentBatchSpec = admission.spec;
    const attachments = this.options.turnAttachments;
    const template = attachments?.get(spec.templateAttachment);
    const data = attachments?.get(spec.dataAttachment);
    const missing = !template
      ? spec.templateAttachment
      : !data
        ? spec.dataAttachment
        : null;
    if (missing || !template || !data) {
      const available = attachments ? Array.from(attachments.keys()) : [];
      this.recordFailure(
        sanitizeArtifactFilename(spec.filename, "zip"),
        "zip",
        "spec_rejected",
        null
      );
      return {
        status: "failed",
        reason: `attachment_not_on_turn:${missing}`,
        note:
          `There is no file called ${missing} on this message. ` +
          (available.length
            ? `The files attached here are: ${available.join(", ")}. `
            : "No files are attached to this message. ") +
          "Ask the user to attach the template and the data, and do not invent a file.",
      };
    }
    if (template.mediaType !== DOCX_MEDIA_TYPE) {
      this.recordFailure(
        sanitizeArtifactFilename(spec.filename, "zip"),
        "zip",
        "spec_rejected",
        null
      );
      return {
        status: "failed",
        reason: "template_not_docx",
        note:
          `${spec.templateAttachment} ("${template.name}") is not a Word document. ` +
          "The template has to be a .docx file. Say so.",
      };
    }
    if (!BATCH_DATA_MEDIA_TYPES.has(data.mediaType)) {
      this.recordFailure(
        sanitizeArtifactFilename(spec.filename, "zip"),
        "zip",
        "spec_rejected",
        null
      );
      return {
        status: "failed",
        reason: "data_not_tabular",
        note:
          `${spec.dataAttachment} ("${data.name}") is not a spreadsheet. ` +
          "The data has to be an .xlsx or a .csv with one row per document. Say so.",
      };
    }

    const filename = sanitizeArtifactFilename(spec.filename, "zip");
    const specHash = createHash("sha256")
      .update(
        JSON.stringify({
          kind: "documentBatch",
          ...spec,
          filename,
          template: template.name,
          data: data.name,
        })
      )
      .digest("hex");
    const already = this.seenSpecHashes.get(specHash);
    if (already) {
      return {
        status: "unchanged",
        filename: already.filename,
        note:
          "That exact archive was already created for this answer. Do not call " +
          "the tool again for it; just describe it.",
      };
    }

    let entryCount = 0;
    let sheetName = "";
    return this.renderAndStore({
      kind: "archive",
      format: "zip",
      filename,
      specHash,
      render: () => {
        const rendered = renderDocumentBatchArtifact(spec, {
          templateBytes: template.bytes,
          dataBytes: data.bytes,
          dataMediaType: data.mediaType,
          ...(this.options.now ? { now: this.options.now } : {}),
        });
        entryCount = rendered.entryCount;
        sheetName = rendered.sheetName;
        return rendered;
      },
      describe: () =>
        `${plural(entryCount, "document")} from "${sheetName}"`,
      createdNote:
        "The archive is attached to your message and the user has a download " +
        "button. Say how many documents it contains and where they came from, " +
        "in one or two sentences. Do not list every file and do not write a link.",
    });
  }

  /**
   * Everything that happens once a specification has been accepted.
   *
   * Shared by the five kind tools and by the batch tool, so the ordering that
   * makes a tool call survivable -- progress signal, render, store bytes, take
   * the ordinal, record the hash -- is written once and cannot drift between
   * them.
   */
  private async renderAndStore(job: {
    kind: ArtifactKind;
    format: SupportedArtifactFormat;
    filename: string;
    specHash: string;
    render: () => RenderedArtifact;
    describe: (rendered: RenderedArtifact) => string;
    createdNote?: string;
  }): Promise<ArtifactToolReport> {
    const { kind, format, filename, specHash } = job;

    // Before the work, not after: a status that appears once the file is
    // finished is a status nobody needed.
    this.options.emitProgress?.(format);

    let rendered: RenderedArtifact;
    try {
      rendered = job.render();
    } catch (error) {
      this.recordFailure(filename, format, renderFailureCode(error), specHash);
      console.error("Generated artifact rendering failed:", {
        traceId: this.options.traceId,
        conversationId: this.options.conversationId,
        kind,
        format,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "failed",
        reason:
          error instanceof Error ? error.message.slice(0, 300) : "generation_failed",
        note:
          "The file was not created. Tell the user, and offer a smaller or " +
          "corrected version. Do not describe a file that does not exist.",
      };
    }

    let storedArtifact: StoredArtifact;
    try {
      storedArtifact = await putArtifactObject({
        userId: this.options.userId!,
        conversationId: this.options.conversationId!,
        ordinal: this.nextOrdinal,
        format,
        filename,
        mediaType: rendered.mediaType,
        bytes: rendered.bytes,
        modelId: this.modelId,
      });
    } catch (error) {
      this.recordFailure(filename, format, "storage_failed", specHash);
      console.error("Generated artifact storage failed:", {
        traceId: this.options.traceId,
        conversationId: this.options.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "failed",
        reason: "storage_failed",
        note:
          "The file could not be saved. Tell the user it failed and offer to try " +
          "again. Do not describe a file that does not exist.",
      };
    }

    this.nextOrdinal += 1;
    this.storedArtifacts.push(storedArtifact);
    this.seenSpecHashes.set(specHash, storedArtifact);

    const parts = job.describe(rendered);
    console.info(
      JSON.stringify({
        event: "generated_artifact_created",
        traceId: this.options.traceId,
        conversationId: this.options.conversationId,
        modelId: this.modelId,
        kind,
        format,
        parts,
        byteSize: storedArtifact.byteSize,
        timestamp: new Date().toISOString(),
      })
    );

    return {
      status: "created",
      filename,
      format,
      parts,
      note:
        job.createdNote ??
        "The file is attached to your message and the user has a download " +
          "button. Do not repeat the table, the CSV text, the code, or a link. " +
          "Write one or two short sentences about what it contains.",
    };
  }
}

/**
 * The tool definitions sent to the provider.
 *
 * `inputSchema` is the same Zod schema the handler's `admit` re-checks inside
 * `execute`, and the duplication is intentional. The schema the provider sees
 * is a hint that a well-behaved model follows; the check inside is what
 * actually decides. Trusting the first would mean trusting that every provider
 * enforces a JSON schema it was handed, which is not a property any of them
 * promises.
 */
/**
 * What the provider is told `create_document_batch` is for.
 *
 * Written to close the exact refusal this feature exists to remove: a model
 * that had been told "at most three files" concluded it could not make ten
 * contracts, and said so. The limit is real and unchanged; what it bounds is
 * top-level attachments, and one archive is one of them.
 */
const DOCUMENT_BATCH_TOOL_DESCRIPTION =
  "Fill an attached Word template once per row of an attached spreadsheet, " +
  "and deliver the finished documents as one .zip. Use this whenever the " +
  "user attaches a .docx template with {{placeholder}} fields and a table of " +
  "people, orders or items and asks for one document per row -- contracts, " +
  "certificates, letters, invoices. You never read or write the files: you " +
  "name them by the handles listed in this turn's attachment section " +
  "(att_1, att_2, ...) and give a naming rule such as " +
  '"{{name}}_contract"; the application reads the spreadsheet, fills the ' +
  "template run by run, keeps the template's styles, tables, headers, " +
  "footers, sections and images, and writes every document. The archive " +
  "counts as ONE attached file, so a hundred documents is one call. Never " +
  "write file bytes, base64, XML, a storage key or a local path yourself, " +
  "and never ask for them: a handle is the whole of what this tool accepts.";

export const buildGeneratedArtifactToolConfig = (
  collector: GeneratedArtifactCollector,
  { registerDocumentBatch = false }: { registerDocumentBatch?: boolean } = {}
): { tools: ToolSet } => ({
  tools: {
    [ARTIFACT_TOOL_NAMES.spreadsheet]: tool({
      description: HANDLERS.spreadsheet.description,
      inputSchema: workbookSpecSchema,
      execute: async (input) => collector.run("spreadsheet", input),
    }),
    [ARTIFACT_TOOL_NAMES.document]: tool({
      description: HANDLERS.document.description,
      inputSchema: documentSpecSchema,
      execute: async (input) => collector.run("document", input),
    }),
    [ARTIFACT_TOOL_NAMES.presentation]: tool({
      description: HANDLERS.presentation.description,
      inputSchema: presentationSpecSchema,
      execute: async (input) => collector.run("presentation", input),
    }),
    [ARTIFACT_TOOL_NAMES.text]: tool({
      description: HANDLERS.text.description,
      inputSchema: textFileSpecSchema,
      execute: async (input) => collector.run("text", input),
    }),
    [ARTIFACT_TOOL_NAMES.archive]: tool({
      description: HANDLERS.archive.description,
      inputSchema: archiveSpecSchema,
      execute: async (input) => collector.run("archive", input),
    }),
    ...(registerDocumentBatch
      ? {
          [CREATE_DOCUMENT_BATCH_TOOL_NAME]: tool({
            description: DOCUMENT_BATCH_TOOL_DESCRIPTION,
            inputSchema: documentBatchSpecSchema,
            execute: async (input) => collector.runDocumentBatch(input),
          }),
        }
      : {}),
  },
});
