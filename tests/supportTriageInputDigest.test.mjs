import assert from "node:assert/strict";
import { test } from "node:test";

const { suggestionInputDigest } = await import("../lib/supportTriageInputDigest.ts");

// The suggestion input digest (design section 5.3).

const BASE = {
  report: {
    message: "The answer stops halfway.",
    type: "bug",
    language: "en",
    status: "open",
    errorReportVerification: null,
    traceProvenance: null,
    errorClassificationSource: null,
    clientErrorCode: null,
    evidenceAvailability: null,
    traceEvidenceId: null,
  },
  evidence: null,
  autoFixCase: null,
};

test("the digest is a stable SHA-256 hex of the inputs", () => {
  const digest = suggestionInputDigest(BASE);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(suggestionInputDigest(structuredClone(BASE)), digest);
});

test("every input the rules read changes the digest", () => {
  const digest = suggestionInputDigest(BASE);
  const variants = [
    { ...BASE, report: { ...BASE.report, message: "The answer stops halfway!" } },
    { ...BASE, report: { ...BASE.report, type: "feature" } },
    { ...BASE, report: { ...BASE.report, status: "reviewing" } },
    { ...BASE, report: { ...BASE.report, errorReportVerification: "verified" } },
    { ...BASE, evidence: { errorCode: "E1", routeClass: "chat", release: "r1", retryable: true, failureLayer: "provider" } },
    { ...BASE, autoFixCase: { state: "received", classification: null } },
  ];
  for (const variant of variants) assert.notEqual(suggestionInputDigest(variant), digest, JSON.stringify(variant).slice(0, 80));
});
