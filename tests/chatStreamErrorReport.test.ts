import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isLocalRuntimeError,
  streamFailureGrantInput,
} from "../lib/chatStreamErrorReport";
import { traceEvidenceRecordability } from "../lib/errorReportContract";
import {
  buildChatStreamTrailerChunk,
  parseChatStreamTrailer,
  splitSearchMetadataTrailer,
} from "../lib/webSearchStreamTrailer";

/**
 * The error report for a turn that failed after its 200 stream had started
 * (docs/policy/trace-feedback-automation.md section 3.3).
 *
 * What must hold:
 *   - the grant says only what the server observed, under the server's code;
 *   - a failure this process caused is recorded as `application`, and named
 *     after the error that caused it rather than the SDK's symptom;
 *   - the token the route signs for that grant survives the stream trailer
 *     and verifies for the same trace -- which is what turns the report into
 *     a verified one at the feedback endpoint;
 *   - the route issues it from the two failed-settlement branches and from
 *     nowhere a completed or cancelled turn passes through.
 */

const TRACE = "11111111-2222-4333-8444-555555555555";
const SECRET = "an-error-report-secret-of-32-chars!!";

const nodeError = (name: string, code: string, message: string) =>
  Object.assign(new TypeError(message), { name, code });

const noOutput = Object.assign(new Error("No output generated."), {
  name: "AI_NoOutputGeneratedError",
});

test("a Node runtime misuse is this process's own failure; a network or provider error is not", () => {
  assert.equal(
    isLocalRuntimeError(nodeError("TypeError", "ERR_INVALID_STATE", "Invalid state: Controller is already closed")),
    true
  );
  assert.equal(isLocalRuntimeError(new RangeError("Invalid array length")), true);
  // undici's failed connection is a TypeError with no Node ERR_INVALID_* code.
  assert.equal(isLocalRuntimeError(new TypeError("fetch failed")), false);
  assert.equal(isLocalRuntimeError(Object.assign(new Error("reset"), { code: "ECONNRESET" })), false);
  assert.equal(isLocalRuntimeError(Object.assign(new Error("closed"), { code: "ERR_STREAM_PREMATURE_CLOSE" })), false);
  assert.equal(isLocalRuntimeError(Object.assign(new Error("closed"), { code: "UND_ERR_SOCKET" })), false);
  // Anything that came back over HTTP is the other side's, whatever its code.
  assert.equal(
    isLocalRuntimeError(Object.assign(new Error("bad"), { code: "ERR_INVALID_STATE", statusCode: 500 })),
    false
  );
  assert.equal(isLocalRuntimeError(noOutput), false);
  assert.equal(isLocalRuntimeError(null), false);
});

test("an empty answer the provider gave is granted under the route's own diagnostic code", () => {
  const grant = streamFailureGrantInput({
    traceId: TRACE,
    root: "AI_EMPTY_RESPONSE",
    diagnosticCode: "AI_EMPTY_RESPONSE.STOP",
    provider: "openai",
    modelId: "gpt-6-luna",
  });
  assert.deepEqual(grant, {
    traceId: TRACE,
    routeClass: "chat",
    errorCode: "AI_EMPTY_RESPONSE.STOP",
    httpStatus: 200,
    phase: "stream",
    failureLayer: "provider_stream",
    provider: "openai",
    modelId: "gpt-6-luna",
    retryable: null,
  });
  assert.deepEqual(traceEvidenceRecordability(grant.errorCode, grant.httpStatus), { record: true });
});

test("an empty answer this process caused is named after the cause and recorded as application", () => {
  // The production shape: the stream reported ERR_INVALID_STATE through
  // onError, then settlement saw only the SDK's "no output" error.
  const cause = nodeError("TypeError", "ERR_INVALID_STATE", "Invalid state: Controller is already closed");
  const grant = streamFailureGrantInput({
    traceId: TRACE,
    root: "AI_EMPTY_RESPONSE",
    diagnosticCode: "AI_EMPTY_RESPONSE.AI_NoOutputGeneratedError",
    provider: "openai",
    modelId: "gpt-6-luna",
    error: noOutput,
    observedStreamError: cause,
  });
  assert.equal(grant.errorCode, "AI_EMPTY_RESPONSE.ERR_INVALID_STATE");
  assert.equal(grant.failureLayer, "application");
  // The cause is what Sentry gets, as code and frames -- never the object.
  assert.ok(grant.error instanceof Error);
  assert.notEqual(grant.error, cause);
  assert.equal((grant.error as Error).name, "TypeError");
  assert.equal((grant.error as Error).message, "ERR_INVALID_STATE");
  assert.equal(grant.httpStatus, 200);
  assert.equal(grant.phase, "stream");
});

test("a provider's own stream error keeps the provider layer, its code and its retryability", () => {
  const providerError = Object.assign(new Error("overloaded"), {
    name: "AI_APICallError",
    statusCode: 503,
    isRetryable: true,
  });
  const grant = streamFailureGrantInput({
    traceId: TRACE,
    root: "AI_STREAM_FAILED",
    diagnosticCode: "AI_STREAM_FAILED.AI_APICallError.HTTP_503.RETRYABLE",
    provider: "anthropic",
    modelId: "claude-fable-5",
    error: providerError,
    observedStreamError: providerError,
  });
  assert.equal(grant.errorCode, "AI_STREAM_FAILED.AI_APICallError.HTTP_503.RETRYABLE");
  assert.equal(grant.failureLayer, "provider_stream");
  assert.equal(grant.retryable, true);
  assert.deepEqual(traceEvidenceRecordability(grant.errorCode, grant.httpStatus), { record: true });
});

test("what the grant hands to Sentry carries no provider text, only codes", () => {
  const CONTENT = "SYNTHETIC-USER-PROMPT-MARKER";
  const providerError = Object.assign(new Error(`Bad request: ${CONTENT}`), {
    name: "AI_APICallError",
    statusCode: 400,
    isRetryable: false,
    requestBodyValues: { messages: [{ role: "user", content: CONTENT }] },
    responseBody: `{"error":"${CONTENT}"}`,
    cause: new Error(CONTENT),
  });
  const grant = streamFailureGrantInput({
    traceId: TRACE,
    root: "AI_STREAM_FAILED",
    diagnosticCode: "AI_STREAM_FAILED.AI_APICallError.HTTP_400",
    provider: "openai",
    modelId: "gpt-6-luna",
    error: providerError,
    observedStreamError: providerError,
  });
  const captured = grant.error as Error & Record<string, unknown>;
  assert.ok(captured instanceof Error);
  assert.notEqual(captured, providerError);
  assert.equal(captured.name, "AI_APICallError");
  assert.equal(captured.message, "HTTP_400");
  assert.equal(captured.cause, undefined);
  assert.equal(captured.requestBodyValues, undefined);
  assert.equal(captured.responseBody, undefined);
  // Everything Sentry could serialise off it, stack included.
  const serialised = JSON.stringify({ ...captured, message: captured.message, stack: captured.stack });
  assert.equal(serialised.includes(CONTENT), false);
  // Nothing of the original stack either: it begins with the message.
  assert.equal(captured.stack, "AI_APICallError: HTTP_400");
});

test("no part of the original stack survives, frame-shaped message lines included", () => {
  const MARKER = "PRIVATE_PROMPT_MARKER";
  const cases: unknown[] = [
    // The review's case: a provider echo that looks exactly like a frame.
    new Error(`Provider echoed request:\n    at ${MARKER} (/app/chat.ts:1:1)`),
    Object.assign(new Error(`first line\n    at ${MARKER} (/a.ts:1:1)\nlast`), { name: "AI_APICallError" }),
    // A message reassigned to a prefix after construction: the old one is
    // still in the stack, with nothing to mark where it ends.
    Object.assign(new Error(`Provider echoed request:\n    at ${MARKER} (/app/chat.ts:1:1)`), {
      message: "Provider echoed request:",
    }),
    Object.assign(new Error("short"), { stack: `Error: other\n    at ${MARKER} (/a.ts:1:1)` }),
    Object.assign(new Error(""), { stack: `Error\n    at real (/a.ts:1:1)\n${MARKER}\n    at ${MARKER} (/b.ts:2:2)` }),
  ];
  for (const error of cases) {
    const grant = streamFailureGrantInput({
      traceId: TRACE,
      root: "AI_STREAM_FAILED",
      diagnosticCode: "AI_STREAM_FAILED.Error",
      provider: "openai",
      modelId: "gpt-6-luna",
      error,
    });
    const captured = grant.error as Error;
    assert.equal(`${captured.message}\n${captured.stack}`.includes(MARKER), false, String((error as Error).stack));
  }
  // A Node error keeps its code, and only its code.
  const ordinary = streamFailureGrantInput({
    traceId: TRACE,
    root: "AI_STREAM_FAILED",
    diagnosticCode: "AI_STREAM_FAILED.Error",
    provider: "openai",
    modelId: "gpt-6-luna",
    error: nodeError("TypeError", "ERR_INVALID_STATE", "Invalid state: Controller is already closed"),
  });
  assert.equal((ordinary.error as Error).stack, "TypeError: ERR_INVALID_STATE");
});

test("a layer the route already knows is kept, and the code can never hold prose", () => {
  const grant = streamFailureGrantInput({
    traceId: TRACE,
    root: "AI_STREAM_FAILED",
    diagnosticCode: "AI_STREAM_FAILED.Some Error: with words!",
    provider: "openai",
    modelId: "gpt-6-luna",
    error: new Error("bucket"),
    localLayer: "storage",
  });
  assert.equal(grant.failureLayer, "storage");
  assert.match(grant.errorCode, /^[A-Za-z0-9_.-]{1,160}$/);
});

test("the trailer carries the error report and a malformed one is dropped", () => {
  const chunk = buildChatStreamTrailerChunk({
    searchMetadata: null,
    completion: { status: "normal" },
    errorReport: { token: "terr1.payload.signature", code: "AI_EMPTY_RESPONSE.STOP" },
  });
  const trailer = parseChatStreamTrailer(splitSearchMetadataTrailer(chunk).searchMetadataJson);
  assert.deepEqual(trailer?.errorReport, {
    token: "terr1.payload.signature",
    code: "AI_EMPTY_RESPONSE.STOP",
  });
  assert.equal(trailer?.completion?.status, "normal");

  // The failed-stream trailer is the report alone.
  const bare = parseChatStreamTrailer(JSON.stringify({ errorReport: { token: "t", code: "AI_STREAM_FAILED.X" } }));
  assert.deepEqual(bare?.errorReport, { token: "t", code: "AI_STREAM_FAILED.X" });

  for (const errorReport of [
    { token: "", code: "AI_EMPTY_RESPONSE" },
    { token: "x".repeat(2_049), code: "AI_EMPTY_RESPONSE" },
    { token: "t", code: "has spaces and words" },
    { token: 7, code: "AI_EMPTY_RESPONSE" },
    { code: "AI_EMPTY_RESPONSE" },
    "terr1.a.b",
  ]) {
    const parsed = parseChatStreamTrailer(JSON.stringify({ searchMetadata: null, errorReport }));
    assert.equal(parsed?.errorReport, undefined, JSON.stringify(errorReport).slice(0, 60));
  }
  // A turn that completed says nothing.
  const normal = parseChatStreamTrailer(JSON.stringify({ searchMetadata: null, completion: { status: "normal" } }));
  assert.equal(normal && "errorReport" in normal, false);
});

test("the token signed for a stream failure verifies for its trace after the trailer round trip", async () => {
  const previous = process.env.ERROR_REPORT_SIGNING_SECRET;
  process.env.ERROR_REPORT_SIGNING_SECRET = SECRET;
  try {
    const { issueErrorReportToken, verifyErrorReportToken } = await import("../lib/errorReportToken");
    const grant = streamFailureGrantInput({
      traceId: TRACE,
      root: "AI_EMPTY_RESPONSE",
      diagnosticCode: "AI_EMPTY_RESPONSE.AI_NoOutputGeneratedError",
      provider: "openai",
      modelId: "gpt-6-luna",
      error: noOutput,
      observedStreamError: nodeError("TypeError", "ERR_INVALID_STATE", "Invalid state"),
    });
    // What issueChatErrorReportGrant signs for a recordable code.
    const token = issueErrorReportToken({
      traceId: grant.traceId,
      routeClass: grant.routeClass,
      errorCode: grant.errorCode,
      occurrenceId: "occ-stream-1",
    });
    assert.ok(token);
    const chunk = buildChatStreamTrailerChunk({
      searchMetadata: null,
      errorReport: { token: token!, code: grant.errorCode },
    });
    const received = parseChatStreamTrailer(splitSearchMetadataTrailer(`partial answer${chunk}`).searchMetadataJson);
    assert.ok(received?.errorReport);
    const outcome = verifyErrorReportToken(received!.errorReport!.token);
    assert.equal(outcome.status, "verified");
    assert.equal(outcome.payload?.traceId, TRACE);
    assert.equal(outcome.payload?.errorCode, "AI_EMPTY_RESPONSE.ERR_INVALID_STATE");
    assert.equal(outcome.payload?.occurrenceId, "occ-stream-1");
    // The signed code is the one the client is told, so the two cannot differ.
    assert.equal(outcome.payload?.errorCode, received!.errorReport!.code);
  } finally {
    if (previous === undefined) delete process.env.ERROR_REPORT_SIGNING_SECRET;
    else process.env.ERROR_REPORT_SIGNING_SECRET = previous;
  }
});

test("the chat route issues the stream report only from its two failed-settlement branches", () => {
  const source = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
  const calls = [...source.matchAll(/issueStreamErrorReport\(\s*"(AI_[A-Z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(calls.sort(), ["AI_EMPTY_RESPONSE", "AI_STREAM_FAILED"]);

  // The empty-answer grant sits inside the branch that decided the turn was
  // empty, before the trailer that carries it.
  const emptyBranch = source.indexOf("if (isEmptyResponse) {");
  const emptyGrant = source.indexOf('issueStreamErrorReport(\n                                "AI_EMPTY_RESPONSE"');
  const successBranch = source.indexOf("await recordProviderSuccess(", emptyBranch);
  assert.ok(emptyBranch > 0 && emptyGrant > emptyBranch && emptyGrant < successBranch);
  assert.ok(source.indexOf("{ errorReport: streamErrorReport }", successBranch) > successBranch);

  // The cancelled path settles and releases without ever reaching either.
  const cancel = source.slice(
    source.indexOf("const cancelTurnSafely = ("),
    source.indexOf("const finishCancellationBeforeCompletion")
  );
  assert.ok(cancel.includes('settleSafely("cancelled"'));
  assert.equal(cancel.includes("issueStreamErrorReport"), false);
});
