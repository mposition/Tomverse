import assert from "node:assert/strict";
import test from "node:test";
import {
  PDF_PAGE_NOTICE_MAX_CHARACTERS,
  describeUnreadPdfPages,
  formatPdfPageRanges,
  extractPdfTextSafely,
  extractPdfTextWithPagesSafely,
  pdfReadingOutcome,
  pdfTextCharacterBudget,
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

test("formatPdfPageRanges compresses runs, caps the list and counts the rest", () => {
  assert.equal(formatPdfPageRanges([3]), "3");
  assert.equal(formatPdfPageRanges([3, 5]), "3, 5");
  assert.equal(formatPdfPageRanges([5, 3, 4, 9, 12, 13, 14]), "3-5, 9, 12-14");
  assert.equal(formatPdfPageRanges([1, 3, 5, 7, 9], 3), "1, 3, 5 and 2 more pages");
  assert.equal(formatPdfPageRanges([1, 3, 5, 7], 3), "1, 3, 5 and 1 more page");
  assert.equal(formatPdfPageRanges([]), "");
});

test("describeUnreadPdfPages names scanned, partly read and not-reached pages, each only when there are any", () => {
  const scanned = describeUnreadPdfPages({ unreadPages: [3, 5] });
  assert.match(scanned, /no extractable text \(scanned or image-only\) were not read: 3, 5\./);
  assert.doesNotMatch(scanned, /Read only in part|text limit/);
  const partial = describeUnreadPdfPages({ partialPages: [7] });
  assert.match(partial, /Read only in part \(cut off\): 7\./);
  const budget = describeUnreadPdfPages({ budgetUnreadPages: [12, 13, 14, 15] });
  assert.match(budget, /Not read because the text limit for this request was reached: 12-15\./);
  assert.match(budget, /Document truncated/);
  assert.match(budget, /Do not describe/);
});

// Review r-20261128-053429-7a866b: the notice must always fit in the room set aside for it.
test("the page notice never passes its reserved room, however many pages are named", () => {
  const worst = describeUnreadPdfPages({
    // Every other page of a 500-page file, so no run compresses.
    unreadPages: Array.from({ length: 250 }, (_, i) => i * 2 + 1),
    partialPages: Array.from({ length: 50 }, (_, i) => i * 2 + 1000),
    budgetUnreadPages: Array.from({ length: 250 }, (_, i) => i * 2 + 2000),
  });
  assert.ok(worst.length <= PDF_PAGE_NOTICE_MAX_CHARACTERS, `${worst.length} characters`);
  assert.ok(describeUnreadPdfPages({ unreadPages: [1] }).length <= PDF_PAGE_NOTICE_MAX_CHARACTERS);
});

test("the text budget sets the notice's room aside first, at every edge", () => {
  const MAX = PDF_PAGE_NOTICE_MAX_CHARACTERS;
  // No room left, or only the margin, or only the margin and the notice: no room for the file.
  for (const remaining of [-5, 0, 1, 63, 64, 65, 64 + MAX - 1, 64 + MAX]) {
    assert.equal(pdfTextCharacterBudget(remaining), 0, `remaining ${remaining}`);
  }
  // One character past that, and the file may take one.
  assert.equal(pdfTextCharacterBudget(64 + MAX + 1), 1);
  assert.equal(pdfTextCharacterBudget(2_000_000), 2_000_000 - 64 - MAX);
  // Text at its budget plus the longest notice stays within what the other extractors may use.
  for (const remaining of [64 + MAX + 1, 64 + MAX + 2, 64 + 2 * MAX, 5_000, 2_000_000]) {
    assert.ok(pdfTextCharacterBudget(remaining) + MAX <= remaining - 64, `remaining ${remaining}`);
  }
});

test("a text pass that hits the limit says where it stopped, and the pages after are not scans", async () => {
  const pdf = buildLinePdf([["Alpha beta gamma"], ["Delta epsilon"], [], ["Zeta"]]);
  const whole = await extractPdfTextWithPagesSafely(pdf, 5_000);
  assert.deepEqual([whole.budgetUnreadPages, whole.budgetPartialPage], [[], null]);
  assert.deepEqual(whole.textlessPages, [3]);

  const first = "[Page 1]\nAlpha beta gamma";
  // The limit lands exactly at the end of page 1: page 1 is whole, 2-4 were never looked at.
  const atEdge = await extractPdfTextWithPagesSafely(pdf, first.length);
  assert.equal(atEdge.text, first);
  assert.deepEqual([atEdge.budgetUnreadPages, atEdge.budgetPartialPage], [[2, 3, 4], null]);
  assert.deepEqual(atEdge.textlessPages, [], "page 3 is a scan, but nobody looked");
  // One character earlier: page 1 is cut in the middle.
  const inside = await extractPdfTextWithPagesSafely(pdf, first.length - 1);
  assert.deepEqual([inside.budgetUnreadPages, inside.budgetPartialPage], [[2, 3, 4], 1]);
  // Text first, the scan after it, the limit not reached before it: the scan is found.
  const reachScan = await extractPdfTextWithPagesSafely(pdf, "[Page 1]\nAlpha beta gamma\n\n[Page 2]\nDelta epsilon".length + 1);
  assert.deepEqual(reachScan.textlessPages, [3]);
  assert.deepEqual([reachScan.budgetUnreadPages, reachScan.budgetPartialPage], [[], 4]);
  // The limit cuts the last page: it is partly read and nothing follows it.
  const lastPdf = buildLinePdf([["Alpha"], ["Omega omega omega"]]);
  const cutLast = await extractPdfTextWithPagesSafely(lastPdf, "[Page 1]\nAlpha\n\n[Page 2]\nOmega".length);
  assert.deepEqual([cutLast.budgetUnreadPages, cutLast.budgetPartialPage], [[], 2]);
});

// Review r-20261128-052701-5bbed8: what the model got of a PDF, and whether its
// text may be stored, is decided in one place.
test("pdfReadingOutcome: everything answered is cacheable; a gap, a cut, a stop or an original sent is not", () => {
  const whole = { pageNumbers: [1, 2, 3], truncated: false, truncatedPage: null };
  assert.deepEqual(pdfReadingOutcome({ expectedPages: [1, 2, 3], ocr: whole }), {
    unreadPages: [],
    partialPages: [],
    budgetUnreadPages: [],
    pageCountUnknown: false,
    cacheable: true,
  });
  // A page the provider skipped.
  assert.deepEqual(pdfReadingOutcome({ expectedPages: [1, 2, 3], ocr: { ...whole, pageNumbers: [1] } }), {
    unreadPages: [2, 3],
    partialPages: [],
    budgetUnreadPages: [],
    pageCountUnknown: false,
    cacheable: false,
  });
  // The OCR budget cut page 2: it is partly read, page 3 is not read.
  assert.deepEqual(
    pdfReadingOutcome({ expectedPages: [1, 2, 3], ocr: { pageNumbers: [1], truncated: true, truncatedPage: 2 } }),
    { unreadPages: [3], partialPages: [2], budgetUnreadPages: [], pageCountUnknown: false, cacheable: false }
  );
  // OCR not run: every page asked for is unread.
  assert.deepEqual(pdfReadingOutcome({ expectedPages: [2, 4], ocr: null }), {
    unreadPages: [2, 4],
    partialPages: [],
    budgetUnreadPages: [],
    pageCountUnknown: false,
    cacheable: false,
  });
  // The page count is not known and the text was cut: only the cut is reported.
  assert.deepEqual(
    pdfReadingOutcome({ expectedPages: [], ocr: { pageNumbers: [1], truncated: true, truncatedPage: 2 } }),
    { unreadPages: [], partialPages: [2], budgetUnreadPages: [], pageCountUnknown: false, cacheable: false }
  );
  // The text pass stopped at the limit: its pages are named, kept apart from the scans, and the text is not the file.
  assert.deepEqual(
    pdfReadingOutcome({
      expectedPages: [],
      ocr: null,
      budgetUnreadPages: [8, 9, 10],
      budgetPartialPage: 7,
    }),
    { unreadPages: [], partialPages: [7], budgetUnreadPages: [8, 9, 10], pageCountUnknown: false, cacheable: false }
  );
  // Scans read whole after a text pass that stopped short: still not cacheable.
  assert.equal(
    pdfReadingOutcome({ expectedPages: [3], ocr: { pageNumbers: [3], truncated: false, truncatedPage: null }, budgetUnreadPages: [5] }).cacheable,
    false
  );
  // The model has the file itself: nothing is unread, and the text alone is never stored.
  assert.deepEqual(pdfReadingOutcome({ expectedPages: [2, 4], ocr: null, originalSentToModel: true }), {
    unreadPages: [],
    partialPages: [],
    budgetUnreadPages: [],
    pageCountUnknown: false,
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
  assert.deepEqual(outcome, { unreadPages: [], partialPages: [], budgetUnreadPages: [], pageCountUnknown: false, cacheable: true });
});

// Review r-20261128-054317-1a725b.
test("validatePdfSafely answers the page count, so a file whose text pass failed still has one", async () => {
  assert.deepEqual(await validatePdfSafely(buildLinePdf([["a"], [], ["c"]])), { pageCount: 3 });
  assert.deepEqual(await validatePdfSafely(createQaPdfBuffer()), { pageCount: 1 });
});

test("a scanned file read by OCR with no known page count names that, and is never stored", () => {
  const ocr = { pageNumbers: [1], truncated: false, truncatedPage: null };
  const outcome = pdfReadingOutcome({ expectedPages: [], ocr, pageCountUnknown: true });
  assert.deepEqual(outcome, {
    unreadPages: [],
    partialPages: [],
    budgetUnreadPages: [],
    pageCountUnknown: true,
    cacheable: false,
  });
  assert.match(describeUnreadPdfPages(outcome), /page count unknown/);
  // With the count known, the same answer is judged page by page.
  assert.equal(pdfReadingOutcome({ expectedPages: [1], ocr, pageCountUnknown: false }).cacheable, true);
  // The flag means nothing without OCR text to judge.
  assert.equal(pdfReadingOutcome({ expectedPages: [], ocr: null, pageCountUnknown: true }).pageCountUnknown, false);
  assert.ok(describeUnreadPdfPages({ ...outcome, unreadPages: [2], partialPages: [3], budgetUnreadPages: [4] }).length <= PDF_PAGE_NOTICE_MAX_CHARACTERS);
});
