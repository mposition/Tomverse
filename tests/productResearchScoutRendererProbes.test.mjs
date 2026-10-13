import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import {
  RENDERER_PROBES,
  containsHangul,
  pdfEmbedsFontProgram,
  rendererProbeFindings,
  textItemsOutsidePage,
  zipPartNames,
} from "../lib/productResearchScoutRendererProbes.mjs";
import { admitDocumentSpec, admitPresentationSpec, admitWorkbookSpec } from "../lib/generatedArtifactCore.ts";

const admit = { document: admitDocumentSpec, spreadsheet: admitWorkbookSpec, presentation: admitPresentationSpec };

test("every probe specification passes the chat tool's own admission", () => {
  // docs/policy/product-research-agent.md §12: a specification that does not
  // admit is a probe definition error, never a finding.
  assert.deepEqual(
    RENDERER_PROBES.map(({ id }) => id),
    ["pdf.document", "docx.document", "xlsx.workbook", "pptx.presentation"],
  );
  for (const probe of RENDERER_PROBES) {
    const admission = admit[probe.kind](probe.spec);
    assert.equal(admission.ok, true, `${probe.id}: ${admission.code ?? ""} ${admission.detail ?? ""}`);
    assert.equal(admission.spec.format, probe.format, probe.id);
  }
});

test("each probe carries Korean and English and a long word, so RND-03 and line breaking have something to test", () => {
  for (const probe of RENDERER_PROBES) {
    const text = JSON.stringify(probe.spec);
    assert.ok(containsHangul(text), probe.id);
    assert.ok(/[A-Za-z]{20,}/.test(text), probe.id);
  }
});

test("zip parts are read, and a file that is not a zip reads as null", () => {
  const bytes = zipSync({ "[Content_Types].xml": strToU8("<x/>"), "word/document.xml": strToU8("<w/>") });
  assert.deepEqual(zipPartNames(bytes), ["[Content_Types].xml", "word/document.xml"]);
  assert.equal(zipPartNames(strToU8("%PDF-1.7 not a zip")), null);
});

test("a PDF embeds a font program only when a FontFile key is present", () => {
  assert.equal(pdfEmbedsFontProgram(strToU8("<< /Type /FontDescriptor /FontFile2 12 0 R >>")), true);
  assert.equal(pdfEmbedsFontProgram(strToU8("<< /Type /FontDescriptor /FontFile3 12 0 R >>")), true);
  assert.equal(pdfEmbedsFontProgram(strToU8("<< /Type /Font /BaseFont /Helvetica >>")), false);
});

test("text outside the page is counted with a point of slack, and text inside is not", () => {
  const page = { width: 595, height: 842 };
  assert.equal(textItemsOutsidePage([{ x: 72, y: 700, width: 400 }, { x: 0, y: 0, width: 595 }], page), 0);
  assert.equal(textItemsOutsidePage([{ x: 72, y: 700, width: 600 }], page), 1);
  assert.equal(textItemsOutsidePage([{ x: -5, y: 10, width: 10 }], page), 1);
  assert.equal(textItemsOutsidePage([{ x: 10, y: 900, width: 10 }], page), 1);
  assert.equal(textItemsOutsidePage([{ x: 10, y: -0.5, width: 10 }], page), 0);
});

test("the structural verdict names each RND rule only for its own failure", () => {
  const [pdf, docx] = RENDERER_PROBES;
  const goodPdf = { byteLength: 120_000, pages: 6, hangulInText: true, embedsFont: true, outsidePage: 0 };
  assert.deepEqual(rendererProbeFindings(pdf, goodPdf), []);
  assert.deepEqual(rendererProbeFindings(pdf, { ...goodPdf, embedsFont: false }), ["RND-03"]);
  assert.deepEqual(rendererProbeFindings(pdf, { ...goodPdf, hangulInText: false }), ["RND-03"]);
  assert.deepEqual(rendererProbeFindings(pdf, { ...goodPdf, outsidePage: 3 }), ["RND-04"]);
  assert.deepEqual(rendererProbeFindings(pdf, { ...goodPdf, pages: 1 }), ["RND-05"]);
  assert.deepEqual(rendererProbeFindings(pdf, { ...goodPdf, byteLength: 10 }), ["RND-05"]);

  const goodDocx = { byteLength: 4_400, parts: ["[Content_Types].xml", "word/document.xml", "word/styles.xml"] };
  assert.deepEqual(rendererProbeFindings(docx, goodDocx), []);
  assert.deepEqual(rendererProbeFindings(docx, { ...goodDocx, parts: ["[Content_Types].xml"] }), ["RND-02"]);
  assert.deepEqual(rendererProbeFindings(docx, { ...goodDocx, parts: null }), ["RND-02"]);
});
