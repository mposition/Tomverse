import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../components/marketing/ModelsPageContent.tsx", import.meta.url),
  "utf8",
);

test("Korean models page mobile intro uses the same product names as the Korean menu", () => {
  const koBlock = source.slice(source.indexOf("  ko: {"));
  const match = koBlock.match(/mobileDescription: "([^"]+)"/);
  assert.ok(match, "ko mobileDescription is present");
  assert.match(match[1], /채팅과 리뷰/);
  assert.doesNotMatch(match[1], /\bChat\b|\bReview\b/);
});

test("collapsed mobile filters still show the shown/total model count", () => {
  const start = source.indexOf('data-testid="models-mobile-results-count"');
  assert.ok(start > 0, "mobile results count is rendered");
  const line = source.slice(source.lastIndexOf("\n", start), source.indexOf("\n", start));
  assert.match(line, /sm:hidden/);
  assert.match(line, /\{filters\.results\}: \{filteredModels\.length\} \/ \{ENABLED_MODELS\.length\}/);
  assert.doesNotMatch(line, /role="status"/, "only the filter panel owns the live status region");
  const guard = source.slice(source.lastIndexOf("{(", start), start);
  assert.match(guard, /!mobileFiltersOpen/);
});

test("English mobile card summary does not repeat access plan and base credits", () => {
  const start = source.indexOf('data-testid="model-mobile-criteria"');
  assert.ok(start > 0, "mobile card summary is rendered");
  const lineEnd = source.indexOf("\n", start);
  const line = source.slice(source.lastIndexOf("\n", start), lineEnd);
  assert.match(line, /sm:hidden/);
  assert.match(line, /Images: /);
  assert.match(line, /Context: /);
  assert.doesNotMatch(line, /Access from|Short request|usageProfile\.credits/);
  const desktop = source.slice(lineEnd, source.indexOf("\n", lineEnd + 1));
  assert.match(desktop, /hidden sm:inline/);
  assert.match(desktop, /Access from: .* Short request: /);
});
