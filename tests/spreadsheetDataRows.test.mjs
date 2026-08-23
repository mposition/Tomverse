import assert from "node:assert/strict";
import test from "node:test";

import {
  SPREADSHEET_DATA_LIMITS,
  SpreadsheetDataError,
  excelSerialToDisplay,
  parseCsvGrid,
  readSpreadsheetDataRows,
} from "../lib/spreadsheetDataRows.ts";
import { buildXlsx } from "./fixtures/officeFixtures.mjs";

// docs/policy/generated-artifacts.md section 13.
//
// The point of reading the workbook here rather than letting the model retype
// what it saw in extracted text: a date that Excel displays as 1990-03-04 is
// stored as the number 32936, and a model copying from a flattened blob has no
// way to be reliably right about which row it belonged to.

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const HEADERS = ["이름", "생년월일", "입사일", "소속팀"];

const workbook = (rows, sheetName = "명단") =>
  buildXlsx({ sheetName, rows: [HEADERS, ...rows] });

test("the first row is the header and every later row is a record", () => {
  const data = readSpreadsheetDataRows(
    workbook([
      ["김민수", { date: "1990-03-04" }, { date: "2026-04-01" }, "플랫폼팀"],
      ["이서연", { date: "1993-11-20" }, { date: "2026-04-15" }, "디자인팀"],
    ]),
    { mediaType: XLSX }
  );
  assert.deepEqual(data.columns, HEADERS);
  assert.equal(data.sheetName, "명단");
  assert.deepEqual(data.rows, [
    {
      이름: "김민수",
      생년월일: "1990-03-04",
      입사일: "2026-04-01",
      소속팀: "플랫폼팀",
    },
    {
      이름: "이서연",
      생년월일: "1993-11-20",
      입사일: "2026-04-15",
      소속팀: "디자인팀",
    },
  ]);
});

test("a date cell reads as the day Excel displays, not as its serial", () => {
  const data = readSpreadsheetDataRows(
    workbook([["김민수", { date: "1990-03-04" }, { date: "2026-04-01" }, "플랫폼팀"]]),
    { mediaType: XLSX }
  );
  assert.equal(data.rows[0].생년월일, "1990-03-04");
});

// The 1899-12-30 epoch, which is what reproduces Excel's own 1900
// leap-year bug for every date from 1900-03-01 onwards. Getting it wrong
// shifts every date in every generated document by a day or two, silently and
// consistently -- the worst shape a defect can have.
//
// Serials 1 to 59 (1900-01-01 to 1900-02-28) are the known exception: Excel
// counts a 29 February 1900 that did not exist, so this reads them one day
// early. Documented rather than corrected, because the correction would be a
// second epoch for a two-month window nobody's birth date falls in, and the
// place it would be wrong is the place the bug lives.
test("the Excel epoch is 1899-12-30", () => {
  assert.equal(excelSerialToDisplay(32936, { withTime: false }), "1990-03-04");
  assert.equal(excelSerialToDisplay(46113, { withTime: false }), "2026-04-01");
  assert.equal(
    excelSerialToDisplay(32936.5, { withTime: true }),
    "1990-03-04 12:00"
  );
  // The documented off-by-one, pinned so it is a decision and not a surprise.
  assert.equal(excelSerialToDisplay(1, { withTime: false }), "1899-12-31");
});

test("a plain number keeps its value without exponent notation", () => {
  const data = readSpreadsheetDataRows(
    buildXlsx({
      rows: [
        ["code", "amount"],
        ["A", { number: 1234567 }],
        ["B", { number: 0.5 }],
      ],
    }),
    { mediaType: XLSX }
  );
  assert.equal(data.rows[0].amount, "1234567");
  assert.equal(data.rows[1].amount, "0.5");
});

test("a blank row is skipped rather than becoming an empty record", () => {
  const data = readSpreadsheetDataRows(
    workbook([
      ["김민수", { date: "1990-03-04" }, { date: "2026-04-01" }, "플랫폼팀"],
      ["", "", "", ""],
      ["이서연", { date: "1993-11-20" }, { date: "2026-04-15" }, "디자인팀"],
    ]),
    { mediaType: XLSX }
  );
  assert.equal(data.rows.length, 2);
  assert.equal(data.rows[1].이름, "이서연");
});

test("a missing cell reads as an empty string, not as a shifted column", () => {
  const data = readSpreadsheetDataRows(
    workbook([["김민수", null, { date: "2026-04-01" }, "플랫폼팀"]]),
    { mediaType: XLSX }
  );
  assert.equal(data.rows[0].생년월일, "");
  assert.equal(data.rows[0].입사일, "2026-04-01");
});

test("a named worksheet is selected, and an unknown one is an error", () => {
  const bytes = workbook([["김민수", "", "", "플랫폼팀"]], "직원");
  assert.equal(
    readSpreadsheetDataRows(bytes, { mediaType: XLSX, sheet: "직원" }).sheetName,
    "직원"
  );
  assert.throws(
    () => readSpreadsheetDataRows(bytes, { mediaType: XLSX, sheet: "없음" }),
    (error) =>
      error instanceof SpreadsheetDataError &&
      error.code === "DATA_SHEET_NOT_FOUND"
  );
});

test("two columns with the same header are an error, not a silent overwrite", () => {
  assert.throws(
    () =>
      readSpreadsheetDataRows(
        buildXlsx({ rows: [["이름", "이름"], ["김민수", "이서연"]] }),
        { mediaType: XLSX }
      ),
    (error) =>
      error instanceof SpreadsheetDataError &&
      error.code === "DATA_DUPLICATE_COLUMN"
  );
});

test("a header with no data rows is an error", () => {
  assert.throws(
    () => readSpreadsheetDataRows(workbook([]), { mediaType: XLSX }),
    (error) =>
      error instanceof SpreadsheetDataError && error.code === "DATA_NO_ROWS"
  );
});

test("more rows than the ceiling is an error rather than a truncation", () => {
  const rows = Array.from({ length: SPREADSHEET_DATA_LIMITS.maxRows + 1 }, (_, index) => [
    `사람${index}`,
    "",
    "",
    "팀",
  ]);
  assert.throws(
    () => readSpreadsheetDataRows(workbook(rows), { mediaType: XLSX }),
    (error) =>
      error instanceof SpreadsheetDataError &&
      error.code === "DATA_TOO_MANY_ROWS"
  );
});

test("bytes that are not a workbook are refused", () => {
  assert.throws(
    () =>
      readSpreadsheetDataRows(new TextEncoder().encode("nope"), {
        mediaType: XLSX,
      }),
    (error) =>
      error instanceof SpreadsheetDataError && error.code === "DATA_UNREADABLE"
  );
});

/* -------------------------------------------------------------------------- */
/* CSV                                                                          */
/* -------------------------------------------------------------------------- */

test("a CSV reads as the same kind of record set", () => {
  const data = readSpreadsheetDataRows(
    new TextEncoder().encode(
      "이름,소속팀\r\n김민수,플랫폼팀\r\n이서연,디자인팀\r\n"
    ),
    { mediaType: "text/csv" }
  );
  assert.deepEqual(data.columns, ["이름", "소속팀"]);
  assert.equal(data.rows.length, 2);
  assert.equal(data.rows[1].소속팀, "디자인팀");
});

test("quoted commas and doubled quotes survive the CSV parse", () => {
  assert.deepEqual(parseCsvGrid('a,"b,c","d""e"'), [["a", "b,c", 'd"e']]);
});

test("the byte order mark Excel writes is not part of the first header", () => {
  const data = readSpreadsheetDataRows(
    new TextEncoder().encode("﻿이름,소속팀\n김민수,플랫폼팀\n"),
    { mediaType: "text/csv" }
  );
  assert.deepEqual(data.columns, ["이름", "소속팀"]);
});
