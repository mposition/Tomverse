import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProbeError,
  providerDiagnosticCode,
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
