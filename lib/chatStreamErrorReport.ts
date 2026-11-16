import {
  contentFreeErrorMetadata,
  providerDiagnosticCode,
  safeErrorMetadata,
} from "@/lib/providerErrorClassification";
import type { ChatErrorReportGrantInput } from "@/lib/traceErrorEvidence";

/**
 * The error-report grant for a turn that failed after its 200 stream had
 * started (docs/policy/trace-feedback-automation.md section 3.3).
 *
 * The JSON error builders sign a grant into a response header. A stream that
 * has already begun has no header left to write, so the chat route signs the
 * same grant at settlement and carries it in the stream trailer. This module
 * is the pure half of that: it decides what the grant says. It signs nothing
 * and writes nothing, so a test can read its answer without a database.
 *
 * Only what the server itself observed goes in. Nothing here reads the
 * request, the answer text or a provider message.
 */

/**
 * Whether an error was raised by this process misusing its own runtime.
 *
 * Deliberately narrow. These Node codes report a call made with the wrong
 * state or the wrong argument -- writing to a stream controller that is
 * already closed is `ERR_INVALID_STATE` -- and no HTTP answer from a provider
 * can produce one. `TypeError` alone is not on the list: undici reports a
 * failed connection as `TypeError: fetch failed`, which is a network fact and
 * not a defect in this code.
 */
const LOCAL_RUNTIME_ERROR_CODE =
  /^ERR_(INVALID_[A-Z_]+|OUT_OF_RANGE|ASSERTION|INTERNAL_ASSERTION|MISSING_ARGS)$/;

export const isLocalRuntimeError = (error: unknown): boolean => {
  const metadata = safeErrorMetadata(error);
  if (metadata.statusCode !== undefined) return false;
  if (metadata.code && LOCAL_RUNTIME_ERROR_CODE.test(metadata.code)) return true;
  return metadata.name === "ReferenceError" || metadata.name === "RangeError";
};

/**
 * The caught error, reduced to what may leave this process.
 *
 * The grant hands its `error` to Sentry. A provider error's message and
 * `cause` can quote the request or the answer -- `AI_APICallError` carries
 * both bodies -- and Sentry's sanitizer only masks credentials, so the
 * original object must never be the one captured. What survives is the
 * content-free metadata every stream-error log line already uses, plus the
 * stack frames: `at` lines are code locations, and for a failure this
 * process caused they are the part worth reading.
 */
const STACK_FRAME = /^\s+at [^\n]{1,300}$/;

export const contentFreeError = (error: unknown): Error | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const metadata = contentFreeErrorMetadata(error);
  const safe = new Error(
    [
      metadata.code,
      metadata.statusCode ? `HTTP_${metadata.statusCode}` : null,
      metadata.isRetryable === true ? "RETRYABLE" : null,
    ]
      .filter(Boolean)
      .join(" ") || "stream failure"
  );
  safe.name = metadata.name;
  const original = (error as { stack?: unknown }).stack;
  const frames =
    typeof original === "string"
      ? original.split("\n").filter((line) => STACK_FRAME.test(line))
      : [];
  safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join("\n");
  return safe;
};

const CODE_MAX_LENGTH = 160;

/** The shape the stream trailer accepts back: no prose, bounded. */
const boundedCode = (code: string) =>
  code.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, CODE_MAX_LENGTH);

export type StreamFailureGrantContext = {
  traceId: string;
  /** Which settlement branch judged the turn failed. */
  root: "AI_EMPTY_RESPONSE" | "AI_STREAM_FAILED";
  /** The code that branch already recorded for provider health. */
  diagnosticCode: string;
  provider: string | null;
  modelId: string | null;
  /** What the settlement caught, when it caught anything. */
  error?: unknown;
  /**
   * The last error the provider stream reported through `onError`.
   *
   * An empty answer usually reaches settlement as the SDK's
   * `AI_NoOutputGeneratedError`, which names the symptom. The error that
   * caused it was reported here first, and when that one is this process's
   * own fault it is the one the report should be filed under.
   */
  observedStreamError?: unknown;
  /** Set when the caller already knows the failure was on this side. */
  localLayer?: "storage" | "application" | null;
};

export const streamFailureGrantInput = (
  context: StreamFailureGrantContext
): ChatErrorReportGrantInput => {
  const observedIsLocal = isLocalRuntimeError(context.observedStreamError);
  const subject = observedIsLocal
    ? context.observedStreamError
    : (context.error ?? context.observedStreamError);
  const failureLayer =
    context.localLayer ??
    (observedIsLocal || isLocalRuntimeError(context.error)
      ? "application"
      : "provider_stream");
  return {
    traceId: context.traceId,
    routeClass: "chat",
    errorCode: boundedCode(
      observedIsLocal
        ? providerDiagnosticCode(context.root, context.observedStreamError)
        : context.diagnosticCode
    ),
    // The response this failure rode on had already been sent as a 200.
    httpStatus: 200,
    phase: "stream",
    failureLayer,
    provider: context.provider,
    modelId: context.modelId,
    retryable: safeErrorMetadata(subject).isRetryable ?? null,
    // Never the original object: see `contentFreeError`.
    ...(contentFreeError(subject) ? { error: contentFreeError(subject) } : {}),
  };
};
