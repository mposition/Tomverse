import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync } from "fflate";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import {
  FileConversionError,
  prepareFileConversion,
} from "../lib/fileConversion.ts";
import {
  FILE_CONVERSION_LIMITS,
  PageSelectionError,
  admitFileConversionSpec,
  conversionSourceKind,
  parsePageSelection,
  turnHasConvertibleAttachment,
} from "../lib/fileConversionCore.ts";
import { readSpreadsheetGrid } from "../lib/spreadsheetDataRows.ts";
import { buildXlsx } from "./fixtures/officeFixtures.mjs";

// docs/policy/generated-artifacts.md section 14.
//
// Real bytes in, real bytes out. The conversions are worth nothing if the PDF
// they write cannot be reopened, so every assertion here reads the output back
// with a parser rather than trusting that a function returned.

const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const image = async ({ width, height, format = "jpeg", orientation, alpha = false }) => {
  let pipeline = sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : "#3366cc",
    },
  });
  pipeline = format === "png" ? pipeline.png() : format === "webp" ? pipeline.webp() : pipeline.jpeg();
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  return new Uint8Array(await pipeline.toBuffer());
};

const pdf = async (sizes) => {
  const document = await PDFDocument.create();
  for (const [width, height] of sizes) document.addPage([width, height]);
  return new Uint8Array(await document.save());
};

const attachments = (entries) =>
  new Map(
    entries.map(([name, mediaType, bytes], index) => [
      `att_${index + 1}`,
      { name, mediaType, bytes },
    ])
  );

const convert = async (spec, files) => {
  const admission = admitFileConversionSpec(spec);
  assert.ok(admission.ok, admission.ok ? "" : admission.detail);
  const prepared = await prepareFileConversion(admission.spec, files);
  const rendered = await prepared.render();
  return { format: prepared.format, ...rendered };
};

const rejects = async (spec, files, code) => {
  const admission = admitFileConversionSpec(spec);
  assert.ok(admission.ok, admission.ok ? "" : admission.detail);
  await assert.rejects(
    async () => (await prepareFileConversion(admission.spec, files)).render(),
    (error) => {
      assert.ok(error instanceof FileConversionError, String(error));
      assert.equal(error.code, code);
      return true;
    }
  );
};

/* ------------------------------------------------------------------------ */
/* Page selection                                                             */
/* ------------------------------------------------------------------------ */

test("a page selection keeps the order and the repeats a person wrote", () => {
  assert.deepEqual(parsePageSelection(undefined, 3), [0, 1, 2]);
  assert.deepEqual(parsePageSelection("all", 2), [0, 1]);
  assert.deepEqual(parsePageSelection("3,1,2", 3), [2, 0, 1]);
  assert.deepEqual(parsePageSelection("1-2, 4-", 5), [0, 1, 3, 4]);
  assert.deepEqual(parsePageSelection("-2", 5), [0, 1]);
  assert.deepEqual(parsePageSelection("3-1", 3), [2, 1, 0]);
  assert.deepEqual(parsePageSelection("1,1", 3), [0, 0]);
});

test("a page the file does not have is refused, never clamped", () => {
  assert.throws(() => parsePageSelection("1-9", 6), PageSelectionError);
  assert.throws(() => parsePageSelection("0", 6), PageSelectionError);
  assert.throws(() => parsePageSelection("two", 6), PageSelectionError);
  assert.throws(() => parsePageSelection(",", 6), PageSelectionError);
  assert.throws(() => parsePageSelection("1-5", 5, 3), PageSelectionError);
});

/* ------------------------------------------------------------------------ */
/* Admission                                                                  */
/* ------------------------------------------------------------------------ */

test("a source is a handle and nothing else", () => {
  for (const attachment of ["att_0", "1", "../etc/passwd", "https://x/y.png", "att_1 "]) {
    const admission = admitFileConversionSpec({
      operation: "to_pdf",
      filename: "out",
      sources: [{ attachment }],
    });
    assert.equal(admission.ok, false, attachment);
  }
  const unknownField = admitFileConversionSpec({
    operation: "to_pdf",
    filename: "out",
    sources: [{ attachment: "att_1", bytes: "AAAA" }],
  });
  assert.equal(unknownField.ok, false);
});

test("each operation's own requirement is named in the refusal", () => {
  const cases = [
    [{ operation: "convert_images", sources: [{ attachment: "att_1" }] }, /imageFormat/],
    [{ operation: "convert_spreadsheet", sources: [{ attachment: "att_1" }] }, /targetFormat/],
    [
      {
        operation: "convert_spreadsheet",
        targetFormat: "csv",
        sources: [{ attachment: "att_1" }, { attachment: "att_2" }],
      },
      /one file/,
    ],
    [
      {
        operation: "split_pdf",
        sources: [{ attachment: "att_1" }, { attachment: "att_2" }],
      },
      /one PDF/,
    ],
    [
      {
        operation: "to_pdf",
        sources: [{ attachment: "att_1", rotate: 45 }],
      },
      /rotate/,
    ],
  ];
  for (const [spec, pattern] of cases) {
    const admission = admitFileConversionSpec({ filename: "out", ...spec });
    assert.equal(admission.ok, false);
    assert.match(admission.detail, pattern);
  }
});

test("what a conversion can read is decided from the stored media type", () => {
  assert.equal(conversionSourceKind("image/jpeg"), "image");
  assert.equal(conversionSourceKind("image/gif"), "image");
  assert.equal(conversionSourceKind("application/pdf"), "pdf");
  assert.equal(conversionSourceKind(XLSX), "spreadsheet");
  assert.equal(conversionSourceKind("text/csv; charset=utf-8"), "spreadsheet");
  assert.equal(conversionSourceKind("application/msword"), null);
  assert.equal(conversionSourceKind("image/svg+xml"), null);
  assert.equal(turnHasConvertibleAttachment([{ mediaType: "application/msword" }]), false);
  assert.equal(turnHasConvertibleAttachment([{ mediaType: "image/png" }]), true);
  assert.equal(turnHasConvertibleAttachment(undefined), false);
});

/* ------------------------------------------------------------------------ */
/* to_pdf                                                                     */
/* ------------------------------------------------------------------------ */

test("two photographs become one PDF with one page each, turned to suit", async () => {
  const files = attachments([
    ["id-card.jpg", "image/jpeg", await image({ width: 800, height: 500 })],
    ["letter.png", "image/png", await image({ width: 600, height: 900, format: "png" })],
  ]);
  const result = await convert(
    {
      operation: "to_pdf",
      filename: "combined",
      sources: [{ attachment: "att_1" }, { attachment: "att_2" }],
    },
    files
  );
  assert.equal(result.format, "pdf");
  assert.equal(result.parts, "2 pages from 2 files");

  const document = await PDFDocument.load(result.bytes);
  assert.equal(document.getPageCount(), 2);
  const [landscape, portrait] = document.getPages().map((page) => page.getSize());
  assert.ok(landscape.width > landscape.height, "a wide image gets a landscape page");
  assert.ok(portrait.height > portrait.width, "a tall image gets a portrait page");
  assert.equal(Math.round(portrait.width), 595);
});

test("a phone photograph stored sideways is laid out the way it is viewed", async () => {
  // 400x200 pixels, flagged "rotate 90 degrees to view": it is seen as 200x400.
  const files = attachments([
    ["phone.jpg", "image/jpeg", await image({ width: 400, height: 200, orientation: 6 })],
  ]);
  const result = await convert(
    {
      operation: "to_pdf",
      filename: "photo",
      pageSize: "fit",
      sources: [{ attachment: "att_1" }],
    },
    files
  );
  const { width, height } = (await PDFDocument.load(result.bytes)).getPage(0).getSize();
  assert.equal(width, 150);
  assert.equal(height, 300);
});

test("PDFs and images merge in the order written, with pages chosen and rotated", async () => {
  const files = attachments([
    ["a.pdf", "application/pdf", await pdf([[100, 200], [110, 200], [120, 200]])],
    ["b.pdf", "application/pdf", await pdf([[300, 400]])],
    ["scan.webp", "image/webp", await image({ width: 300, height: 300, format: "webp" })],
  ]);
  const result = await convert(
    {
      operation: "to_pdf",
      filename: "merged.pdf",
      sources: [
        { attachment: "att_2" },
        { attachment: "att_1", pages: "3,1", rotate: 90 },
        { attachment: "att_3" },
      ],
    },
    files
  );
  const document = await PDFDocument.load(result.bytes);
  const pages = document.getPages();
  assert.deepEqual(
    pages.slice(0, 3).map((page) => Math.round(page.getSize().width)),
    [300, 120, 100]
  );
  assert.deepEqual(
    pages.map((page) => page.getRotation().angle),
    [0, 90, 90, 0]
  );
  assert.equal(result.parts, "4 pages from 3 files");
});

test("a conversion names what is wrong with a source instead of guessing", async () => {
  const files = attachments([
    ["a.pdf", "application/pdf", await pdf([[100, 200]])],
    ["notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", new Uint8Array([1])],
    ["broken.pdf", "application/pdf", new TextEncoder().encode("not a pdf")],
    ["photo.png", "image/png", await image({ width: 10, height: 10, format: "png" })],
  ]);
  const toPdf = (sources) => ({ operation: "to_pdf", filename: "out", sources });

  await rejects(toPdf([{ attachment: "att_9" }]), files, "SOURCE_MISSING");
  await rejects(toPdf([{ attachment: "att_2" }]), files, "SOURCE_TYPE");
  await rejects(toPdf([{ attachment: "att_1", pages: "2" }]), files, "PAGES_INVALID");
  await rejects(toPdf([{ attachment: "att_4", pages: "1" }]), files, "PAGES_INVALID");
  await rejects(toPdf([{ attachment: "att_3" }]), files, "PDF_UNREADABLE");
  await rejects(
    { operation: "pdf_to_images", filename: "out", sources: [{ attachment: "att_4" }] },
    files,
    "SOURCE_TYPE"
  );
});

test("the missing-file message lists what is attached and never a path", async () => {
  const files = attachments([["a.pdf", "application/pdf", await pdf([[100, 200]])]]);
  const admission = admitFileConversionSpec({
    operation: "to_pdf",
    filename: "out",
    sources: [{ attachment: "att_2" }],
  });
  await assert.rejects(prepareFileConversion(admission.spec, files), (error) => {
    assert.match(error.message, /att_1 \("a\.pdf"\)/);
    assert.match(error.message, /attached again/);
    return true;
  });
});

/* ------------------------------------------------------------------------ */
/* split_pdf                                                                  */
/* ------------------------------------------------------------------------ */

test("a PDF splits by a page count or by the ranges written", async () => {
  const files = attachments([
    ["report.pdf", "application/pdf", await pdf([[100, 100], [110, 100], [120, 100], [130, 100], [140, 100]])],
  ]);

  const everyTwo = await convert(
    { operation: "split_pdf", filename: "parts", splitEvery: 2, sources: [{ attachment: "att_1" }] },
    files
  );
  assert.equal(everyTwo.format, "zip");
  const chunks = unzipSync(everyTwo.bytes);
  assert.deepEqual(Object.keys(chunks).sort(), [
    "report_01.pdf",
    "report_02.pdf",
    "report_03.pdf",
  ]);
  assert.equal((await PDFDocument.load(chunks["report_03.pdf"])).getPageCount(), 1);

  const ranges = await convert(
    {
      operation: "split_pdf",
      filename: "parts",
      sources: [
        { attachment: "att_1", pages: "1-2" },
        { attachment: "att_1", pages: "5" },
      ],
    },
    files
  );
  const byRange = unzipSync(ranges.bytes);
  const second = await PDFDocument.load(byRange["report_02.pdf"]);
  assert.equal(Math.round(second.getPage(0).getSize().width), 140);

  const perPage = await convert(
    { operation: "split_pdf", filename: "pages", sources: [{ attachment: "att_1" }] },
    files
  );
  assert.equal(Object.keys(unzipSync(perPage.bytes)).length, 5);
});

/* ------------------------------------------------------------------------ */
/* pdf_to_images                                                              */
/* ------------------------------------------------------------------------ */

test("one PDF page is an image; several are a zip of images", async () => {
  const files = attachments([
    ["slides.pdf", "application/pdf", await pdf([[144, 72], [72, 144]])],
  ]);

  const single = await convert(
    {
      operation: "pdf_to_images",
      filename: "page",
      dpi: 72,
      sources: [{ attachment: "att_1", pages: "1" }],
    },
    files
  );
  assert.equal(single.format, "png");
  const meta = await sharp(Buffer.from(single.bytes)).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["png", 144, 72]);

  const all = await convert(
    {
      operation: "pdf_to_images",
      filename: "pages",
      imageFormat: "jpg",
      dpi: 144,
      sources: [{ attachment: "att_1" }],
    },
    files
  );
  assert.equal(all.format, "zip");
  const entries = unzipSync(all.bytes);
  assert.deepEqual(Object.keys(entries).sort(), ["slides_p1.jpg", "slides_p2.jpg"]);
  const second = await sharp(Buffer.from(entries["slides_p2.jpg"])).metadata();
  assert.deepEqual([second.format, second.width, second.height], ["jpeg", 144, 288]);
});

test("drawing is bounded by a page count, not attempted and abandoned", async () => {
  const many = Array.from({ length: FILE_CONVERSION_LIMITS.maxRasterPages + 1 }, () => [72, 72]);
  const files = attachments([["long.pdf", "application/pdf", await pdf(many)]]);
  await rejects(
    { operation: "pdf_to_images", filename: "out", sources: [{ attachment: "att_1" }] },
    files,
    "PAGES_INVALID"
  );
});

/* ------------------------------------------------------------------------ */
/* convert_images                                                             */
/* ------------------------------------------------------------------------ */

test("an image changes format and size, and transparency becomes white in a JPG", async () => {
  const files = attachments([
    ["logo.png", "image/png", await image({ width: 400, height: 200, format: "png", alpha: true })],
  ]);
  const result = await convert(
    {
      operation: "convert_images",
      filename: "logo",
      imageFormat: "jpg",
      maxDimension: 100,
      sources: [{ attachment: "att_1" }],
    },
    files
  );
  assert.equal(result.format, "jpg");
  const output = sharp(Buffer.from(result.bytes));
  const meta = await output.metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 100, 50]);
  const { channels } = await output.stats();
  assert.ok(channels.every((channel) => channel.mean > 250), "transparent pixels are white");
  assert.equal(result.parts, "JPG image, 100x50 pixels");
});

test("several images convert into one zip with names that cannot collide", async () => {
  const files = attachments([
    ["scan.jpg", "image/jpeg", await image({ width: 20, height: 20 })],
    ["scan.jpeg", "image/jpeg", await image({ width: 30, height: 30 })],
  ]);
  const result = await convert(
    {
      operation: "convert_images",
      filename: "scans",
      imageFormat: "webp",
      sources: [{ attachment: "att_1" }, { attachment: "att_2" }],
    },
    files
  );
  assert.equal(result.format, "zip");
  assert.deepEqual(Object.keys(unzipSync(result.bytes)).sort(), [
    "scan (2).webp",
    "scan.webp",
  ]);
});

/* ------------------------------------------------------------------------ */
/* convert_spreadsheet                                                        */
/* ------------------------------------------------------------------------ */

const csvBytes = (text) => new TextEncoder().encode(text);

test("a CSV becomes a workbook whose numbers are numbers and whose ids are not", async () => {
  const files = attachments([
    ["orders.csv", "text/csv", csvBytes("name,amount,code\nKim,1200.5,007\nLee,-3,A1\n")],
  ]);
  const result = await convert(
    {
      operation: "convert_spreadsheet",
      filename: "orders",
      targetFormat: "xlsx",
      sources: [{ attachment: "att_1" }],
    },
    files
  );
  assert.equal(result.format, "xlsx");
  assert.equal(result.parts, "2 rows, 3 columns");
  const sheet = new TextDecoder().decode(unzipSync(result.bytes)["xl/worksheets/sheet1.xml"]);
  assert.match(sheet, /<v>1200\.5<\/v>/);
  assert.match(sheet, /<v>-3<\/v>/);
  // "007" is an identifier: written as text, so the zeros survive.
  const round = readSpreadsheetGrid(result.bytes, {
    mediaType: XLSX,
    maxRows: 100,
    maxValueLength: 100,
  });
  assert.deepEqual(round.grid[1], ["Kim", "1200.5", "007"]);
});

test("a workbook becomes a CSV of the sheet that was asked for", async () => {
  const files = attachments([
    [
      "book.xlsx",
      XLSX,
      buildXlsx({
        rows: [
          ["name", "city"],
          ["Kim", "Seoul"],
          ["Lee", "Busan, KR"],
        ],
      }),
    ],
  ]);
  const result = await convert(
    {
      operation: "convert_spreadsheet",
      filename: "book",
      targetFormat: "csv",
      sources: [{ attachment: "att_1" }],
    },
    files
  );
  assert.equal(result.format, "csv");
  const text = new TextDecoder().decode(result.bytes).replace(/^﻿/, "");
  assert.match(text, /name,city/);
  assert.match(text, /Lee,"Busan, KR"/);
});

test("a table becomes a PDF, and one too long for a PDF is refused with the alternative", async () => {
  const files = attachments([
    ["small.csv", "text/csv", csvBytes("item,qty\nA,1\nB,2\n")],
    [
      "long.csv",
      "text/csv",
      csvBytes(`n\n${Array.from({ length: 600 }, (_, index) => index).join("\n")}\n`),
    ],
  ]);
  const result = await convert(
    {
      operation: "convert_spreadsheet",
      filename: "small",
      targetFormat: "pdf",
      sources: [{ attachment: "att_1" }],
    },
    files
  );
  assert.equal(result.format, "pdf");
  assert.ok((await PDFDocument.load(result.bytes)).getPageCount() >= 1);

  await rejects(
    {
      operation: "convert_spreadsheet",
      filename: "long",
      targetFormat: "pdf",
      sources: [{ attachment: "att_2" }],
    },
    files,
    "TOO_MANY_PAGES"
  );
  await rejects(
    {
      operation: "convert_spreadsheet",
      filename: "same",
      targetFormat: "csv",
      sources: [{ attachment: "att_1" }],
    },
    files,
    "SOURCE_TYPE"
  );
});

/* ------------------------------------------------------------------------ */
/* Found by the independent review of the first version                       */
/* ------------------------------------------------------------------------ */

test("zip names are unique against the names actually written, not a count per name", async () => {
  // "scan (2)" exists as a source name and is also what the second "scan"
  // would be renamed to. Three files in, three files out.
  const files = attachments([
    ["scan.jpg", "image/jpeg", await image({ width: 10, height: 10 })],
    ["scan (2).jpg", "image/jpeg", await image({ width: 20, height: 20 })],
    ["Scan.png", "image/png", await image({ width: 30, height: 30, format: "png" })],
  ]);
  const result = await convert(
    {
      operation: "convert_images",
      filename: "scans",
      imageFormat: "webp",
      sources: [{ attachment: "att_1" }, { attachment: "att_2" }, { attachment: "att_3" }],
    },
    files
  );
  const entries = unzipSync(result.bytes);
  const names = Object.keys(entries);
  assert.equal(names.length, 3, names.join(", "));
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 3);
  const widths = [];
  for (const name of names) {
    widths.push((await sharp(Buffer.from(entries[name])).metadata()).width);
  }
  assert.deepEqual(widths.sort(), [10, 20, 30]);
});

test("a long cell is converted whole or refused, never cut", async () => {
  const long = "가".repeat(4_500);
  const files = attachments([
    ["notes.xlsx", XLSX, buildXlsx({ rows: [["id", "note"], ["1", long]] })],
    ["huge.xlsx", XLSX, buildXlsx({ rows: [["id", "note"], ["1", "x".repeat(20_001)]] })],
    ["huge.csv", "text/csv", csvBytes(`id,note\n1,${"y".repeat(20_001)}\n`)],
  ]);
  const result = await convert(
    {
      operation: "convert_spreadsheet",
      filename: "notes",
      targetFormat: "csv",
      sources: [{ attachment: "att_1" }],
    },
    files
  );
  assert.ok(new TextDecoder().decode(result.bytes).includes(long));

  for (const [attachment, targetFormat] of [["att_2", "csv"], ["att_3", "xlsx"]]) {
    await rejects(
      {
        operation: "convert_spreadsheet",
        filename: "huge",
        targetFormat,
        sources: [{ attachment }],
      },
      files,
      "SPREADSHEET_UNREADABLE"
    );
  }
});

test("each range of a split keeps the rotation written for it", async () => {
  const files = attachments([
    ["doc.pdf", "application/pdf", await pdf([[100, 100], [110, 100], [120, 100]])],
  ]);
  const result = await convert(
    {
      operation: "split_pdf",
      filename: "parts",
      sources: [
        { attachment: "att_1", pages: "1" },
        { attachment: "att_1", pages: "2-3", rotate: 90 },
      ],
    },
    files
  );
  const entries = unzipSync(result.bytes);
  const first = await PDFDocument.load(entries["doc_01.pdf"]);
  const second = await PDFDocument.load(entries["doc_02.pdf"]);
  assert.deepEqual(first.getPages().map((page) => page.getRotation().angle), [0]);
  assert.deepEqual(second.getPages().map((page) => page.getRotation().angle), [90, 90]);
});

test("an image over the pixel ceiling is reported as a limit, not as an unreadable file", async () => {
  const side = Math.ceil(Math.sqrt(FILE_CONVERSION_LIMITS.maxImagePixels)) + 50;
  const files = attachments([
    ["poster.png", "image/png", await image({ width: side, height: side, format: "png" })],
  ]);
  await rejects(
    {
      operation: "convert_images",
      filename: "poster",
      imageFormat: "jpg",
      sources: [{ attachment: "att_1" }],
    },
    files,
    "OUTPUT_TOO_LARGE"
  );
});
