import assert from "node:assert/strict";
import test from "node:test";

import { admitDocumentSpec } from "../lib/generatedArtifactCore.ts";
import { renderDocumentPdf } from "../lib/generatedArtifactPdf.ts";
import { loadPdfFont, PDF_FONT_NAME } from "../lib/generatedArtifactFont.ts";

// docs/policy/generated-artifacts.md sections 3 and 4.
//
// The reader here is `pdfjs-dist` -- Mozilla's PDF implementation, which this
// repository already depends on. A PDF that only this writer can read is a PDF
// the user cannot open, and the Korean case is the one that fails silently:
// without an embedded CID font the glyphs come out blank rather than wrong.

const build = (spec) => {
  const admission = admitDocumentSpec(spec);
  assert.equal(admission.ok, true, JSON.stringify(admission));
  return renderDocumentPdf(admission.spec);
};

const REPORT = {
  filename: "분기_보고서.pdf",
  format: "pdf",
  title: "2026년 분기 보고서",
  subtitle: "매출과 비용",
  blocks: [
    { type: "heading", level: 1, text: "요약" },
    {
      type: "paragraph",
      text: "1분기 매출은 1억 2천 5백만 원이며 전년 대비 12% 증가했습니다.",
    },
    { type: "bullets", items: ["국내 성장", "해외 보합"] },
    {
      type: "table",
      columns: ["분기", "매출"],
      rows: [
        ["Q1", 125_000_000],
        ["Q2", 143_500_000],
      ],
    },
    { type: "paragraph", text: "Mixed ASCII and 한글 in one line." },
  ],
};

const readPdf = async (bytes) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
  });
  return task.promise;
};

const textOf = async (bytes) => {
  const document = await readPdf(bytes);
  let text = "";
  for (let page = 1; page <= document.numPages; page += 1) {
    const content = await (await document.getPage(page)).getTextContent();
    text += content.items.map((item) => item.str ?? "").join("");
  }
  await document.cleanup();
  return text;
};

test("the file is a PDF a reader will accept", async () => {
  const bytes = build(REPORT);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  const document = await readPdf(bytes);
  assert.ok(document.numPages >= 1);
  await document.cleanup();
});

test("an independent reader gets the Korean text back, not blanks", async () => {
  const text = await textOf(build(REPORT));
  for (const expected of [
    "2026년 분기 보고서",
    "요약",
    "국내 성장",
    "125000000",
    "Mixed ASCII and 한글 in one line.",
  ]) {
    assert.ok(text.includes(expected), `missing: ${expected}`);
  }
});

test("the font is embedded rather than referenced by name", async () => {
  const document = await readPdf(build(REPORT));
  const page = await document.getPage(1);
  await page.getTextContent();
  const raw = new TextDecoder("latin1").decode(build(REPORT));
  // A Type0 font with an embedded descendant. Without FontFile2 the reader
  // would substitute, and a substitution has no Hangul.
  assert.match(raw, /\/Subtype\s*\/Type0/);
  assert.match(raw, /\/Encoding\s*\/Identity-H/);
  assert.match(raw, /\/FontFile2/);
  assert.match(raw, /\/ToUnicode/);
  await document.cleanup();
});

test("a long paragraph wraps onto more than one page", async () => {
  const bytes = build({
    filename: "long.pdf",
    format: "pdf",
    blocks: Array.from({ length: 120 }, (_, index) => ({
      type: "paragraph",
      text: `${index}번째 문단입니다. 이 문장은 줄바꿈과 페이지 넘김을 만들기 위한 것입니다.`,
    })),
  });
  const document = await readPdf(bytes);
  assert.ok(document.numPages > 1, `expected more than one page`);
  await document.cleanup();
});

test("the subset carries only the glyphs the document uses", () => {
  const font = loadPdfFont();
  assert.ok(PDF_FONT_NAME.length > 0);
  assert.ok(font.unitsPerEm > 0);
  assert.ok(font.numGlyphs > 1000, `${font.numGlyphs} glyphs in the face`);
  // The whole face is far bigger than any one document needs; the point of
  // subsetting is that a two-page report does not ship 12,000 glyphs.
  const small = build({
    filename: "tiny.pdf",
    format: "pdf",
    blocks: [{ type: "paragraph", text: "가" }],
  });
  assert.ok(small.byteLength < 200_000, `${small.byteLength} bytes`);
});

test("the bytes are deterministic, so a replay cannot differ", () => {
  assert.deepEqual(build(REPORT), build(REPORT));
});
