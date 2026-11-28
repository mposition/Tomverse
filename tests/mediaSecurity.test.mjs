import assert from "node:assert/strict";
import test from "node:test";
import {
  describeUnreadPdfPages,
  extractPdfTextSafely,
  extractPdfTextWithPagesSafely,
  pdfReadingOutcome,
  validatePdfSafely,
} from "../lib/mediaSecurity.ts";
import { createQaPdfBuffer } from "./e2e/support/app-fixtures.ts";

test("extractPdfTextSafely reads text from a PDF using a standard, non-embedded font", async () => {
  const text = await extractPdfTextSafely(createQaPdfBuffer(), 5_000);
  assert.match(text, /QA PDF/);
});

test("validatePdfSafely accepts a PDF using a standard, non-embedded font", async () => {
  await assert.doesNotReject(() => validatePdfSafely(createQaPdfBuffer()));
});

test("extractPdfTextSafely rejects a buffer without a PDF signature", async () => {
  await assert.rejects(() =>
    extractPdfTextSafely(Buffer.from("not a pdf"), 5_000)
  );
});

test("validatePdfSafely rejects a buffer without a PDF signature", async () => {
  await assert.rejects(() => validatePdfSafely(Buffer.from("not a pdf")));
});

// A minimal PDF whose pages draw each line at its own baseline. A page with no
// lines has an empty content stream: no text layer, as a scan would have.
const buildLinePdf = (pages) => {
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`
  );
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((lines, index) => {
    const pageId = 4 + index * 2;
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
    );
    const content = lines.length
      ? `BT /F1 12 Tf ${lines
          .map((line, i) => `1 0 0 1 20 ${260 - i * 20} Tm (${line}) Tj`)
          .join(" ")} ET`
      : "";
    objects.set(pageId + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  const last = 3 + pages.length * 2;
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (let id = 1; id <= last; id += 1) {
    offsets.push(body.length);
    body += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${last + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${last + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
};

test("extractPdfTextSafely keeps the lines of a page: a table row stays a row", async () => {
  const pdf = buildLinePdf([["Item   Qty   Price", "Apples  3   1.20", "Pears  5   2.40"]]);
  const text = await extractPdfTextSafely(pdf, 5_000);
  assert.equal(text, "[Page 1]\nItem Qty Price\nApples 3 1.20\nPears 5 2.40");
});

test("extractPdfTextWithPagesSafely names the pages that have no text layer", async () => {
  const pdf = buildLinePdf([["First page"], [], ["Third page"], []]);
  const result = await extractPdfTextWithPagesSafely(pdf, 5_000);
  assert.deepEqual(result.textlessPages, [2, 4]);
  assert.equal(result.pageCount, 4);
  assert.match(result.text, /\[Page 1\]\nFirst page/);
  assert.match(result.text, /\[Page 3\]\nThird page/);
  assert.doesNotMatch(result.text, /\[Page 2\]/);
});

test("a PDF with no text at all lists every page and returns no text", async () => {
  const result = await extractPdfTextWithPagesSafely(buildLinePdf([[], []]), 5_000);
  assert.equal(result.text, "");
  assert.deepEqual(result.textlessPages, [1, 2]);
});

test("pages past a truncation point are not reported as text-less", async () => {
  const pdf = buildLinePdf([["a".repeat(80)], ["second"], []]);
  const result = await extractPdfTextWithPagesSafely(pdf, 40);
  assert.deepEqual(result.textlessPages, []);
});

test("describeUnreadPdfPages names the pages and caps a long list", () => {
  assert.match(describeUnreadPdfPages([3]), /page 3\./);
  assert.match(describeUnreadPdfPages([3, 5]), /pages 3, 5\./);
  const many = describeUnreadPdfPages(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.match(many, /and 60 more/);
  assert.ok(many.length < 600);
});

test("describeUnreadPdfPages names a page read only in part, with or without unread pages", () => {
  const both = describeUnreadPdfPages([4, 5], 40, 3);
  assert.match(both, /pages 4, 5\./);
  assert.match(both, /page 3 was read only in part, and any page after it was not read/);
  const partialOnly = describeUnreadPdfPages([], 40, 7);
  assert.match(partialOnly, /scanned pages were cut off: page 7 was read only in part/);
  assert.doesNotMatch(partialOnly, /no extractable text/);
  assert.match(partialOnly, /Do not describe/);
});

// Review r-20261128-052701-5bbed8: what the model got of a scanned PDF, and
// whether its text may be stored, is decided in one place.
test("pdfReadingOutcome: everything answered is cacheable; a gap, a cut or an original sent is not", () => {
  const whole = { pageNumbers: [1, 2, 3], truncated: false, truncatedPage: null };
  assert.deepEqual(pdfReadingOutcome({ expectedPages: [1, 2, 3], ocr: whole }), {
    unreadPages: [],
    partialPage: null,
    cacheable: true,
  });
  // A page the provider skipped.
  assert.deepEqual(pdfReadingOutcome({ expectedPages: [1, 2, 3], ocr: { ...whole, pageNumbers: [1] } }), {
    unreadPages: [2, 3],
    partialPage: null,
    cacheable: false,
  });
  // The budget cut page 2: it is partly read, page 3 is not read, neither is cacheable.
  assert.deepEqual(
    pdfReadingOutcome({ expectedPages: [1, 2, 3], ocr: { pageNumbers: [1], truncated: true, truncatedPage: 2 } }),
    { unreadPages: [3], partialPage: 2, cacheable: false }
  );
  // OCR not run: every page asked for is unread.
  assert.deepEqual(pdfReadingOutcome({ expectedPages: [2, 4], ocr: null }), {
    unreadPages: [2, 4],
    partialPage: null,
    cacheable: false,
  });
  // The page count is not known and the text was cut: only the cut is reported.
  assert.deepEqual(
    pdfReadingOutcome({ expectedPages: [], ocr: { pageNumbers: [1], truncated: true, truncatedPage: 2 } }),
    { unreadPages: [], partialPage: 2, cacheable: false }
  );
  // The model has the file itself: nothing is unread, and the text alone is never stored.
  assert.deepEqual(pdfReadingOutcome({ expectedPages: [2, 4], ocr: null, originalSentToModel: true }), {
    unreadPages: [],
    partialPage: null,
    cacheable: false,
  });
});

test("the turn after the original was sent, the earlier message reads only the text-less pages and may then be stored", () => {
  // Turn 1: the model got the original; the text layer is not stored as the file.
  assert.equal(pdfReadingOutcome({ expectedPages: [2, 4], ocr: null, originalSentToModel: true }).cacheable, false);
  // Turn 2: the file is an earlier message's, so OCR reads pages 2 and 4 and both come back whole.
  const outcome = pdfReadingOutcome({
    expectedPages: [2, 4],
    ocr: { pageNumbers: [2, 4], truncated: false, truncatedPage: null },
  });
  assert.deepEqual(outcome, { unreadPages: [], partialPage: null, cacheable: true });
});
