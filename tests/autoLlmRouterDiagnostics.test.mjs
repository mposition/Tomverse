import assert from "node:assert/strict";
import test from "node:test";
import { APICallError, JSONParseError, NoObjectGeneratedError, TypeValidationError } from "ai";
import { autoLlmRouterFailureDetail } from "../lib/autoLlmRouterDiagnostics.ts";

const secret = "private prompt and provider credential";
const outputError = (cause) => new NoObjectGeneratedError({
  cause, text: secret, finishReason: "length", response: {}, usage: {},
});

test("structured output failures distinguish parsing, validation and missing output without content", () => {
  for (const [cause, kind] of [
    [new JSONParseError({ text: secret, cause: new SyntaxError(secret) }), "response_parse"],
    [new TypeValidationError({ value: { prompt: secret }, cause: new Error(secret) }), "response_schema"],
    [undefined, "response_output"],
  ]) {
    const detail = autoLlmRouterFailureDetail(outputError(cause));
    assert.equal(detail.failureKind, kind);
    assert.equal(detail.name, "AI_NoObjectGeneratedError");
    assert.equal(detail.finishReason, "length");
    assert.equal(detail.outputChars, secret.length);
    assert.ok(!JSON.stringify(detail).includes(secret));
  }
});

test("API diagnostics keep status and retryability but omit request, response, headers and message", () => {
  const detail = autoLlmRouterFailureDetail(new APICallError({
    message: secret, url: `https://example.com/${secret}`,
    requestBodyValues: { prompt: secret }, responseBody: secret,
    responseHeaders: { authorization: secret }, statusCode: 429,
  }));
  assert.equal(detail.failureKind, "api");
  assert.equal(detail.statusCode, 429);
  assert.equal(detail.isRetryable, true);
  assert.ok(!JSON.stringify(detail).includes(secret));
});

test("the call's actual expired deadline identifies timeouts even when the provider throws another error", () => {
  assert.equal(autoLlmRouterFailureDetail(new Error(secret), true).failureKind, "timeout");
  assert.equal(autoLlmRouterFailureDetail(new DOMException(secret, "TimeoutError")).failureKind, "timeout");
  assert.equal(autoLlmRouterFailureDetail(new DOMException(secret, "AbortError")).failureKind, "aborted");
  assert.equal(autoLlmRouterFailureDetail(new Error(secret)).failureKind, "unknown");
});

test("unexpected error labels and finish reasons cannot introduce prose into diagnostics", () => {
  const error = outputError(new Error(secret));
  error.name = secret;
  error.cause.name = secret;
  error.finishReason = secret;
  const detail = autoLlmRouterFailureDetail(error);
  assert.equal(detail.name, "Error");
  assert.equal(detail.causeName, "Error");
  assert.equal(detail.finishReason, undefined);
  assert.ok(!JSON.stringify(detail).includes(secret));
  assert.equal(autoLlmRouterFailureDetail(secret).failureKind, "unknown");
});
