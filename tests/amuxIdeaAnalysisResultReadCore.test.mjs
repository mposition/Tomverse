import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED,
  amuxV4AnalysisResultReadEnabled,
} from "../lib/amux/ideaAnalysisResultReadCore.ts";

test("the owner result read remains dark even if its environment value is enabled", () => {
  assert.equal(AMUX_V4_ANALYSIS_RESULT_READ_CODE_ENABLED, false);
  assert.equal(amuxV4AnalysisResultReadEnabled("enabled"), false);
  assert.equal(amuxV4AnalysisResultReadEnabled(undefined), false);
});
