import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { amuxAnalysisClaimRecoveryHoldId } from
  "../lib/amux/ideaAnalysisClaimRecoveryCore.ts";

const id = "12345678-1234-4123-8123-123456789abc";
test("exact hold-ID recovery is independent of a transfer preview or its expiry", () => {
  assert.equal(amuxAnalysisClaimRecoveryHoldId(id, "enabled"), id);
  assert.equal(amuxAnalysisClaimRecoveryHoldId(id.toUpperCase(), "enabled"), id);
});

test("a malformed, duplicated, missing or disabled recovery selector fails closed", () => {
  for (const value of [undefined, null, "", {}, [id], [id, id], ` ${id}`, `${id}\n`,
    "12345678-1234-0123-0123-123456789abc", "../../anything", "x".repeat(100_000)]) {
    assert.equal(amuxAnalysisClaimRecoveryHoldId(value, "enabled"), null);
  }
  for (const gate of [undefined, null, "disabled", "Enabled", true, " enabled"]) {
    assert.equal(amuxAnalysisClaimRecoveryHoldId(id, gate), null);
  }
});

test("recovery uses the existing owner page and exact claim panel without a new writer", () => {
  const page = readFileSync(new URL("../app/(site)/(application)/admin/amux-backlog/page.tsx",
    import.meta.url), "utf8");
  const panel = readFileSync(new URL("../components/admin/AmuxAnalysisClaimResolutionPanel.tsx",
    import.meta.url), "utf8");
  assert.ok(page.indexOf('getAdminRole(session) !== "owner"') < page.indexOf("query.analysisHoldId"));
  assert.match(page, /amuxAnalysisClaimRecoveryHoldId\(query\.analysisHoldId,\s*process\.env\.TOMVERSE_AMUX_V4_ANALYSIS_CLAIM_RESOLUTION_READ\)/);
  assert.match(page, /recoveryHoldId \? <AmuxAnalysisClaimResolutionPanel\s*key=\{recoveryHoldId\} holdId=\{recoveryHoldId\}/);
  assert.match(panel, /onResolved\?: \(\) => void/);
  assert.match(panel, /onResolved\?\.\(\)/);
  assert.match(panel, /new URLSearchParams\(\{ holdId \}\)/);
  assert.match(panel, /readbackDigest: readback\.readbackDigest, evidenceDigest, disposition/);
  assert.match(panel, /useEffect\(\(\) => \{ queueMicrotask\(\(\) => \{ void load\(\); \}\); \}, \[load\]\)/);
  assert.doesNotMatch(page, /method: "POST"|reserveAmux|claimAmux|commitAmux/);
});
