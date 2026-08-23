import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync } from "fflate";

import {
  DocxBatchError,
  batchDateFolder,
  buildDocxBatchEntries,
} from "../lib/generatedArtifactDocxBatch.ts";
import { ARTIFACT_LIMITS } from "../lib/generatedArtifactCore.ts";
import { buildDocxTemplate, buildXlsx } from "./fixtures/officeFixtures.mjs";

// docs/policy/generated-artifacts.md section 13.
//
// The request this exists for: "fill this contract template once for each of
// these ten people". Before it, the answer was a refusal -- the model had been
// told an answer may attach at most three files, and concluded that ten
// documents were impossible. They were always possible; they just had to be
// one archive.

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const NOW = new Date("2026-08-22T09:00:00Z");
const decoder = new TextDecoder();

const TEAMS = ["플랫폼팀", "디자인팀", "영업팀"];

const person = (index) => [
  `직원${String(index).padStart(2, "0")}`,
  { date: `199${index % 10}-03-04` },
  { date: "2026-04-01" },
  TEAMS[index % TEAMS.length],
];

const roster = (count) =>
  buildXlsx({
    sheetName: "명단",
    rows: [
      ["이름", "생년월일", "입사일", "소속팀"],
      ...Array.from({ length: count }, (_, index) => person(index + 1)),
    ],
  });

const batch = (overrides = {}) =>
  buildDocxBatchEntries({
    templateBytes: buildDocxTemplate(),
    dataBytes: roster(10),
    dataMediaType: XLSX,
    filenameTemplate: "{{이름}}_근로계약서",
    now: NOW,
    ...overrides,
  });

const documentTextOf = (bytes) =>
  decoder.decode(unzipSync(bytes)["word/document.xml"]);

/* -------------------------------------------------------------------------- */
/* Ten rows, ten documents, one archive                                         */
/* -------------------------------------------------------------------------- */

test("a ten-row spreadsheet produces ten documents", () => {
  const result = batch();
  assert.equal(result.entries.length, 10);
  assert.equal(result.sheetName, "명단");
  assert.deepEqual(result.columns, ["이름", "생년월일", "입사일", "소속팀"]);
});

test("each document carries its own row's values and no other row's", () => {
  const result = batch();
  result.entries.forEach((entry, index) => {
    const text = documentTextOf(entry.bytes);
    const name = `직원${String(index + 1).padStart(2, "0")}`;
    assert.equal(text.includes(name), true, `${name} missing from its document`);
    assert.equal(text.includes(`199${(index + 1) % 10}-03-04`), true);
    assert.equal(text.includes("{{"), false);
    // The decisive assertion: nobody else's name is in this file.
    for (let other = 1; other <= 10; other += 1) {
      if (other === index + 1) continue;
      const otherName = `직원${String(other).padStart(2, "0")}`;
      assert.equal(
        text.includes(otherName),
        false,
        `${otherName} leaked into ${name}'s document`
      );
    }
  });
});

test("the header and footer are filled per row as well as the body", () => {
  const result = batch();
  const first = unzipSync(result.entries[0].bytes);
  assert.match(decoder.decode(first["word/header1.xml"]), /플랫폼팀|디자인팀|영업팀/);
  assert.match(decoder.decode(first["word/footer1.xml"]), /2026-04-01/);
});

test("every document keeps the template's styles, theme, table and image", () => {
  const template = buildDocxTemplate();
  const source = unzipSync(template);
  for (const entry of batch({ templateBytes: template }).entries) {
    const parts = unzipSync(entry.bytes);
    assert.deepEqual(parts["word/styles.xml"], source["word/styles.xml"]);
    assert.deepEqual(parts["word/theme/theme1.xml"], source["word/theme/theme1.xml"]);
    assert.deepEqual(parts["word/media/image1.png"], source["word/media/image1.png"]);
    const document = decoder.decode(parts["word/document.xml"]);
    assert.match(document, /<w:tblStyle w:val="TomverseGrid"\/>/);
    assert.match(document, /<w:headerReference/);
    assert.match(document, /<w:pgSz w:w="11906"/);
  }
});

/* -------------------------------------------------------------------------- */
/* Naming                                                                       */
/* -------------------------------------------------------------------------- */

test("paths are YYYYMMDD/<sanitised name>.docx", () => {
  const result = batch();
  assert.equal(batchDateFolder(NOW), "20260822");
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    Array.from(
      { length: 10 },
      (_, index) =>
        `20260822/직원${String(index + 1).padStart(2, "0")}_근로계약서.docx`
    )
  );
});

test("a name that would escape the archive is reduced to a name", () => {
  const result = buildDocxBatchEntries({
    templateBytes: buildDocxTemplate(),
    dataBytes: buildXlsx({
      rows: [
        ["이름", "생년월일", "입사일", "소속팀"],
        ["../../etc/passwd", "1990-03-04", "2026-04-01", "플랫폼팀"],
      ],
    }),
    dataMediaType: XLSX,
    filenameTemplate: "{{이름}}",
    now: NOW,
  });
  assert.equal(result.entries[0].path, "20260822/passwd.docx");
});

test("duplicate names are made unique deterministically, in row order", () => {
  const rows = [
    ["이름", "생년월일", "입사일", "소속팀"],
    ["김민수", "1990-01-01", "2026-04-01", "플랫폼팀"],
    ["김민수", "1991-01-01", "2026-04-01", "디자인팀"],
    ["김민수", "1992-01-01", "2026-04-01", "영업팀"],
  ];
  const build = () =>
    buildDocxBatchEntries({
      templateBytes: buildDocxTemplate(),
      dataBytes: buildXlsx({ rows }),
      dataMediaType: XLSX,
      filenameTemplate: "{{이름}}",
      now: NOW,
    }).entries.map((entry) => entry.path);
  assert.deepEqual(build(), [
    "20260822/김민수.docx",
    "20260822/김민수-2.docx",
    "20260822/김민수-3.docx",
  ]);
  // Same inputs, same names, same order -- so a re-run is comparable.
  assert.deepEqual(build(), build());
});

/* -------------------------------------------------------------------------- */
/* Word compatibility                                                           */
/* -------------------------------------------------------------------------- */

// A generator that produces bytes only its own reader can open has not
// produced a document. `officeparser` is the parser this application already
// uses to read uploaded .docx files, so it is an independent reader of the
// same package -- and it is the one that says whether the value actually
// landed in the document text rather than merely in the XML.
test("every generated document reopens in a Word-compatible parser", async () => {
  const { OfficeParser } = await import("officeparser");
  const result = batch();
  for (const [index, entry] of result.entries.entries()) {
    const parsed = await OfficeParser.parseOffice(Buffer.from(entry.bytes), {
      extractAttachments: false,
      ocr: false,
    });
    const text = parsed.toText();
    const name = `직원${String(index + 1).padStart(2, "0")}`;
    assert.match(text, new RegExp(name));
    assert.match(text, /근로계약서/);
    assert.equal(text.includes("{{"), false);
  }
});

/* -------------------------------------------------------------------------- */
/* Limits and refusals                                                          */
/* -------------------------------------------------------------------------- */

test("a hundred rows is the archive ceiling and is accepted", () => {
  const result = batch({ dataBytes: roster(ARTIFACT_LIMITS.maxArchiveEntries) });
  assert.equal(result.entries.length, ARTIFACT_LIMITS.maxArchiveEntries);
});

test("the hundred-and-first row is refused rather than dropped", () => {
  assert.throws(
    () => batch({ dataBytes: roster(ARTIFACT_LIMITS.maxArchiveEntries + 1) }),
    (error) =>
      error instanceof DocxBatchError && error.code === "ARCHIVE_ENTRY_LIMIT"
  );
});

test("a template with no placeholders is refused, not filled with nothing", () => {
  assert.throws(
    () =>
      batch({
        templateBytes: buildDocxTemplate({
          body: "<w:p><w:r><w:t>계약서</w:t></w:r></w:p>",
          // The header and footer carry placeholders too, and they count --
          // a template is "fillable" wherever the fields are.
          overrides: {
            "word/header1.xml": "<w:hdr><w:p/></w:hdr>",
            "word/footer1.xml": "<w:ftr><w:p/></w:ftr>",
          },
        }),
      }),
    (error) =>
      error instanceof DocxBatchError &&
      error.code === "TEMPLATE_HAS_NO_PLACEHOLDERS"
  );
});

test("a row missing a required value fails the whole batch", () => {
  const rows = [
    ["이름", "생년월일", "입사일", "소속팀"],
    ["김민수", "1990-01-01", "2026-04-01", "플랫폼팀"],
    ["", "1991-01-01", "2026-04-01", "디자인팀"],
  ];
  assert.throws(
    () =>
      buildDocxBatchEntries({
        templateBytes: buildDocxTemplate(),
        dataBytes: buildXlsx({ rows }),
        dataMediaType: XLSX,
        filenameTemplate: "{{이름}}",
        requiredPlaceholders: ["이름"],
        now: NOW,
      }),
    (error) =>
      error instanceof DocxBatchError &&
      error.code === "PLACEHOLDER_MISSING" &&
      // The row is named, because "one of them is missing a name" is not
      // something anyone can act on.
      error.message.includes("Row 2")
  );
});

test("a spreadsheet column the template does not use leaves a placeholder unfilled", () => {
  // The template's four placeholders are not all present in this data, so the
  // batch refuses rather than delivering documents with braces printed in them.
  assert.throws(
    () =>
      batch({
        dataBytes: buildXlsx({
          rows: [
            ["이름", "소속팀"],
            ["김민수", "플랫폼팀"],
          ],
        }),
      }),
    (error) =>
      error instanceof DocxBatchError &&
      error.code === "PLACEHOLDER_UNRESOLVED"
  );
});

test("a macro-carrying template refuses the batch before any row is read", () => {
  assert.throws(
    () =>
      batch({
        templateBytes: buildDocxTemplate({
          overrides: { "word/vbaProject.bin": new Uint8Array([1]) },
        }),
      }),
    (error) =>
      error instanceof DocxBatchError && error.code === "TEMPLATE_MACRO_REFUSED"
  );
});

test("a data file that is not a spreadsheet is refused", () => {
  assert.throws(
    () => batch({ dataBytes: new TextEncoder().encode("not a workbook") }),
    (error) =>
      error instanceof DocxBatchError && error.code === "DATA_UNREADABLE"
  );
});
