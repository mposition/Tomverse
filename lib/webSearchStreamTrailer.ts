import { parseContinuationReceipt, type ContinuationReceipt } from "./continuationReceipt";
import {
  isChatCompletionStatus,
  type ChatCompletionStatus,
  type ChatIncompleteReason,
} from "@tomverse/chat-core";
import {
  parseChatStreamArtifacts,
  type ChatStreamArtifact,
} from "@/lib/generatedArtifactCore";
import { projectResearchSearchMetadata } from "@/lib/researchPreviewMetadata";

// A provider-executed search tool call only resolves once the whole
// streamText() turn settles (tool-result/source parts only exist in the
// final AI SDK `content` array), so per-turn WebSearchExecution metadata
// can't be known until after the last text token has already streamed to
// the client. Response headers are fixed before any body bytes go out, so
// they can't carry it either. This appends one final out-of-band chunk to
// the same text stream instead of opening a second request -- the only
// delivery path that also reaches guest sessions, whose messages are never
// persisted server-side for a later re-fetch.
//
// The marker starts with a NUL code point (\u0000), which providers do not
// emit in normal completions, so real model output can't collide with it.
const NUL = String.fromCharCode(0);
export const SEARCH_METADATA_TRAILER_MARKER = `${NUL}TOMVERSE_SEARCH_METADATA`;

export function buildSearchMetadataTrailerChunk(execution: unknown): string {
  const projected = execution && typeof execution === "object" && "searchMetadata" in execution
    ? { ...execution, searchMetadata: projectResearchSearchMetadata(execution.searchMetadata) }
    : projectResearchSearchMetadata(execution);
  return `${SEARCH_METADATA_TRAILER_MARKER}${JSON.stringify(projected)}`;
}

/**
 * What the trailer carries, for the same reason the trailer exists: neither
 * the citations nor the finish reason is knowable before the last text token
 * has already streamed.
 */
export type ChatStreamTrailer = {
  searchMetadata: unknown;
  appliedReasoningEffort?: import("@/lib/reasoningEffort").AppliedReasoningEffort;
  continuationReceipt?: ContinuationReceipt;
  completion?: {
    status: ChatCompletionStatus;
    incompleteReason?: ChatIncompleteReason;
  };
  /**
   * The files this turn produced (docs/policy/generated-artifacts.md section 5).
   *
   * Here for the same reason the citations are: a tool result only resolves
   * once the whole turn settles, so it cannot ride in a header, and a guest
   * turn has no persisted message to re-fetch it from. Carries public fields
   * only -- no object key, no storage URL, nothing the provider said.
   *
   * Absent, not empty, when the turn made no file. An older client ignores the
   * key; an older server never sends it and the client shows no cards, which
   * is exactly right for a turn that had none.
   */
  artifacts?: ChatStreamArtifact[];
  fileGenerationRetry?: { modelId: string };
  /**
   * The signed error report token for a turn the server itself judged failed
   * after the 200 stream had started (an empty answer, a stream that broke),
   * and the server's own code for it
   * (docs/policy/trace-feedback-automation.md section 3.3).
   *
   * Here because the response headers were sent before the failure existed.
   * The client keeps it in memory for the one feedback submission it
   * authenticates and nowhere else; it is never part of a stored message.
   * Absent on every turn that completed or that the user stopped.
   */
  errorReport?: { token: string; code: string };
  /**
   * Why a turn the server judged failed ended without text, when it knows
   * something the user can act on. `attachment_rejected`: the provider refused
   * the request the user's own file rode on (lib/chatStreamErrorReport.ts
   * `emptyResponseCause`). Absent otherwise; an older client ignores it.
   */
  failure?: { kind: "attachment_rejected" };
};

const ERROR_REPORT_TOKEN_MAX_LENGTH = 2_048;
const ERROR_REPORT_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,160}$/;

export function buildChatStreamTrailerChunk(trailer: ChatStreamTrailer): string {
  return buildSearchMetadataTrailerChunk(trailer);
}

/**
 * Reads a trailer payload back.
 *
 * Accepts both the envelope above and a bare WebSearchExecution object, which
 * is what the trailer carried before it also had to report completion status.
 * A client can meet an old server (a rolling deploy) or a stored fixture, and
 * a bare payload simply means "no completion information" -- never a wrong
 * status.
 */
export function parseChatStreamTrailer(
  searchMetadataJson: string | null
): ChatStreamTrailer | null {
  if (!searchMetadataJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(searchMetadataJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (
    !("continuationReceipt" in record) &&
    !("searchMetadata" in record) &&
    !("completion" in record) &&
    !("artifacts" in record) &&
    !("fileGenerationRetry" in record) &&
    !("errorReport" in record) &&
    !("failure" in record)
  ) {
    return { searchMetadata: projectResearchSearchMetadata(parsed) };
  }
  const completion = record.completion;
  const completionRecord =
    completion && typeof completion === "object"
      ? (completion as Record<string, unknown>)
      : null;
  const artifacts = parseChatStreamArtifacts(record.artifacts);
  const fileGenerationRetry = record.fileGenerationRetry;
  const retryRecord =
    fileGenerationRetry && typeof fileGenerationRetry === "object"
      ? (fileGenerationRetry as Record<string, unknown>)
      : null;
  const errorReport = record.errorReport;
  const errorReportRecord =
    errorReport && typeof errorReport === "object"
      ? (errorReport as Record<string, unknown>)
      : null;
  return {
    ...(errorReportRecord &&
    typeof errorReportRecord.token === "string" &&
    errorReportRecord.token.length > 0 &&
    errorReportRecord.token.length <= ERROR_REPORT_TOKEN_MAX_LENGTH &&
    typeof errorReportRecord.code === "string" &&
    ERROR_REPORT_CODE_PATTERN.test(errorReportRecord.code)
      ? {
          errorReport: {
            token: errorReportRecord.token,
            code: errorReportRecord.code,
          },
        }
      : {}),
    searchMetadata: projectResearchSearchMetadata(record.searchMetadata ?? null),
    ...(record.appliedReasoningEffort === "default" || record.appliedReasoningEffort === "low" || record.appliedReasoningEffort === "medium" || record.appliedReasoningEffort === "high"
      ? { appliedReasoningEffort: record.appliedReasoningEffort } : {}),
    ...(parseContinuationReceipt(record.continuationReceipt) ? { continuationReceipt: parseContinuationReceipt(record.continuationReceipt) } : {}),
    ...(completionRecord && isChatCompletionStatus(completionRecord.status)
      ? {
          completion: {
            status: completionRecord.status,
            ...(completionRecord.incompleteReason === "length"
              ? { incompleteReason: "length" as const }
              : {}),
          },
        }
      : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(retryRecord &&
    typeof retryRecord.modelId === "string" &&
    retryRecord.modelId.length > 0
      ? { fileGenerationRetry: { modelId: retryRecord.modelId } }
      : {}),
    ...(record.failure &&
    typeof record.failure === "object" &&
    (record.failure as Record<string, unknown>).kind === "attachment_rejected"
      ? { failure: { kind: "attachment_rejected" as const } }
      : {}),
  };
}

export function splitSearchMetadataTrailer(raw: string): {
  displayText: string;
  searchMetadataJson: string | null;
} {
  const markerIndex = raw.indexOf(SEARCH_METADATA_TRAILER_MARKER);
  if (markerIndex === -1) {
    return { displayText: raw, searchMetadataJson: null };
  }
  return {
    displayText: raw.slice(0, markerIndex),
    searchMetadataJson: raw.slice(
      markerIndex + SEARCH_METADATA_TRAILER_MARKER.length
    ),
  };
}
