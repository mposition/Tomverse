import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  createResearchEvidenceRegistry,
  researchPreviewReportSchema,
  researchReportSchemaRejection,
  validateAndRenderResearchReport,
} from "../lib/researchPreviewReport.ts";

const batch = (start = 1) => ({
  status: "ok", searchesRemaining: 0,
  results: Array.from({ length: 5 }, (_, index) => ({
    title: `Source ${start + index}`,
    url: `https://example.com/source/${start + index}`,
    snippet: `Public extract ${start + index}`,
  })),
});
const report = (sourceIds = ["R1"], status = "complete") => ({
  status, summary: "A bounded public comparison.",
  findings: [{ heading: "Findings", statements: [{ text: "A source states this.", sourceIds, kind: "fact" }] }],
  contradictions: [], limitations: ["Only search excerpts were available."],
  nextQuestions: ["What changed since the source was published?"],
});

test("rejection diagnostics distinguish schema and unread page citations without retaining report text", () => {
  const registry = createResearchEvidenceRegistry();
  registry.addToolResult(batch());
  const secret = "private-marker-must-not-be-logged";
  const malformed = { ...report(), summary: secret, [secret]: secret };
  const schemaDiagnostic = researchReportSchemaRejection(malformed);
  assert.deepEqual(schemaDiagnostic, { code: "schema_invalid", issues: [{ code: "unrecognized_keys", path: [] }] });
  assert.equal(JSON.stringify(schemaDiagnostic).includes(secret), false);
  const pageReport = report();
  pageReport.findings[0].statements[0].evidenceLevel = "page_text";
  let diagnostic;
  assert.deepEqual(validateAndRenderResearchReport({ report: pageReport, registry,
    allowedSourceIds: registry.sourceIds(), onRejected: value => { diagnostic = value; } }),
  { ok: false, reason: "invalid_report" });
  assert.deepEqual(diagnostic, { code: "page_text_source_unread" });
  assert.equal(researchReportSchemaRejection(report()), null);
});

test("stable registry covers all 25 model-visible sources and citations renumber the last ten", () => {
  const registry = createResearchEvidenceRegistry();
  for (const start of [1, 6, 11, 16, 21]) {
    const output = registry.addToolResult(batch(start));
    assert.equal(output.results[0].sourceId, `R${start}`);
  }
  registry.addToolResult(batch(26));
  assert.equal(registry.snapshot().length, 25);
  const ids = Array.from({ length: 10 }, (_, index) => `R${16 + index}`);
  const result = validateAndRenderResearchReport({ report: report(ids), registry, allowedSourceIds: registry.sourceIds() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.citations.map((citation) => citation.referenceNumber), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(result.citations[9].url, "https://example.com/source/25");
  assert.match(result.content, /\[10\]\(<https:\/\/example.com\/source\/25>\)/);
});

test("duplicates reuse IDs and unsafe URLs never enter evidence", () => {
  const registry = createResearchEvidenceRegistry();
  registry.addToolResult(batch());
  const duplicate = registry.addToolResult(batch());
  assert.equal(duplicate.results[0].sourceId, "R1");
  const output = registry.addToolResult({ status: "ok", searchesRemaining: 0, results: [
    { title: "Unsafe", url: "javascript:alert(1)" },
    { title: "Unsafe", url: "https://example.com/<bad>" },
  ] });
  assert.equal(output.results.length, 1); // URL normalisation percent-encodes unsafe path bytes.
  assert.equal(registry.snapshot().length, 6);
});

test("registry returns the same bounded excerpt it persists, including repeated URLs", () => {
  const registry = createResearchEvidenceRegistry();
  const first = registry.addToolResult({ status: "ok", searchesRemaining: 4,
    results: [{ title: "Title", url: "https://example.com/page", snippet: "x".repeat(900) }] });
  assert.ok(first.results[0].snippet.length <= 400);
  assert.equal(first.results[0].snippet, registry.snapshot()[0].snippet);
  const repeated = registry.addToolResult({ status: "ok", searchesRemaining: 3,
    results: [{ title: "Changed", url: "https://example.com/page", snippet: "later text" }] });
  assert.deepEqual(repeated.results[0], first.results[0]);
});

test("a terminal cannot cite IDs discovered in the same model step", () => {
  const registry = createResearchEvidenceRegistry();
  registry.addToolResult(batch());
  const beforeStep = registry.sourceIds();
  registry.addToolResult(batch(6));
  const result = validateAndRenderResearchReport({ report: report(["R6"]), registry, allowedSourceIds: beforeStep });
  assert.deepEqual(result, { ok: false, reason: "unknown_source" });
  assert.deepEqual(validateAndRenderResearchReport({ report: report(["R25"]), registry, allowedSourceIds: registry.sourceIds() }), { ok: false, reason: "unknown_source" });
});

test("more than 15 distinct cited sources is refused rather than silently dropping links", () => {
  const registry = createResearchEvidenceRegistry();
  for (const start of [1,6,11,16]) registry.addToolResult(batch(start));
  const input = report();
  input.findings[0].statements = [
    { text: "First.", sourceIds: Array.from({ length: 10 }, (_, index) => `R${index+1}`), kind: "fact" },
    { text: "Second.", sourceIds: Array.from({ length: 6 }, (_, index) => `R${index+11}`), kind: "fact" },
  ];
  assert.deepEqual(validateAndRenderResearchReport({ report: input, registry, allowedSourceIds: registry.sourceIds() }), { ok: false, reason: "too_many_sources" });
});

test("valid partial and insufficient evidence are distinct from ungrounded success or truncated JSON", () => {
  const registry = createResearchEvidenceRegistry();
  assert.deepEqual(validateAndRenderResearchReport({ report: report([]), registry, allowedSourceIds: [] }), { ok: false, reason: "insufficient_evidence" });
  const insufficient = { ...report([], "insufficient_evidence"), findings: [] };
  assert.equal(validateAndRenderResearchReport({ report: insufficient, registry, allowedSourceIds: [] }).outcome, "insufficient_evidence");
  assert.equal(researchPreviewReportSchema.safeParse('{"status":"complete"').success, false);
  assert.equal(researchPreviewReportSchema.safeParse({ ...insufficient, fabricatedUrl: "https://wrong.example" }).success, false);
  registry.addToolResult(batch());
  assert.equal(validateAndRenderResearchReport({ report: report(["R1"], "partial"), registry, allowedSourceIds: registry.sourceIds() }).outcome, "partial");
});

test("server report headings and snippet limitation follow the requested display locale", () => {
  const registry = createResearchEvidenceRegistry();
  registry.addToolResult(batch());
  const result = validateAndRenderResearchReport({ report: report(), registry,
    allowedSourceIds: registry.sourceIds(), locale: "ko-KR" });
  assert.equal(result.ok, true);
  assert.match(result.content, /### 한계/);
  assert.match(result.content, /### 출처/);
  assert.match(result.content, /페이지 전문을 읽지 않았으며/);
});

test("model Markdown, HTML, autolinks and reference links cannot add unverified anchors", () => {
  const registry = createResearchEvidenceRegistry();
  registry.addToolResult(batch());
  const attacks = '[fake](https://fake.example) ![image](https://image.example) <https://auto.example> https://bare.example www.bare.example [x][ref]\n[ref]: https://ref.example <a href="https://html.example">click</a> &#91;encoded&#93;(https://entity.example) person@evil.example';
  const input = report();
  input.summary = attacks;
  input.findings[0].heading = "[fake](https://heading.example)";
  input.findings[0].statements[0].text = attacks;
  input.limitations = [attacks];
  input.nextQuestions = ["Visit https://question.example?"];
  const result = validateAndRenderResearchReport({ report: input, registry, allowedSourceIds: registry.sourceIds() });
  assert.equal(result.ok, true);
  // React's client SSR entry must run without the react-server condition used
  // by this suite's server-only search adapter imports.
  const html = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import Markdown from 'react-markdown';
    import gfm from 'remark-gfm';
    let content=''; for await(const chunk of process.stdin) content+=chunk;
    process.stdout.write(renderToStaticMarkup(React.createElement(Markdown,{remarkPlugins:[gfm]},content)));
  `], { input: result.content, encoding: "utf8", cwd: new URL("..", import.meta.url) });
  const anchors = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(anchors, ["https://example.com/source/1", "https://example.com/source/1"]);
  assert.equal(/<img\b/.test(html), false);
  assert.match(html, /The full pages were not read/);
  assert.ok(result.content.trim()); // A tool-only model final has complete server content.
});
