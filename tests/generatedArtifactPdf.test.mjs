import assert from "node:assert/strict";
import test from "node:test";

import { admitDocumentSpec } from "../lib/generatedArtifactCore.ts";
import {
  PDF_MAX_REPLACED_SHARE,
  PdfGenerationError,
  describePdfReplacements,
  renderDocumentPdf,
  renderDocumentPdfWithReport,
} from "../lib/generatedArtifactPdf.ts";
import { glyphFor, loadPdfFont, PDF_FONT_NAME } from "../lib/generatedArtifactFont.ts";
import { renderArchiveArtifact, renderDocumentArtifact } from "../lib/generatedArtifactRenderers.ts";

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

test("explicit PDF number columns group numbers, preserve zero and align right edges", async () => {
  const spec = { filename: "amounts.pdf", format: "pdf", blocks: [{
    type: "table", columns: ["Item", "Amount"], pdfNumberColumns: [1],
    rows: [["Zero", 0], ["Small", 1250], ["Large", 10000], ["Refund", -1250.25], ["Identifier", "001250"]],
  }] };
  const document = await readPdf(build(spec));
  const content = await (await document.getPage(1)).getTextContent();
  const values = ["0", "1,250", "10,000", "-1,250.25", "001250"];
  const edges = values.map(value => {
    const item = content.items.find(item => item.str === value);
    assert.ok(item, `missing exact value ${value}`);
    assert.ok(item.transform[4] >= 56);
    return item.transform[4] + item.width;
  });
  assert.ok(Math.max(...edges) - Math.min(...edges) < 0.05, JSON.stringify(edges));
  assert.ok(Math.abs(edges[0] - (595.28 - 56 - 4)) < 0.05);
  await document.cleanup();
  const original = await textOf(build({ ...spec, blocks: [{ ...spec.blocks[0], pdfNumberColumns: undefined }] }));
  assert.ok(original.includes("1250"));
  assert.ok(!original.includes("1,250"));
});

test("PDF number column indices are bounded, integral and unique", () => {
  for (const pdfNumberColumns of [[-1], [2], [0.5], [0, 0], [Infinity]]) {
    assert.equal(admitDocumentSpec({ filename: "amounts.pdf", format: "pdf", blocks: [{
      type: "table", columns: ["Item", "Amount"], rows: [["A", 0]], pdfNumberColumns,
    }] }).ok, false, JSON.stringify(pdfNumberColumns));
  }
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

for (const kind of ["paragraph", "table"]) {
  test(`${kind} keeps Korean sentence punctuation with its preceding syllable`, async () => {
    const font = loadPdfFont();
    const size = kind === "table" ? 9.5 : 10.5;
    const width = kind === "table" ? (595.28 - 112) / 3 - 8 : 595.28 - 112;
    const advance = font.advances[glyphFor(font, "가".codePointAt(0))] * size / font.unitsPerEm;
    for (const punctuation of [".", "!", "?", ")"]) {
      const text = "가".repeat(Math.floor(width / advance) - 1) + "다" + punctuation + " 1분기 확정 시장 규모는 별도로 확인한다.";
      const block = kind === "table"
        ? { type: "table", columns: ["Note", "Value", "Other"], rows: [[text, "", ""]] }
        : { type: "paragraph", text };
      const document = await readPdf(build({ filename: "punctuation.pdf", format: "pdf", blocks: [block] }));
      const content = await (await document.getPage(1)).getTextContent();
      const lines = content.items.filter(item => item.str?.trim()).map(item => item.str.trim());
      assert.ok(lines.every(line => !/^[.!?)]/u.test(line)), JSON.stringify(lines));
      assert.ok(lines.join("").replace(/\s/gu, "").includes(text.replace(/\s/gu, "")));
      for (const item of content.items.filter(item => item.str?.includes("가"))) assert.ok(item.width <= width + 0.1);
      await document.cleanup();
    }
  });
}

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

/* -------------------------------------------------------------------------- */
/* Characters the font has no glyph for                                         */
/* -------------------------------------------------------------------------- */

const paragraphs = (...texts) => ({
  filename: "text.pdf",
  format: "pdf",
  blocks: texts.map((text) => ({ type: "paragraph", text })),
});

const report = (spec) => {
  const admission = admitDocumentSpec(spec);
  assert.equal(admission.ok, true, JSON.stringify(admission));
  return renderDocumentPdfWithReport(admission.spec);
};

test("hanja, kana and the symbols Korean documents use are drawn, not refused", async () => {
  const lines = [
    "甲은 乙에게 丙의 권리를 양도한다. 契約書 第1條 丁",
    "㈜톰버스 ㈱ ㎡ ℃ ㎏ ① ② ⑩ ★ ☆ ✓ α β γ Ω № ™",
    "ひらがな カタカナ ハングル",
    "这个们说时为经发还问现东书 對應處理變數",
    "├── src │ └── lib",
  ];
  const result = report(paragraphs(...lines));
  assert.equal(result.replacedCount, 0, JSON.stringify(result.replaced));
  assert.deepEqual(result.replaced, []);
  assert.equal(describePdfReplacements(result), null);
  const text = await textOf(result.bytes);
  for (const line of lines) {
    // pdfjs hands back each wrapped piece; spaces are not worth comparing.
    assert.ok(text.replace(/\s/gu, "").includes(line.replace(/\s/gu, "")), `missing: ${line}`);
  }
});

test("the font covers the legacy standards Korean, Chinese and Japanese text is written to", () => {
  const font = loadPdfFont();
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const ideographsOf = (label, leads, trails) => {
    const decoder = new TextDecoder(label, { fatal: true });
    const found = new Set();
    for (const lead of leads) {
      for (const trail of trails) {
        let character;
        try {
          character = decoder.decode(Uint8Array.of(lead, trail));
        } catch {
          continue;
        }
        const code = character.codePointAt(0);
        if ([...character].length === 1 && ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff))) {
          found.add(code);
        }
      }
    }
    return found;
  };
  const standards = {
    "GB 2312": [ideographsOf("gbk", range(0xb0, 0xf7), range(0xa1, 0xfe)), 0],
    "Big5 level 1": [ideographsOf("big5", range(0xa4, 0xc6), [...range(0x40, 0x7e), ...range(0xa1, 0xfe)]), 0],
    "JIS X 0208": [
      ideographsOf("shift_jis", [...range(0x88, 0x9f), ...range(0xe0, 0xea)], [...range(0x40, 0x7e), ...range(0x80, 0xfc)]),
      0,
    ],
    // Two KS X 1001 hanja are in neither Noto Sans KR nor Noto Sans SC.
    "KS X 1001 hanja": [ideographsOf("euc-kr", range(0xca, 0xfd), range(0xa1, 0xfe)), 2],
  };
  for (const [name, [codes, allowedMissing]] of Object.entries(standards)) {
    assert.ok(codes.size > 3_000, `${name}: ${codes.size} characters`);
    const missing = [...codes].filter((code) => glyphFor(font, code) === null);
    assert.ok(missing.length <= allowedMissing, `${name} is missing ${missing.length}: ${missing.slice(0, 8).map((code) => code.toString(16))}`);
  }
  for (const [label, from, to] of [
    ["Hangul syllables", 0xac00, 0xd7a3],
    ["Hiragana", 0x3041, 0x3093],
    ["Katakana", 0x30a1, 0x30f6],
    ["Greek", 0x391, 0x3a9],
    ["Cyrillic", 0x410, 0x44f],
    ["circled numbers", 0x2460, 0x2473],
    ["box drawing", 0x2500, 0x257f],
  ]) {
    const missing = range(from, to).filter((code) => glyphFor(font, code) === null && ![0x3a2, 0x30fb].includes(code));
    assert.deepEqual(missing, [], label);
  }
  // The replacement box itself must exist, or "replaced" would draw .notdef.
  assert.notEqual(glyphFor(font, 0x25a1), null);
});

test("an unsupported character becomes a box and is reported, not fatal", async () => {
  const result = report(paragraphs("프로젝트 완료 보고서입니다 🚀 배포가 끝났습니다 🚀🚀 모든 항목이 정상입니다 😀"));
  assert.equal(result.replacedCount, 4);
  assert.deepEqual(
    result.replaced.map(({ character, count }) => [character, count]),
    [["🚀", 3], ["😀", 1]]
  );
  const text = await textOf(result.bytes);
  assert.ok(text.includes("보고서입니다 □ 배포가 끝났습니다 □□ 모든 항목이 정상입니다 □"), text);
  assert.ok(!text.includes("🚀"));
  const notice = describePdfReplacements(result);
  assert.match(notice, /^The PDF font has no glyph for 4 characters of this document \(🚀x3 😀\), so each is drawn as a box/);
  assert.match(notice, /docx/i);
  assert.match(
    describePdfReplacements({ ...result, replacedCount: 1, replaced: [result.replaced[1]] }),
    /^The PDF font has no glyph for 1 character of this document \(😀\), so it is drawn as a box/
  );
});

test("a replaced character does not break the layout or the text around it", async () => {
  const spec = {
    filename: "boxes.pdf",
    format: "pdf",
    title: "제목 🎉",
    blocks: [
      { type: "bullets", items: ["첫째 🎉", "둘째"] },
      { type: "table", columns: ["항목 🎉", "값"], rows: [["가", 1], ["🎉 나", 2]] },
      { type: "paragraph", text: "본문 내용이 이어집니다 🎉 ".repeat(40) },
    ],
  };
  const result = report(spec);
  assert.equal(result.replacedCount, 44);
  const document = await readPdf(result.bytes);
  const content = await (await document.getPage(1)).getTextContent();
  for (const item of content.items.filter((item) => item.str?.trim())) {
    assert.ok(item.transform[4] >= 56 - 0.1);
    assert.ok(item.transform[4] + item.width <= 595.28 - 56 + 0.1, `${item.str} overflows`);
  }
  await document.cleanup();
  const text = await textOf(result.bytes);
  for (const expected of ["제목 □", "첫째 □", "둘째", "항목 □", "□ 나"]) {
    assert.ok(text.includes(expected), `missing: ${expected}`);
  }
  assert.deepEqual(result, report(spec), "the report is deterministic too");
  assert.deepEqual(result.bytes, report(spec).bytes);
});

test("invisible characters are dropped without a box and without being counted", async () => {
  const result = report(paragraphs("a\u200Bb\uFE0Fc\u200Dd\uFEFFe\u0007f\u00ADg ✓\uFE0F 가"));
  assert.equal(result.replacedCount, 0, JSON.stringify(result.replaced));
  const text = await textOf(result.bytes);
  assert.ok(text.replace(/\s/gu, "").includes("abcdef"), text);
  assert.ok(text.includes("가"));
  assert.ok(!text.includes("□"));
});

test("a document that is mostly unsupported is refused, naming the characters", () => {
  const arabic = "مرحبا بكم في تقرير الربع الأول. ".repeat(6);
  assert.throws(
    () => report(paragraphs("Report", arabic)),
    (error) => {
      assert.ok(error instanceof PdfGenerationError);
      assert.equal(error.code, "UNSUPPORTED_CHARACTERS");
      assert.match(error.message, /does not cover this document's writing system/);
      assert.match(error.message, /Characters it cannot draw: .*م/u);
      assert.match(error.message, /docx/i);
      // The tool report keeps 300 characters of a failure; the point must fit.
      assert.ok(error.message.length <= 300, `${error.message.length}: ${error.message}`);
      return true;
    }
  );
  // Thai, Hebrew and emoji-only text are the same case.
  for (const text of ["สวัสดีครับ ยินดีต้อนรับ", "שלום עולם, זהו דוח", "🚀🔥✅❌🎉"]) {
    assert.throws(() => report(paragraphs(text)), PdfGenerationError, text);
  }
});

test("a long list of unsupported characters is capped and counted in the refusal", () => {
  const letters = Array.from({ length: 200 }, (_, index) => String.fromCodePoint(0x0e01 + (index % 80)));
  assert.throws(
    () => report(paragraphs(letters.join(""))),
    (error) => {
      assert.ok(error instanceof PdfGenerationError);
      assert.match(error.message, / and \d+ more kinds\./);
      assert.ok(error.message.length <= 300, `${error.message.length}`);
      return true;
    }
  );
});

test("the refusal point is a share of the visible characters, and spaces do not count", () => {
  assert.equal(PDF_MAX_REPLACED_SHARE, 0.25);
  const mix = (plain, boxes) => `${"a".repeat(plain)} `.concat("🚀".repeat(boxes));
  // 25 of 100 is not more than a quarter; 26 of 100 is.
  assert.equal(report(paragraphs(mix(75, 25))).replacedCount, 25);
  assert.throws(() => report(paragraphs(mix(74, 26))), PdfGenerationError);
  // A separate paragraph of plain text pulls the share back under the line.
  assert.equal(report(paragraphs(mix(74, 26), "b".repeat(30))).replacedCount, 26);
  // Whitespace is neither drawn text nor missing text.
  assert.equal(report(paragraphs(`${mix(75, 25)}${" ".repeat(500)}`)).replacedCount, 25);
});

test("list markers and table headers are not counted as text the author wrote", () => {
  // Three emoji and nothing else is all boxes, whatever markers surround them.
  for (const block of [
    { type: "bullets", items: ["🚀🚀🚀"] },
    { type: "numbers", items: ["🚀", "🚀", "🚀"] },
  ]) {
    assert.throws(() => report({ filename: "list.pdf", format: "pdf", blocks: [block] }), PdfGenerationError);
  }
  // Every item counts, the first one included.
  const result = report({
    filename: "list.pdf",
    format: "pdf",
    blocks: [{ type: "bullets", items: ["가나다라마바사", "아자차카타파하", "🚀"] }],
  });
  assert.equal(result.replacedCount, 1);
});

test("a Korean contract with one stray emoji is a PDF, not an error", async () => {
  const result = report({
    filename: "contract.pdf",
    format: "pdf",
    title: "용역 계약서",
    blocks: [
      { type: "paragraph", text: "甲(㈜톰버스)과 乙(홍길동)은 다음과 같이 계약한다. 🙂" },
      { type: "numbers", items: ["제1조 목적", "제2조 대금 ₩10,000,000 (㎡당 ①)"] },
    ],
  });
  assert.equal(result.replacedCount, 1);
  assert.equal(result.replaced[0].character, "🙂");
  assert.ok((await textOf(result.bytes)).includes("甲(㈜톰버스)과 乙(홍길동)"));
});

test("Japanese and Chinese paragraphs wrap inside the column", async () => {
  const japanese = "これは日本語の長い文章です。".repeat(30);
  const chinese = "这是一个关于经济发展的报告，内容包括市场、价格和数据。".repeat(20);
  for (const text of [japanese, chinese]) {
    const document = await readPdf(build(paragraphs(text)));
    const content = await (await document.getPage(1)).getTextContent();
    const lines = content.items.filter((item) => item.str?.trim());
    assert.ok(lines.length > 3, `${lines.length} lines`);
    for (const line of lines) {
      assert.ok(line.transform[4] >= 56 - 0.1);
      assert.ok(line.transform[4] + line.width <= 595.28 - 56 + 0.1, `${line.str} overflows`);
    }
    assert.equal(lines.map((line) => line.str).join(""), text);
    await document.cleanup();
  }
});

test("the larger face does not make every PDF bigger: the font program is compressed", () => {
  const font = loadPdfFont();
  assert.ok(font.numGlyphs > 20_000, `${font.numGlyphs} glyphs`);
  const korean = build(paragraphs("가"));
  const chinese = build(paragraphs("这是一个关于经济发展的报告"));
  assert.ok(korean.byteLength < 100_000, `${korean.byteLength} bytes`);
  assert.ok(chinese.byteLength < 100_000, `${chinese.byteLength} bytes`);
  assert.match(new TextDecoder("latin1").decode(korean), /\/Length1 \d+ \/Filter \/FlateDecode/);
});

/* -------------------------------------------------------------------------- */
/* The same behaviour through the renderers and the conversion path             */
/* -------------------------------------------------------------------------- */

test("renderDocumentArtifact carries the notice for a PDF and none for other formats", () => {
  const spec = (format) => {
    const admission = admitDocumentSpec({ ...paragraphs("가나다라마바사 🚀"), filename: `a.${format}`, format });
    assert.equal(admission.ok, true);
    return admission.spec;
  };
  const pdf = renderDocumentArtifact(spec("pdf"));
  assert.equal(pdf.notices?.length, 1);
  assert.match(pdf.notices[0], /^The PDF font has no glyph for 1 character of this document \(🚀\)/);
  assert.equal(renderDocumentArtifact(spec("docx")).notices, undefined);
  const clean = admitDocumentSpec({ ...paragraphs("甲乙 ㈜"), filename: "clean.pdf" });
  assert.equal(renderDocumentArtifact(clean.spec).notices, undefined);
});

test("a PDF inside a zip passes its notice on, named by path", () => {
  const admission = admitDocumentSpec({ ...paragraphs("x"), filename: "x.pdf" });
  assert.equal(admission.ok, true);
  const archive = renderArchiveArtifact({
    filename: "bundle.zip",
    format: "zip",
    entries: [
      { path: "docs/a.pdf", documentFormat: "pdf", blocks: [{ type: "paragraph", text: "가나다라마바사 🚀" }] },
      { path: "docs/b.pdf", documentFormat: "pdf", blocks: [{ type: "paragraph", text: "나" }] },
    ],
  });
  assert.equal(archive.notices?.length, 1);
  assert.match(archive.notices[0], /^docs\/a\.pdf: The PDF font has no glyph for 1 character/);
});
