import assert from "node:assert/strict";
import test from "node:test";
import { citationsOutsideResearchBody } from "../lib/researchCitationDisplay.ts";
import { validateAndRenderResearchReport, createResearchEvidenceRegistry } from "../lib/researchPreviewReport.ts";
import { buildResearchPreviewMetadata } from "../lib/researchPreviewMetadata.ts";

const a = { url: "https://example.org/a", title: "A", referenceNumber: 1 };
const b = { url: "https://example.org/b", title: "B", referenceNumber: 2 };

test("an ordinary web search answer keeps every citation", () => {
  assert.deepEqual(citationsOutsideResearchBody([a, b], undefined), [a, b]);
  assert.deepEqual(citationsOutsideResearchBody([a, b], null), [a, b]);
  assert.deepEqual(citationsOutsideResearchBody(undefined, undefined), []);
});

test("a Research report drops only the sources its body already lists", () => {
  assert.deepEqual(citationsOutsideResearchBody([a, b], { sources: [{ url: a.url }, { url: b.url }] }), []);
});

test("a source another tool added to the same turn still shows", () => {
  const connector = { url: "https://drive.example.com/doc", title: "Connector doc" };
  assert.deepEqual(citationsOutsideResearchBody([a, connector], { sources: [{ url: a.url }] }), [connector]);
});

test("Research metadata without sources keeps every citation, so nothing disappears", () => {
  assert.deepEqual(citationsOutsideResearchBody([a], {}), [a]);
  assert.deepEqual(citationsOutsideResearchBody([a], { sources: [] }), [a]);
});

test("a rendered Research report lists each saved citation in its body exactly once", () => {
  const registry = createResearchEvidenceRegistry();
  registry.addToolResult({ status: "ok", searchesRemaining: 0, results: [
    { url: a.url, title: "Source A", snippet: "Snippet A" },
    { url: b.url, title: "Source B", snippet: "Snippet B" },
  ] });
  const rendered = validateAndRenderResearchReport({
    registry, allowedSourceIds: registry.sourceIds(), locale: "ko-KR",
    report: {
      status: "complete", summary: "Summary.",
      findings: [{ heading: "Finding", statements: [
        { kind: "fact", text: "First fact.", sourceIds: ["R1"] },
        { kind: "fact", text: "Second fact.", sourceIds: ["R2"] },
      ] }],
      contradictions: [], limitations: ["Only search excerpts were available."], nextQuestions: [],
    },
  });
  assert.equal(rendered.ok, true, JSON.stringify(rendered));
  const metadata = buildResearchPreviewMetadata({
    outcome: rendered.outcome, startedAt: "2026-11-26T00:00:00.000Z", completedAt: "2026-11-26T00:00:01.000Z",
    stopReason: "report_submitted", citedSources: rendered.citedSources,
  });
  for (const citation of rendered.citations) assert.ok(rendered.content.includes(`](<${citation.url}>)`), citation.url);
  assert.deepEqual(citationsOutsideResearchBody(rendered.citations, metadata), []);
});
