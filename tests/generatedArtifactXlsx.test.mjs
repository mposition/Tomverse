import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { unzipSync } from "fflate";

import { admitWorkbookSpecSafely } from "../lib/generatedArtifactCore.ts";
import {
  ArtifactGenerationError,
  columnLetter,
  escapeXml,
  excelSerialFromDate,
  parseArtifactDate,
  renderWorkbook,
} from "../lib/generatedArtifactXlsx.ts";

// docs/policy/generated-artifacts.md sections 3, 4 and 6.
//
// Two independent readers are used on purpose. The XML assertions check what
// this writer meant to produce; `officeparser` -- a third-party OOXML reader
// this repository already depends on for attachment parsing -- checks that a
// reader which knows nothing about this code can open the package and get the
// values back. A test that only re-reads its own output proves the output is
// self-consistent, which is not the property anybody cares about.

const require = createRequire(import.meta.url);
const { OfficeParser } = require("officeparser");

const decode = (bytes) => new TextDecoder().decode(bytes);

const build = (spec, format = "xlsx") => {
  const admission = admitWorkbookSpecSafely(spec);
  assert.equal(admission.ok, true, JSON.stringify(admission));
  return renderWorkbook(admission.spec, format);
};

const QUARTERLY = {
  filename: "분기별_매출.xlsx",
  worksheets: [
    {
      name: "2026 매출",
      title: "분기별 매출",
      columns: [
        { header: "분기", type: "text" },
        { header: "매출", type: "number", format: "currency_krw", width: 18 },
        { header: "집계일", type: "date" },
        { header: "메모", type: "text" },
      ],
      rows: [
        ["Q1", 125_000_000, "2026-03-31", "정상"],
        ["Q2", 143_500_000, "2026-06-30", "=cmd|'/C calc'!A0"],
        ["Q3", 98_000_000, "2026-09-30", "-1 대비"],
      ],
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Package shape                                                                */
/* -------------------------------------------------------------------------- */

test("the package holds exactly the parts an xlsx needs", () => {
  const entries = unzipSync(build(QUARTERLY).bytes);
  assert.deepEqual(Object.keys(entries).sort(), [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/core.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/workbook.xml",
    "xl/worksheets/sheet1.xml",
  ]);
});

test("nothing in the package can execute, link out or fetch remote data", () => {
  const entries = unzipSync(build(QUARTERLY).bytes);
  const names = Object.keys(entries);
  // Absent by construction: this writer has no code that emits these parts.
  assert.ok(!names.some((name) => name.includes("vbaProject")));
  assert.ok(!names.some((name) => name.includes("externalLink")));
  assert.ok(!names.some((name) => name.includes("connections")));
  assert.ok(!names.some((name) => name.includes("docProps/custom")));

  const everything = names.map((name) => decode(entries[name])).join("");
  // `<f>` is the only thing in OOXML that is a formula.
  assert.ok(!/<f[\s>]/.test(everything));
  assert.ok(!everything.includes("hyperlink"));
  assert.ok(!everything.includes("http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink"));
});

test("a third-party OOXML reader opens the file and returns every value", async () => {
  const { bytes } = build(QUARTERLY);
  const document = await OfficeParser.parseOffice(Buffer.from(bytes), {
    extractAttachments: false,
    ocr: false,
  });
  const text = document.toText();

  // The title, the headers, and the cells -- read by something that has never
  // seen lib/generatedArtifactXlsx.ts.
  assert.ok(text.includes("분기별 매출"));
  for (const header of ["분기", "매출", "집계일", "메모"]) {
    assert.ok(text.includes(header), header);
  }
  assert.ok(text.includes("Q1"));
  assert.ok(text.includes("125000000"));
  assert.ok(text.includes("정상"));
});

/* -------------------------------------------------------------------------- */
/* Cells                                                                        */
/* -------------------------------------------------------------------------- */

const sheetXml = (spec) =>
  decode(unzipSync(build(spec).bytes)["xl/worksheets/sheet1.xml"]);

test("headers land on their own row and data rows follow, in order", () => {
  const xml = sheetXml(QUARTERLY);
  // Row 1 is the title, row 2 the header, rows 3-5 the data.
  assert.match(xml, /<row r="1">.*분기별 매출.*<\/row>/);
  assert.match(xml, /<row r="2">.*분기.*매출.*집계일.*메모.*<\/row>/);
  assert.match(xml, /<c r="A3"[^>]*>.*?Q1/);
  assert.match(xml, /<c r="B3"[^>]*><v>125000000<\/v><\/c>/);
});

test("a value that looks like a formula is stored as text, verbatim", () => {
  const xml = sheetXml(QUARTERLY);
  // The whole payload survives -- the defence does not edit the user's data --
  // and it is an inline string, which OOXML never evaluates.
  assert.ok(xml.includes("=cmd|&apos;/C calc&apos;!A0"));
  assert.match(xml, /<c r="D4" t="inlineStr" s="2">/);
  assert.ok(!/<f[\s>]/.test(xml));
});

test("the forced-text style really is Excel's quotePrefix marker", () => {
  const styles = decode(unzipSync(build(QUARTERLY).bytes)["xl/styles.xml"]);
  const cellXfs = styles.slice(styles.indexOf("<cellXfs"));
  // Style index 2 is the one the cell above referenced.
  const third = cellXfs.split("<xf")[3];
  assert.ok(third.includes('quotePrefix="1"'));
});

test("a leading minus is guarded too, and keeps its value", () => {
  const xml = sheetXml(QUARTERLY);
  assert.match(xml, /<c r="D5" t="inlineStr" s="2">/);
  assert.ok(xml.includes("-1 대비"));
});

test("a date column with no declared format still renders as a date", () => {
  const xml = sheetXml(QUARTERLY);
  // 2026-03-31, as the serial Excel uses.
  const cell = /<c r="C3"([^>]*)><v>(\d+)<\/v><\/c>/.exec(xml);
  assert.ok(cell, "C3 should be a numeric date cell");
  assert.equal(cell[2], "46112");
  // A style index, so it is not shown to the reader as the number 46112.
  assert.match(cell[1], /s="\d+"/);
});

test("a number column carrying a non-number keeps the text rather than zeroing it", () => {
  // "n/a revenue" must never silently become 0.
  const xml = sheetXml({
    filename: "x.xlsx",
    worksheets: [
      {
        name: "S",
        columns: [{ header: "revenue", type: "number" }],
        rows: [["n/a"]],
      },
    ],
  });
  assert.match(xml, /<c r="A2" t="inlineStr"[^>]*><is><t[^>]*>n\/a<\/t>/);
});

test("a null cell is skipped but its row keeps its number", () => {
  const xml = sheetXml({
    filename: "x.xlsx",
    worksheets: [
      {
        name: "S",
        columns: [{ header: "a" }, { header: "b" }],
        rows: [[null, "kept"], [null, null]],
      },
    ],
  });
  // Row 1 is the header; the two data rows follow it.
  assert.match(xml, /<row r="2"><c r="B2"/);
  assert.match(xml, /<row r="3"><\/row>/);
});

test("booleans are written as booleans", () => {
  const xml = sheetXml({
    filename: "x.xlsx",
    worksheets: [
      { name: "S", columns: [{ header: "ok" }], rows: [[true], [false]] },
    ],
  });
  assert.ok(xml.includes('<c r="A2" t="b"><v>1</v></c>'));
  assert.ok(xml.includes('<c r="A3" t="b"><v>0</v></c>'));
});

/* -------------------------------------------------------------------------- */
/* Escaping and determinism                                                     */
/* -------------------------------------------------------------------------- */

test("markup in a cell value cannot become markup in the file", () => {
  const xml = sheetXml({
    filename: "x.xlsx",
    worksheets: [
      {
        name: "S",
        columns: [{ header: "note" }],
        rows: [['</t></is></c><f>SUM(1,1)</f>']],
      },
    ],
  });
  assert.ok(!/<f[\s>]/.test(xml));
  assert.ok(xml.includes("&lt;/t&gt;&lt;/is&gt;&lt;/c&gt;&lt;f&gt;"));
});

test("code points XML cannot carry are removed rather than written", () => {
  assert.equal(escapeXml("a\u0000b\u0008c"), "abc");
  assert.equal(escapeXml("keep\ttab\nand\rreturn"), "keep\ttab\nand\rreturn");
});

test("the same specification produces byte-identical output", () => {
  // What makes the idempotency key meaningful: a regeneration of the same
  // data has to be recognisably the same file, so no clock may reach the zip.
  const first = build(QUARTERLY).bytes;
  const second = build(QUARTERLY).bytes;
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

test("column letters run past Z the way Excel's do", () => {
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
  assert.equal(columnLetter(63), "BL");
});

test("the Excel epoch is 1899-12-30, leap-year bug included", () => {
  assert.equal(excelSerialFromDate(new Date("1900-01-01T00:00:00Z")), 2);
  assert.equal(excelSerialFromDate(new Date("2026-03-31T00:00:00Z")), 46112);
});

test("only unambiguous ISO dates are read as dates", () => {
  assert.ok(parseArtifactDate("2026-03-31"));
  assert.ok(parseArtifactDate("2026-03-31T09:30:00Z"));
  // "03/04/2026" means different months on either side of the Atlantic.
  assert.equal(parseArtifactDate("03/04/2026"), null);
  assert.equal(parseArtifactDate("March 2026"), null);
  assert.equal(parseArtifactDate(42), null);
});

/* -------------------------------------------------------------------------- */
/* CSV                                                                          */
/* -------------------------------------------------------------------------- */

test("CSV carries a BOM so Excel reads it as UTF-8", () => {
  const { bytes, mediaType } = build(QUARTERLY, "csv");
  // `ignoreBOM` because the default decoder *removes* a BOM, which would make
  // this assertion pass whether or not one was written.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  assert.equal(text.codePointAt(0), 0xfeff);
  assert.equal(mediaType, "text/csv; charset=utf-8");
  assert.ok(text.includes("분기,매출,집계일,메모"));
  assert.ok(text.includes("'=cmd"));
});

test("a multi-sheet workbook is refused as CSV rather than silently truncated", () => {
  const admission = admitWorkbookSpecSafely({
    filename: "two.csv",
    format: "csv",
    worksheets: [
      { name: "A", columns: [{ header: "a" }], rows: [["1"]] },
      { name: "B", columns: [{ header: "b" }], rows: [["2"]] },
    ],
  });
  assert.equal(admission.ok, true);
  assert.throws(
    () => renderWorkbook(admission.spec, "csv"),
    (error) =>
      error instanceof ArtifactGenerationError &&
      error.code === "GENERATION_FAILED"
  );
});

/* -------------------------------------------------------------------------- */
/* Output ceiling                                                               */
/* -------------------------------------------------------------------------- */

test("a specification inside the cell limit can still be refused on bytes", () => {
  // The reason `maxCells` and `maxOutputBytes` are separate limits: this
  // workbook is inside the cell ceiling and still deflates to more than any
  // download route should stream. High-entropy values, because a limit that
  // only trips on incompressible data is a limit that does not describe the
  // worst case.
  const COLUMNS = 40;
  const ROWS = 2_400;
  const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let state = 0x9e3779b9;
  const nextChar = () => {
    // xorshift32: deterministic, so the test never depends on a clock, and
    // well-mixed enough that deflate finds almost nothing to remove. A plain
    // LCG is not good enough here -- its low bits are periodic, and the
    // resulting text compressed to a sixth of this.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ALPHABET[(state >>> 0) % ALPHABET.length];
  };
  const value = () => Array.from({ length: 90 }, nextChar).join("");

  const columns = Array.from({ length: COLUMNS }, (_, i) => ({ header: `c${i}` }));
  const rows = Array.from({ length: ROWS }, () =>
    Array.from({ length: COLUMNS }, value)
  );
  const admission = admitWorkbookSpecSafely({
    filename: "huge.xlsx",
    worksheets: [{ name: "S", columns, rows }],
  });
  assert.equal(admission.ok, true, JSON.stringify(admission).slice(0, 200));
  assert.throws(
    () => renderWorkbook(admission.spec, "xlsx"),
    (error) =>
      error instanceof ArtifactGenerationError &&
      error.code === "OUTPUT_TOO_LARGE"
  );
});
