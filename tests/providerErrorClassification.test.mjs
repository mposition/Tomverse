import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  PROVIDER_CALL_DIAGNOSTIC_ROOTS,
  classifyProbeError,
  classifyProviderFailure,
  isProviderScopedFailureCategory,
  providerDiagnosticCode,
  safeErrorMetadata,
  redactProviderText,
} from "../lib/providerErrorClassification.ts";

// The diagnostic codes below are the exact strings observed on staging while
// diagnosing the probe's standing failures, so these cases pin the mapping
// against real provider output rather than invented shapes.

test("classifyProbeError reports a 404 as model drift rather than UNKNOWN", () => {
  assert.equal(
    classifyProbeError("PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_404"),
    "MODEL_NOT_FOUND"
  );
});

test("classifyProbeError reports a 400 as a rejected request rather than UNKNOWN", () => {
  assert.equal(
    classifyProbeError("PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_400"),
    "BAD_REQUEST"
  );
});

test("classifyProbeError keeps the existing precedence ahead of the new branches", () => {
  assert.equal(classifyProbeError("PROVIDER_PROBE_FAILED.TimeoutError", true), "TIMEOUT");
  assert.equal(
    classifyProbeError("PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_429"),
    "RATE_LIMIT"
  );
  assert.equal(
    classifyProbeError("PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_401"),
    "AUTH"
  );
  assert.equal(
    classifyProbeError("PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_503.RETRYABLE"),
    "SERVER_ERROR"
  );
  assert.equal(
    classifyProbeError("PROVIDER_PROBE_FAILED.ECONNRESET"),
    "NETWORK"
  );
  assert.equal(classifyProbeError(null), "UNKNOWN");
});

test("classifyProbeError anchors the new branches on the HTTP_ prefix", () => {
  // A bare /404/ or /400/ would also match digits inside a provider error
  // name, which is why these two branches are prefix-anchored while the
  // older status patterns are not.
  assert.equal(classifyProbeError("PROVIDER_PROBE_FAILED.Err404Handler"), "UNKNOWN");
});

test("providerDiagnosticCode still produces the shape the classifier matches", () => {
  const error = Object.assign(new Error("nope"), {
    name: "AI_APICallError",
    statusCode: 404,
  });
  const code = providerDiagnosticCode("PROVIDER_PROBE_FAILED", error);
  assert.equal(code, "PROVIDER_PROBE_FAILED.AI_APICallError.HTTP_404");
  assert.equal(classifyProbeError(code), "MODEL_NOT_FOUND");
});

test("safeErrorMetadata excludes provider request and response payloads", () => {
  const error = Object.assign(new Error("message includes SECRET_PROMPT"), {
    name: "AI_APICallError",
    code: "PROVIDER_FAILURE",
    statusCode: 502,
    isRetryable: true,
    requestBodyValues: { prompt: "SECRET_PROMPT" },
    responseBody: "SECRET_RESPONSE",
  });

  const serialized = JSON.stringify(safeErrorMetadata(error));
  assert.deepEqual(safeErrorMetadata(error), {
    name: "AI_APICallError",
    code: "PROVIDER_FAILURE",
    statusCode: 502,
    isRetryable: true,
  });
  assert.doesNotMatch(serialized, /SECRET_PROMPT|SECRET_RESPONSE/);
});

 // STG-R002: failure *scope* -- what a recorded failure is evidence of. The
// cases below are the ones that produced the Perplexity self-lock: a provider
// answering "400 invalid_message" was counted identically to a 503, so five
// rejections of one deep-research request pinned the whole provider (and every
// model under it) to Incident, with no success possible to clear it.

test("an HTTP 400 request-contract rejection is model scope, not provider scope", () => {
  const classification = classifyProviderFailure({
    diagnosticCode: "DEEP_RESEARCH_SUBMIT_FAILED.AI_APICallError.HTTP_400",
    httpStatus: 400,
  });
  assert.equal(classification.category, "REQUEST_CONTRACT");
  assert.equal(classification.scope, "model");
  assert.equal(isProviderScopedFailureCategory(classification.category), false);
});

test("the HTTP status is read from the diagnostic code when none is passed separately", () => {
  const classification = classifyProviderFailure({
    diagnosticCode: "AI_REQUEST_FAILED.AI_APICallError.HTTP_400",
  });
  assert.equal(classification.category, "REQUEST_CONTRACT");
  assert.equal(classification.scope, "model");
  assert.equal(classification.httpStatus, 400);
});

test("authentication, payment and rate-limit statuses stay provider scope", () => {
  for (const [status, category] of [
    [401, "AUTHENTICATION"],
    [403, "AUTHENTICATION"],
    [402, "PAYMENT_REQUIRED"],
    [429, "RATE_LIMIT"],
  ]) {
    const classification = classifyProviderFailure({
      diagnosticCode: "AI_REQUEST_FAILED.AI_APICallError",
      httpStatus: status,
    });
    assert.equal(classification.category, category, `HTTP ${status}`);
    assert.equal(classification.scope, "provider", `HTTP ${status}`);
  }
});

test("provider 5xx, timeouts and connection failures stay provider scope", () => {
  assert.equal(
    classifyProviderFailure({
      diagnosticCode: "AI_STREAM_FAILED.AI_APICallError.HTTP_503.RETRYABLE",
      httpStatus: 503,
    }).scope,
    "provider"
  );
  assert.equal(
    classifyProviderFailure({
      diagnosticCode: "AI_REQUEST_FAILED.TimeoutError",
      timedOut: true,
    }).category,
    "NETWORK"
  );
  assert.equal(
    classifyProviderFailure({ diagnosticCode: "AI_REQUEST_FAILED.ECONNRESET" })
      .scope,
    "provider"
  );
});

test("a 404 is model scope: the provider is fine, the model id is not", () => {
  const classification = classifyProviderFailure({
    diagnosticCode: "AI_REQUEST_FAILED.AI_APICallError.HTTP_404",
    httpStatus: 404,
  });
  assert.equal(classification.category, "MODEL_NOT_FOUND");
  assert.equal(classification.scope, "model");
});

test("an empty model response stays a model-scoped outcome", () => {
  assert.equal(
    classifyProviderFailure({ diagnosticCode: "AI_EMPTY_RESPONSE.STOP" }).scope,
    "model"
  );
  assert.equal(
    classifyProviderFailure({ diagnosticCode: "DEEP_RESEARCH_JOB_FAILED" }).scope,
    "model"
  );
});

test("a locally rejected request is not provider evidence, whatever status it carries", () => {
  // ChatAccessError carries its own HTTP status (429 for our own quota, 402
  // for insufficient credit) and safeErrorMetadata surfaces it, so a
  // status-first classifier would file Tomverse's own rate limiting as the
  // provider's. The diagnostic root, not the status, decides whether a call
  // ever left this process.
  for (const code of [
    "CHAT_QUOTA_EXCEEDED",
    "CREDIT_BALANCE_INSUFFICIENT",
    "ATTACHMENT_TOO_LARGE",
    "DEEP_RESEARCH_INVALID_MESSAGES",
  ]) {
    const classification = classifyProviderFailure({
      diagnosticCode: code,
      httpStatus: 429,
    });
    assert.equal(classification.category, "LOCAL_REJECTION", code);
    assert.equal(classification.scope, "none", code);
  }
});

test("an unclassifiable provider-call failure still counts against the provider", () => {
  const classification = classifyProviderFailure({
    diagnosticCode: "AI_REQUEST_FAILED.SomethingNew",
  });
  assert.equal(classification.category, "UNKNOWN");
  assert.equal(classification.scope, "provider");
});

test("every diagnostic code the route handlers record is a known provider-call root", () => {
  // Guards the allowlist against drift: a new provider-call code that is not
  // registered here would silently stop counting towards provider health,
  // which is a monitoring regression rather than a visible failure.
  const sources = [
    "app/api/chat/route.ts",
    "app/api/chat/deep-research/status/route.ts",
    "app/api/conversations/[conversationId]/compare-summary/route.ts",
    "app/api/conversations/[conversationId]/comparison-reviews/verify-item/route.ts",
    "lib/providerProbe.ts",
    "lib/providerVerification.ts",
  ];
  const literals = new Set();
  for (const path of sources) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    for (const match of source.matchAll(
      /(?:recordProviderFailure\(\s*[^,]+,\s*|providerDiagnosticCode\(\s*)"([A-Z][A-Z0-9_]*)"/g
    )) {
      literals.add(match[1]);
    }
  }
  assert.ok(literals.size > 0, "no diagnostic literals were found to check");
  for (const literal of literals) {
    assert.ok(
      PROVIDER_CALL_DIAGNOSTIC_ROOTS.includes(literal),
      `${literal} is recorded as a provider failure but is not in PROVIDER_CALL_DIAGNOSTIC_ROOTS`
    );
  }
});

test("redactProviderText strips credentials a provider echoed back", () => {
  const redacted = redactProviderText(
    "failed with Authorization: Bearer sk-abcdef1234567890",
    200
  );
  assert.ok(!redacted.includes("sk-abcdef1234567890"));
  assert.ok(!redacted.includes("Bearer sk-"));
  assert.match(redacted, /\[REDACTED\]/);
  assert.equal(redactProviderText("   ", 200), null);
  assert.equal(redactProviderText(undefined, 200), null);
});
