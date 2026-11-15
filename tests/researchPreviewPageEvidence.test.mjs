import assert from "node:assert/strict";
import test from "node:test";
import { createResearchEvidenceRegistry, validateAndRenderResearchReport } from "../lib/researchPreviewReport.ts";
import { buildResearchPreviewMetadata, parseResearchPreviewMetadata, researchPreviewExportFields } from "../lib/researchPreviewMetadata.ts";
import { researchPageReadResultSchema } from "../lib/researchPreviewPageEvidence.ts";

function evidence() {
  const registry = createResearchEvidenceRegistry();
  registry.addToolResult({ status: "ok", searchesRemaining: 4, results: [{
    title: "Public source", url: "https://public.example.com/article", snippet: "The original search excerpt.",
  }] }, "2026-11-15T00:00:00Z");
  return registry;
}
const page = (extra = {}) => ({ sourceId: "R1", url: "https://public.example.com/article",
  status: "read", readAt: "2026-11-15T00:01:00Z", truncated: false,
  contentType: "text/html", content: "<html>RAW_PAGE_CHECKPOINT_ONLY</html>", ...extra });
const report = (evidenceLevel) => ({ status: "partial", summary: "A limited report.",
  findings: [{ heading: "Finding", statements: [{ text: "A fact from the public source.", sourceIds: ["R1"], kind: "fact",
    ...(evidenceLevel ? { evidenceLevel } : {}) }] }], contradictions: [], limitations: ["Bounded sources only."], nextQuestions: [] });
const render = (registry, allowedEvidenceSources, evidenceLevel) => validateAndRenderResearchReport({
  registry, allowedSourceIds: ["R1"], allowedEvidenceSources, report: report(evidenceLevel), locale: "en",
});
const metadata = (sources) => buildResearchPreviewMetadata({ outcome: "partial", startedAt: "2026-11-15T00:00:00Z",
  completedAt: "2026-11-15T00:02:00Z", stopReason: "report_submitted", citedSources: sources });

test("strict checkpoint restore preserves stable IDs and rejects raw fields, duplicate URLs or fabricated order", () => {
  const registry = evidence();
  registry.recordPageRead("R1", page());
  const restored = createResearchEvidenceRegistry(registry.snapshot());
  assert.deepEqual(restored.snapshot(), registry.snapshot());
  assert.equal(restored.snapshot()[0].snippet, "The original search excerpt.");
  assert.equal(JSON.stringify(restored.snapshot()).includes("RAW_PAGE_CHECKPOINT_ONLY"), false);
  for (const checkpoint of [
    [{ ...registry.snapshot()[0], sourceId: "R2" }],
    [registry.snapshot()[0], { ...registry.snapshot()[0], sourceId: "R2" }],
    [{ ...registry.snapshot()[0], url: "javascript:alert(1)" }],
    [{ ...registry.snapshot()[0], content: "private raw body" }],
  ]) assert.throws(() => createResearchEvidenceRegistry(checkpoint));
  assert.throws(() => registry.recordPageRead("R1", page({ sourceId: "R2" })));
  assert.throws(() => registry.recordPageRead("R1", page({ url: "https://different.example.com" })));
});

test("same-step page reads cannot upgrade terminal claims or public evidence before the model reads them", () => {
  const registry = evidence();
  const beforeStep = registry.snapshot();
  registry.recordPageRead("R1", page());
  assert.equal(beforeStep[0].pageRead, undefined);
  assert.deepEqual(render(registry, [{ ...beforeStep[0], url: "https://fake.example.com" }]), { ok: false, reason: "unknown_source" });
  assert.deepEqual(render(registry, beforeStep, "page_text"), { ok: false, reason: "invalid_report" });
  const snippets = render(registry, beforeStep);
  assert.equal(snippets.ok, true); assert.equal(metadata(snippets.citedSources).version, 1);
  const afterStep = registry.snapshot();
  const pages = render(registry, afterStep, "page_text");
  assert.equal(pages.ok, true);
  assert.equal(metadata(pages.citedSources).evidenceLevel, "search_snippets_and_pages");
  registry.recordPageRead("R1", page({ truncated: true }));
  assert.equal(afterStep[0].pageRead.truncated, false, "snapshots cannot be mutated by later read outcomes");
});

test("v2 public metadata and exports contain curated page status and only cited short search excerpts", () => {
  const registry = evidence();
  registry.recordPageRead("R1", page({ truncated: true }));
  const rendered = render(registry, registry.snapshot(), "page_text");
  assert.equal(rendered.ok, true);
  const result = metadata(rendered.citedSources);
  assert.equal(result.version, 2); assert.equal(result.evidenceLevel, "search_snippets_and_pages");
  assert.equal(result.sources[0].pageRead.truncated, true);
  assert.equal(result.sources[0].excerpt, "The original search excerpt.");
  assert.match(rendered.content, /clipped/);
  const injected = { ...result, sources: [{ ...result.sources[0], pageRead: { ...result.sources[0].pageRead,
    content: "RAW_PAGE_CHECKPOINT_ONLY", finalUrl: "https://private.example.com", headers: { authorization: "secret" } } }] };
  const exported = researchPreviewExportFields({ research: injected });
  assert.deepEqual(exported.research, result);
  assert.doesNotMatch(JSON.stringify(exported), /RAW_PAGE_CHECKPOINT_ONLY|private.example.com|authorization/);
  assert.deepEqual(parseResearchPreviewMetadata(JSON.parse(JSON.stringify(result))), result);
});

test("an unavailable page never becomes a full-page claim and preserves the search snippet fallback", () => {
  const registry = evidence();
  registry.recordPageRead("R1", { sourceId: "R1", url: "https://public.example.com/article",
    status: "unavailable", readAt: "2026-11-15T00:01:00Z", truncated: false, reason: "response_too_large" });
  const rendered = render(registry, registry.snapshot());
  const result = metadata(rendered.citedSources);
  assert.equal(result.version, 2); assert.equal(result.evidenceLevel, "search_snippets");
  assert.equal(result.sources[0].pageRead.status, "unavailable");
  assert.match(rendered.content, /could not be read/);
  assert.deepEqual(render(registry, registry.snapshot(), "page_text"), { ok: false, reason: "invalid_report" });
  assert.equal(parseResearchPreviewMetadata({ ...result, evidenceLevel: "search_snippets_and_pages" }), null);
});

test("active page checkpoints enforce bounded content and closed read states", () => {
  assert.equal(researchPageReadResultSchema.safeParse(page()).success, true);
  assert.equal(researchPageReadResultSchema.safeParse(page({ content: "x".repeat(12001) })).success, false);
  assert.equal(researchPageReadResultSchema.safeParse(page({ credentials: "secret" })).success, false);
  assert.equal(researchPageReadResultSchema.safeParse({ ...page(), status: "unavailable", reason: "network_error" }).success, false);
});
