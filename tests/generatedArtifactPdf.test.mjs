import assert from "node:assert/strict";
import test from "node:test";

import { admitDocumentSpec } from "../lib/generatedArtifactCore.ts";
import { renderDocumentPdf } from "../lib/generatedArtifactPdf.ts";
import { glyphFor, loadPdfFont, PDF_FONT_NAME } from "../lib/generatedArtifactFont.ts";

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

for (const kind of ["paragraph", "table"]) {
  for (const suffix of ["s", "s."]) {
    test(`${kind} avoids a one/two-character forced word tail (${suffix})`, async () => {
      const font = loadPdfFont();
      const size = kind === "table" ? 9.5 : 10.5;
      const width = kind === "table" ? (595.28 - 112) / 3 - 8 : 595.28 - 112;
      const advance = font.advances[glyphFor(font, "W".codePointAt(0))] * size / font.unitsPerEm;
      const word = "W".repeat(Math.floor(width / advance) * 2) + suffix;
      const block = kind === "table"
        ? { type: "table", columns: ["Item", "Description", "Amount"], rows: [["A", word, 0]] }
        : { type: "paragraph", text: word };
      const document = await readPdf(build({ filename: "word-tail.pdf", format: "pdf", blocks: [block] }));
      const content = await (await document.getPage(1)).getTextContent();
      const lines = content.items.filter(item => /^[Ws.]+$/.test(item.str ?? ""));
      assert.ok(lines.length >= 2);
      assert.equal(lines.map(line => line.str).join(""), word);
      assert.ok(lines.at(-1).str.length >= 3, JSON.stringify(lines.map(line => line.str)));
      for (const line of lines) {
        assert.ok(line.width <= width + 0.1);
        assert.ok(line.transform[4] >= 56);
        assert.ok(line.transform[4] + line.width <= 595.28 - 56 + 0.1);
      }
      await document.cleanup();
    });
  }
}

test("forced tail balancing never overflows a very narrow table cell", async () => {
  const word = "W".repeat(40) + "s";
  const document = await readPdf(build({ filename: "narrow.pdf", format: "pdf", blocks: [{
    type: "table", columns: Array.from({ length: 20 }, () => ""), rows: [[word]],
  }] }));
  const content = await (await document.getPage(1)).getTextContent();
  const lines = content.items.filter(item => /^[Ws]+$/.test(item.str ?? ""));
  assert.equal(lines.map(line => line.str).join(""), word);
  for (const line of lines) assert.ok(line.width <= (595.28 - 112) / 20 - 8 + 0.1);
  await document.cleanup();
});

test("a report title is not repeated by an identical opening heading", async () => {
  const title = "2026년 1분기 국내 커피 프랜차이즈 시장 요약";
  const text = await textOf(build({
    filename: "summary.pdf",
    format: "pdf",
    title,
    subtitle: "예시 시장 보고서",
    blocks: [
      { type: "heading", level: 1, text: title },
      { type: "paragraph", text: "시장 동향과 매출을 정리합니다." },
    ],
  }));
  assert.equal(text.split(title).length - 1, 1);
  assert.ok(text.includes("예시 시장 보고서"));
  assert.ok(text.includes("시장 동향과 매출을 정리합니다."));
});

test("Korean report title words do not leave an isolated final syllable", async () => {
  const title = "2026년 1분기 국내 커피 프랜차이즈 시장 요약";
  const document = await readPdf(build({
    filename: "title.pdf", format: "pdf", title,
    blocks: [{ type: "heading", level: 1, text: title }],
  }));
  const content = await (await document.getPage(1)).getTextContent();
  const lines = content.items.filter(item => "str" in item).map(item => item.str.trim()).filter(Boolean);
  assert.ok(lines.join("").replaceAll(" ", "").includes(title.replaceAll(" ", "")));
  assert.ok(lines.every(line => line.length > 1), JSON.stringify(lines));
  assert.ok(lines.some(line => line.includes("시장 요약")), JSON.stringify(lines));
  await document.cleanup();
});

test("matching headings later in a document remain part of its content", async () => {
  const title = "시장 요약";
  const text = await textOf(build({
    filename: "sections.pdf", format: "pdf", title,
    blocks: [
      { type: "paragraph", text: "Overview" },
      { type: "heading", level: 1, text: title },
    ],
  }));
  assert.equal(text.split(title).length - 1, 2);
});

test("weighted PDF tables give descriptions space without changing values or crossing the page margin", async () => {
  const spec = { filename: "table.pdf", format: "pdf", blocks: [{
    type: "table", columns: ["Item", "Description", "Amount"],
    rows: [["A1", "Interoperability documentation and implementation", "$25"]],
  }] };
  const positions = async (value) => {
    const document = await readPdf(build(value));
    const content = await (await document.getPage(1)).getTextContent();
    const items = content.items.filter(item => "str" in item && item.str.trim());
    for (const item of items) {
      assert.ok(item.transform[4] >= 56 - 0.1);
      assert.ok(item.transform[4] + item.width <= 595.28 - 56 + 0.1);
    }
    await document.cleanup();
    return items;
  };
  const equal = await positions(spec);
  const weighted = await positions({ ...spec, blocks: [{ ...spec.blocks[0], pdfColumnWeights: [1, 4, 1] }] });
  const x = (items, value) => items.find(item => item.str === value).transform[4];
  assert.ok(x(weighted, "Description") < x(equal, "Description"));
  assert.ok(x(weighted, "Amount") > x(equal, "Amount"));
  assert.ok(weighted.some(item => item.str.includes("Interoperability")), "long word remains whole");
  const dataLines = items => new Set(items.filter(item => item.transform[5] < items[0].transform[5]).map(item => item.transform[5])).size;
  assert.ok(dataLines(weighted) < dataLines(equal));
  const text = weighted.map(item => item.str).join(" ");
  for (const value of ["A1", "Interoperability", "documentation", "implementation", "$25"]) assert.ok(text.includes(value));
});

test("PDF table weights reject incomplete, nonpositive, unbounded and nonfinite input", () => {
  for (const weights of [[1], [1, 0], [1, 21], [1, Infinity], [1, NaN]]) {
    const admission = admitDocumentSpec({ filename: "table.pdf", format: "pdf", blocks: [{
      type: "table", columns: ["A", "B"], rows: [["a", "b"]], pdfColumnWeights: weights,
    }] });
    assert.equal(admission.ok, false, JSON.stringify(weights));
    assert.equal(admission.code, "SCHEMA_INVALID");
  }
});
