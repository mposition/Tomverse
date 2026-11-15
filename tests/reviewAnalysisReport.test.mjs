import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { ko } from "../locales/ko.ts";
import { makeReviewReportFixture } from "./fixtures/reviewAnalysisReport.ts";
import { buildReviewAnalysisReport, reviewReportLabels, reviewReportSelection, reviewReportFingerprintInput } from "../lib/reviewAnalysisReport.ts";
import { renderDocumentArtifact } from "../lib/generatedArtifactRenderers.ts";

const labels = reviewReportLabels(key => { const [group, name] = key.split("."); return ko[group][name]; });
test("report retains the question, model mapping, full positions, quote status and uncertainty without synthesis", () => {
  const report = buildReviewAnalysisReport(makeReviewReportFixture(), labels);
  for (const text of ["승인 전에 배포해도 될까요?", "Model A", "Model B", "승인 전에는 배포하지", "인용문 미확인", "Unconfirmed quote", "날짜를 별도로 확인", "외부 사실 검증이 아닙니다", "실제 승인 여부 미확인"]) assert.ok(report.text.includes(text), text);
  assert.doesNotMatch(report.text, /PRIVATE_FULL_ANSWER|두 번째 검토자의 별도 견해/);
  assert.match(report.text, /인용 일치는 사실 정확도를 뜻하지 않습니다/);
});
test("selected secondary and Quick Summary are independent projections", () => {
  const source = makeReviewReportFixture(); source.reviewer = "secondary";
  const report = buildReviewAnalysisReport(source, labels);
  assert.match(report.text, /두 번째 검토자의 별도 견해/); assert.equal(report.sections.find(section => section.heading === labels.reviewer).text, "reviewer-b");
  const quick = { ...source, kind: "quick", review: { ...source.review, result: { commonConclusions: source.review.result.primary.result.consensus, importantDifferences: [], modelKeyClaims: [], verificationNeeded: ["Quick unknown"] } } };
  assert.match(buildReviewAnalysisReport(quick, labels).text, /Quick unknown/);
});
test("fingerprint binds exact result, source, selected reviewer and mode; it is not authority", async () => {
  const source = makeReviewReportFixture(); const selection = await reviewReportSelection(source, "ko");
  assert.equal(selection.fingerprint, createHash("sha256").update(reviewReportFingerprintInput(source)).digest("hex"));
  for (const modify of [s => { s.reviewer = "secondary"; }, s => { s.setup.source.question += " changed"; }, s => { s.review.result.primary.result.limitations.push("changed"); }, s => { s.mode = "evidence"; }]) {
    const changed = structuredClone(source); modify(changed); assert.notEqual((await reviewReportSelection(changed, "ko")).fingerprint, selection.fingerprint);
  }
  source.review.persisted = false; assert.throws(() => buildReviewAnalysisReport(source, labels), /UNAVAILABLE/);
});
test("TXT, Markdown and Word contain the complete Unicode report and no active document content", () => {
  const report = buildReviewAnalysisReport(makeReviewReportFixture(), labels);
  for (const format of ["txt", "md", "docx"]) {
    const rendered = renderDocumentArtifact({ ...report.spec, format, filename: `analysis.${format}` });
    const text = format === "docx" ? new TextDecoder().decode(unzipSync(rendered.bytes)["word/document.xml"]) : new TextDecoder().decode(rendered.bytes);
    for (const value of ["승인 전에 배포해도 될까요?", "Do not deploy before approval.", "Unconfirmed quote", "날짜를 별도로 확인하세요.", "외부 사실 검증이 아닙니다."]) assert.ok(text.includes(value), `${format}: ${value}`);
    assert.doesNotMatch(text, /PRIVATE_FULL_ANSWER/);
    if (format === "docx") assert.ok(!Object.keys(unzipSync(rendered.bytes)).some(name => /vbaProject|externalLink|altChunk/i.test(name)));
  }
});
test("PDF opens in an independent reader with Korean question and uncertainty intact", async () => {
  const report = buildReviewAnalysisReport(makeReviewReportFixture(), labels);
  const rendered = renderDocumentArtifact({ ...report.spec, format: "pdf", filename: "analysis.pdf" });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: rendered.bytes, useSystemFonts: false, isEvalSupported: false }).promise;
  let text = "";
  for (let page = 1; page <= document.numPages; page++) text += (await (await document.getPage(page)).getTextContent()).items.map(item => item.str ?? "").join("");
  const compact = text.replace(/\s/g, "");
  for (const value of ["승인 전에 배포해도 될까요?", "Unconfirmed quote", "날짜를 별도로 확인하세요.", "외부 사실 검증이 아닙니다."]) assert.ok(compact.includes(value.replace(/\s/g, "")), value);
});
