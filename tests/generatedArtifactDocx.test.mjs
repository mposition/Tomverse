import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { unzipSync } from "fflate";

import { admitDocumentSpec } from "../lib/generatedArtifactCore.ts";
import { renderDocumentDocx } from "../lib/generatedArtifactDocx.ts";

// docs/policy/generated-artifacts.md sections 3 and 4.
//
// Two readers again, for the reason the workbook tests give: the XML
// assertions check what this writer meant, and `officeparser` -- which knows
// nothing about this code -- checks that a reader can open the package and get
// the words back.

const require = createRequire(import.meta.url);
const { OfficeParser } = require("officeparser");

const decode = (bytes) => new TextDecoder().decode(bytes);

const build = (spec) => {
  const admission = admitDocumentSpec(spec);
  assert.equal(admission.ok, true, JSON.stringify(admission));
  return renderDocumentDocx(admission.spec);
};

const REPORT = {
  filename: "분기_보고서.docx",
  format: "docx",
  title: "2026년 분기 보고서",
  subtitle: "매출과 비용",
  blocks: [
    { type: "heading", level: 1, text: "요약" },
    { type: "paragraph", text: "1분기 매출은 1억 2천 5백만 원입니다." },
    { type: "bullets", items: ["국내 성장", "해외 보합"] },
    { type: "numbers", items: ["예산 확정", "채용 개시"] },
    { type: "quote", text: "숫자는 확정 전 수치입니다." },
    { type: "code", language: "sql", text: "SELECT 1;" },
    {
      type: "table",
      columns: ["분기", "매출"],
      rows: [
        ["Q1", 125_000_000],
        ["Q2", 143_500_000],
      ],
    },
    { type: "divider" },
    { type: "pageBreak" },
    { type: "paragraph", text: "끝." },
  ],
};

test("the package holds every part Word requires", () => {
  const files = unzipSync(build(REPORT));
  for (const part of [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/styles.xml",
    "word/numbering.xml",
    "word/_rels/document.xml.rels",
    "docProps/core.xml",
  ]) {
    assert.ok(files[part], `missing ${part}`);
  }
});

test("an independent reader gets the words back", async () => {
  const document = await OfficeParser.parseOffice(Buffer.from(build(REPORT)), {
    extractAttachments: false,
    ocr: false,
  });
  const text = document.toText();
  for (const expected of [
    "2026년 분기 보고서",
    "요약",
    "1분기 매출은 1억 2천 5백만 원입니다.",
    "국내 성장",
    "예산 확정",
    "SELECT 1;",
    "125000000",
  ]) {
    assert.ok(text.includes(expected), `missing: ${expected}`);
  }
});

test("every paragraph names a style the stylesheet defines", () => {
  const files = unzipSync(build(REPORT));
  const document = decode(files["word/document.xml"]);
  const styles = decode(files["word/styles.xml"]);
  const used = [...document.matchAll(/w:pStyle w:val="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const style of new Set(used)) {
    assert.ok(
      styles.includes(`w:styleId="${style}"`),
      `style ${style} is used but not defined`
    );
  }
});

test("a table header row is marked as one so it repeats across pages", () => {
  const document = decode(unzipSync(build(REPORT))["word/document.xml"]);
  assert.match(document, /<w:tblHeader\/>/);
});

// The same rule the workbook writer follows: this application does not
// generate anything that runs, links out or pulls remote data.
test("nothing in the document is an external link or a field", () => {
  const files = unzipSync(build(REPORT));
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    const xml = decode(bytes);
    assert.ok(!xml.includes("<w:fldChar"), `${name} carries a field`);
    assert.ok(!xml.includes("hyperlink"), `${name} carries a hyperlink`);
    assert.ok(!/https?:\/\/(?!schemas|purl)/.test(xml), `${name} carries a URL`);
  }
});

test("text that would break the XML is escaped, not dropped", () => {
  const document = decode(
    unzipSync(
      build({
        filename: "escape.docx",
        format: "docx",
        blocks: [{ type: "paragraph", text: "<b> & \"quote\" & 'tick'" }],
      })
    )["word/document.xml"]
  );
  assert.ok(document.includes("&lt;b&gt; &amp;"));
  assert.ok(!document.includes("<b>"));
});

test("an empty document is refused before a file exists", () => {
  const admission = admitDocumentSpec({
    filename: "empty.docx",
    format: "docx",
    blocks: [],
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.code, "SCHEMA_INVALID");
});

test("a table row wider than its columns is refused rather than truncated", () => {
  const admission = admitDocumentSpec({
    filename: "wide.docx",
    format: "docx",
    blocks: [
      { type: "table", columns: ["A", "B"], rows: [["1", "2", "3"]] },
    ],
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.code, "ROW_WIDER_THAN_COLUMNS");
});

test("a short table row is padded so every writer sees a rectangle", () => {
  const admission = admitDocumentSpec({
    filename: "short.docx",
    format: "docx",
    blocks: [{ type: "table", columns: ["A", "B", "C"], rows: [["1"]] }],
  });
  assert.equal(admission.ok, true);
  assert.deepEqual(admission.spec.blocks[0].rows[0], ["1", null, null]);
});

test("the bytes are deterministic, so a replay cannot differ", () => {
  assert.deepEqual(build(REPORT), build(REPORT));
});
