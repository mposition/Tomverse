import assert from "node:assert/strict";
import test from "node:test";

import { amuxAnalysisStopRequestKey, isAmuxAnalysisStopRequestId,
  parseAmuxAnalysisStopReceipt } from
  "../lib/amux/ideaAnalysisStopUiCore.ts";

const expected = { holdId: "hold-1", previewId: "preview-1", ideaId: "idea-1" };
const receipt = { ...expected, auditId: "audit-1" };

test("stop UI accepts only an exact receipt for the current analysis", () => {
  assert.deepEqual(parseAmuxAnalysisStopReceipt(201, receipt, expected), receipt);
  assert.deepEqual(parseAmuxAnalysisStopReceipt(200,
    { status: "committed", ...receipt }, expected, true), receipt);
  for (const value of [
    { ...receipt, holdId: "other" },
    { ...receipt, previewId: "other" },
    { ...receipt, ideaId: "other" },
    { ...receipt, auditId: "../other" },
  ]) assert.equal(parseAmuxAnalysisStopReceipt(201, value, expected), null);
  assert.equal(parseAmuxAnalysisStopReceipt(200, receipt, expected), null);
  assert.equal(parseAmuxAnalysisStopReceipt(200,
    { status: "absent" }, expected, true), null);
  assert.equal(parseAmuxAnalysisStopReceipt(200,
    { status: "unknown", ...receipt }, expected, true), null);
});

test("stop request storage is bound to one valid hold", () => {
  assert.equal(amuxAnalysisStopRequestKey("hold-1"),
    "amux-v19-analysis-stop:hold-1");
  assert.throws(() => amuxAnalysisStopRequestKey("../other"));
  assert.equal(isAmuxAnalysisStopRequestId("request-1"), true);
  assert.equal(isAmuxAnalysisStopRequestId(null), false);
  assert.equal(isAmuxAnalysisStopRequestId("../other"), false);
});
