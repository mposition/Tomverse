import assert from "node:assert/strict";
import test from "node:test";
import {
  APICallError, InvalidResponseDataError, JSONParseError, NoObjectGeneratedError,
  NoOutputGeneratedError, TypeValidationError,
} from "ai";
import { autoLlmRouterFailureDetail } from "../lib/autoLlmRouterDiagnostics.ts";

const SECRET = "private prompt, response and credential";
const structuredError = (cause, finishReason = "length") => new NoObjectGeneratedError({
  cause, finishReason, text: SECRET,
  response: { id: SECRET, modelId: SECRET, timestamp: new Date() },
  usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
});

test("structured JSON parsing and schema validation failures are distinct and content-free", () => {
  const parsing = new JSONParseError({ text: SECRET, cause: new SyntaxError(SECRET) });
  assert.deepEqual(autoLlmRouterFailureDetail(structuredError(parsing)), {
    failureKind: "output_parse", finishReason: "length", outputChars: SECRET.length,
  });
  assert.deepEqual(autoLlmRouterFailureDetail(parsing), {
    failureKind: "output_parse", outputChars: SECRET.length,
  });
  const validation = new TypeValidationError({ value: { secret: SECRET }, cause: new Error(SECRET) });
  assert.deepEqual(autoLlmRouterFailureDetail(structuredError(validation, "stop")), {
    failureKind: "output_validation", finishReason: "stop", outputChars: SECRET.length,
  });
  assert.deepEqual(autoLlmRouterFailureDetail(validation), { failureKind: "output_validation" });
});

test("provider failures expose only a valid HTTP status, never request or response details", () => {
  for (const statusCode of [undefined, 408, 429, 503, NaN, 999]) {
    const error = new APICallError({
      message: SECRET, url: `https://example.invalid/${SECRET}`, statusCode,
      requestBodyValues: { secret: SECRET }, responseBody: SECRET,
      responseHeaders: { authorization: SECRET }, data: { secret: SECRET },
    });
    assert.deepEqual(autoLlmRouterFailureDetail(error), {
      failureKind: "provider",
      ...([408, 429, 503].includes(statusCode)
        ? { statusCode, statusClass: statusCode === 429 ? "rate_limit" : "server" } : {}),
    });
  }
  assert.deepEqual(autoLlmRouterFailureDetail(new InvalidResponseDataError({ data: SECRET })), {
    failureKind: "provider_response",
  });
});

test("a provider status is labelled as auth, request parameters, rate limit or provider side", async () => {
  const { providerStatusClass } = await import("../lib/autoLlmRouterDiagnostics.ts");
  for (const [statusCode, statusClass] of [
    [401, "auth"], [403, "auth"], [400, "request"], [404, "request"], [422, "request"],
    [429, "rate_limit"], [408, "server"], [500, "server"], [503, "server"], [418, "other"],
  ]) {
    assert.equal(providerStatusClass(statusCode), statusClass);
  }
  const auth = new APICallError({
    message: SECRET, url: "https://example.invalid", statusCode: 401,
    requestBodyValues: { secret: SECRET }, responseBody: SECRET,
  });
  assert.deepEqual(autoLlmRouterFailureDetail(auth), { failureKind: "provider", statusCode: 401, statusClass: "auth" });
});

test("an actual deadline abort is distinct from HTTP 408 or an unrelated abort", () => {
  const abort = new DOMException(SECRET, "AbortError");
  assert.deepEqual(autoLlmRouterFailureDetail(abort, { timedOut: true }), { failureKind: "timeout" });
  assert.deepEqual(autoLlmRouterFailureDetail(abort), { failureKind: "unknown" });
});

test("missing output retains a known finish reason without exposing arbitrary error fields", () => {
  assert.deepEqual(autoLlmRouterFailureDetail(new NoOutputGeneratedError({ message: SECRET }), {
    finishReason: "tool-calls",
  }), { failureKind: "output_missing", finishReason: "tool-calls" });
  assert.deepEqual(autoLlmRouterFailureDetail(structuredError(undefined, "stop")), {
    failureKind: "output_generation", finishReason: "stop", outputChars: SECRET.length,
  });
  for (const error of [new Error(SECRET), SECRET, null, { name: SECRET, message: SECRET, text: SECRET }]) {
    assert.deepEqual(autoLlmRouterFailureDetail(error, { finishReason: SECRET }), { failureKind: "unknown" });
  }
  assert.deepEqual(autoLlmRouterFailureDetail(structuredError(undefined, SECRET)), {
    failureKind: "output_generation", outputChars: SECRET.length,
  });
});
