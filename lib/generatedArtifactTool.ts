/**
 * The `create_spreadsheet` tool, and the per-turn collector behind it.
 *
 * Policy: docs/policy/generated-artifacts.md sections 3, 4 and 8.
 *
 * The tool's contract with the model is narrow on purpose: it accepts a
 * workbook *specification* and returns a short report. It never returns bytes,
 * a URL, an object key or the artifact's own id -- everything a model is
 * handed can end up quoted in the answer, and a model that could quote a
 * download link could also invent one.
 *
 * The collector is what makes a tool call survivable. A chat turn can end four
 * ways after the tool has already run (finished, cancelled, failed over to
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
  ARTIFACT_MEDIA_TYPES,
  admitWorkbookSpecSafely,
  sanitizeArtifactFilename,
  workbookSpecSchema,
  type ArtifactFailureCode,
  type ChatStreamArtifact,
  type SupportedArtifactFormat,
} from "@/lib/generatedArtifactCore";
import {
  ArtifactGenerationError,
  renderWorkbook,
} from "@/lib/generatedArtifactXlsx";
import {
  discardStoredArtifacts,
  putArtifactObject,
  type StoredArtifact,
} from "@/lib/generatedArtifactStorage";
import type { ArtifactToolMode } from "@/lib/generatedArtifactToolPolicy";

export const CREATE_SPREADSHEET_TOOL_NAME = "create_spreadsheet";

/**
 * Steps one turn may take when the tool is registered.
 *
 * Three, not two: one for the tool call, one for the answer that follows it,
 * and one of slack for a model that calls the tool a second time for a second
 * sheet. `maxArtifactsPerMessage` is the real ceiling on how much work that
 * slack can buy -- the step budget only bounds the round trips.
 */
export const GENERATED_ARTIFACT_MAX_STEPS = 3;

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
      worksheets: number;
      rows: number;
      /** Restates the delivery rule at the moment the model is most likely to break it. */
      note: string;
    }
  | { status: "unchanged"; filename: string; note: string }
  | { status: "sign_in_required"; note: string }
  | { status: "failed"; reason: string; note: string };

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
   * Whether the model called the tool at all, however that call ended.
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
      mediaType: ARTIFACT_MEDIA_TYPES[format],
      failureCode,
      modelId: this.modelId,
    };
    this.nextOrdinal += 1;
    this.failedArtifacts.push(entry);
    if (specHash) this.seenSpecHashes.set(specHash, entry);
    return entry;
  }

  /**
   * One tool call.
   *
   * Idempotent on the specification, not on the call: a provider that replays
   * an identical tool call (a retried step, a duplicated stream frame) gets
   * `unchanged` and the turn keeps one file. A *different* specification is a
   * different file even if the model asked for the same name -- that is the
   * "edit produces a new version" rule (policy section 9), and it is why the
   * key is the content and not the name.
   */
  async run(rawInput: unknown): Promise<ArtifactToolReport> {
    this.invocations += 1;
    if (this.options.mode === "sign_in_required") {
      const parsed = workbookSpecSchema.safeParse(rawInput);
      const format = parsed.success ? parsed.data.format : "xlsx";
      const filename = sanitizeArtifactFilename(
        parsed.success ? parsed.data.filename : "generated",
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
          `This answer already has ${ARTIFACT_LIMITS.maxArtifactsPerMessage} files. ` +
          "Tell the user, and offer to put the rest in a follow-up message.",
      };
    }

    const admission = admitWorkbookSpecSafely(rawInput);
    if (!admission.ok) {
      const format: SupportedArtifactFormat = "xlsx";
      this.recordFailure(
        "generated.xlsx",
        format,
        admission.code === "TOO_MANY_CELLS" ? "limit_exceeded" : "spec_rejected",
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

    const { spec } = admission;
    const format = spec.format;
    const filename = sanitizeArtifactFilename(spec.filename, format);

    // The hash covers the normalised specification and the resolved name, so
    // two calls that differ only in a character the sanitiser removes are one
    // file rather than two.
    const specHash = createHash("sha256")
      .update(JSON.stringify({ filename, format, worksheets: spec.worksheets }))
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

    // Before the work, not after: a status that appears once the file is
    // finished is a status nobody needed.
    this.options.emitProgress?.(format);

    let bytes: Uint8Array;
    let mediaType: string;
    try {
      const rendered = renderWorkbook(spec, format);
      bytes = rendered.bytes;
      mediaType = rendered.mediaType;
    } catch (error) {
      const limitExceeded =
        error instanceof ArtifactGenerationError &&
        error.code === "OUTPUT_TOO_LARGE";
      this.recordFailure(
        filename,
        format,
        limitExceeded ? "limit_exceeded" : "generation_failed",
        specHash
      );
      console.error("Generated artifact rendering failed:", {
        traceId: this.options.traceId,
        conversationId: this.options.conversationId,
        format,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "failed",
        reason:
          error instanceof ArtifactGenerationError
            ? error.message.slice(0, 300)
            : "generation_failed",
        note:
          "The file was not created. Tell the user, and offer a smaller version. " +
          "Do not describe a file that does not exist.",
      };
    }

    let storedArtifact: StoredArtifact;
    try {
      storedArtifact = await putArtifactObject({
        userId: this.options.userId,
        conversationId: this.options.conversationId,
        ordinal: this.nextOrdinal,
        format,
        filename,
        mediaType,
        bytes,
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

    const rows = spec.worksheets.reduce((total, sheet) => total + sheet.rows.length, 0);
    console.info(
      JSON.stringify({
        event: "generated_artifact_created",
        traceId: this.options.traceId,
        conversationId: this.options.conversationId,
        modelId: this.modelId,
        format,
        worksheets: spec.worksheets.length,
        rows,
        byteSize: storedArtifact.byteSize,
        timestamp: new Date().toISOString(),
      })
    );

    return {
      status: "created",
      filename,
      format,
      worksheets: spec.worksheets.length,
      rows,
      note:
        "The file is attached to your message and the user has a download " +
        "button. Do not repeat the table, the CSV text, the code, or a link. " +
        "Write one or two short sentences about what it contains.",
    };
  }
}

/**
 * The tool definition sent to the provider.
 *
 * `inputSchema` is the same Zod schema `admitWorkbookSpecSafely` re-checks
 * inside `execute`, and the duplication is intentional. The schema the
 * provider sees is a hint that a well-behaved model follows; the check inside
 * is what actually decides. Trusting the first would mean trusting that every
 * provider enforces a JSON schema it was handed, which is not a property any
 * of them promises.
 */
export const buildGeneratedArtifactToolConfig = (
  collector: GeneratedArtifactCollector
): { tools: ToolSet } => ({
  tools: {
    [CREATE_SPREADSHEET_TOOL_NAME]: tool({
      description:
        "Create a real, downloadable spreadsheet file (.xlsx or .csv) from " +
        "structured data and attach it to your reply. Use this whenever the " +
        "user asks for a spreadsheet, an Excel file, a .xlsx, a CSV, or asks " +
        "for data 'as a file'. You supply the data; the application writes the " +
        "file. Never write file bytes, base64 or a download link yourself.",
      inputSchema: workbookSpecSchema,
      execute: async (input) => collector.run(input),
    }),
  },
});
