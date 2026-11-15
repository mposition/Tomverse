import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import { admitWorkbookSpecSafely } from "../lib/generatedArtifactCore.ts";
import { renderWorkbook } from "../lib/generatedArtifactXlsx.ts";
import { readSpreadsheetGrid } from "../lib/spreadsheetDataRows.ts";
import { canonicalWorkbookSpecFor, parseCanonicalWorkbookSpec, prepareGeneratedWorkbookRevision,
  reviseCanonicalWorkbook } from "../lib/generatedArtifactWorkbookRevision.ts";
import { z } from "zod";
import { workbookSpecSchema, workbookRevisionToolSchema, documentSpecSchema, presentationSpecSchema,
  textFileSpecSchema, archiveSpecSchema, artifactRevisionOfSchema } from "../lib/generatedArtifactCore.ts";
import { estimateTextTokens } from "../lib/chatTokenEstimate.ts";
import { ARTIFACT_REVISION_TOOL_DEFINITION_TOKENS } from "../lib/generatedArtifactToolPolicy.ts";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fixture = () => {
  const result = admitWorkbookSpecSafely({ filename: "same.xlsx", styleHeader: true, worksheets: [
    { name: "Revenue", title: "Quarterly sales", freezeHeader: false, columns: [
      { key: "name", header: "Name", width: 36 },
      { key: "sales", header: "Sales", type: "number", format: "currency_usd", width: 18 },
      { header: "Date", type: "date", format: "date", width: 22 },
    ], rows: [["Keep", 0, "2026-11-14"], ["Change", 125.5, null], ["", false, null], [null, null, null]] },
    { name: "Notes", freezeHeader: true, columns: [{ header: "Item" }, { header: "Enabled" }],
      rows: [["Unchanged", true], ["Other", false], [null, null]] },
  ] });
  assert.equal(result.ok, true);
  return result.spec;
};
const bytesFor = spec => Buffer.from(renderWorkbook(spec, "xlsx").bytes);

test("canonical sheet identities match actual XML after writer normalization", () => {
  const admitted = admitWorkbookSpecSafely({ filename: "names.xlsx", worksheets: [
    { name: "A\u0001", columns: [{ header: "Value" }], rows: [[1]] },
    { name: "A", columns: [{ header: "Value" }], rows: [[2]] },
  ] });
  assert.ok(admitted.ok);
  const canonical = canonicalWorkbookSpecFor(admitted.spec);
  assert.ok(canonical);
  assert.deepEqual(canonical.spec.worksheets.map(sheet => sheet.name), ["A", "A (2)"]);
  const xml = new TextDecoder().decode(unzipSync(bytesFor(admitted.spec))["xl/workbook.xml"]);
  assert.match(xml, /sheet name="A"/);
  assert.match(xml, /sheet name="A \(2\)"/);
  const blankHeader = structuredClone(admitted.spec);
  blankHeader.worksheets[0].columns[0].header = "\u0001";
  assert.equal(canonicalWorkbookSpecFor(blankHeader), null);
});
const grid = (bytes, sheet = "Revenue") => readSpreadsheetGrid(bytes, { mediaType: XLSX, sheet,
  maxRows: 10001, maxValueLength: 20000, preserveEmptyRows: true });

test("canonical cell edits preserve every untouched sheet, column, type, width, format and empty row twice", () => {
  const spec = fixture(), source = canonicalWorkbookSpecFor(spec);
  assert.ok(source);
  const original = bytesFor(spec), originalHash = hash(original);
  const first = reviseCanonicalWorkbook(source, "same.xlsx", [{ sheet: "Revenue", row: 2, column: 2, value: 250 }]);
  const secondSource = canonicalWorkbookSpecFor(first);
  const second = reviseCanonicalWorkbook(secondSource, "same.xlsx", [{ sheet: "Notes", row: 2, column: 1, value: "Revised" }]);
  const expected = structuredClone(spec);
  expected.worksheets[0].rows[1][1] = 250;
  assert.deepEqual(first, expected);
  expected.worksheets[1].rows[1][0] = "Revised";
  assert.deepEqual(second, expected);
  assert.equal(hash(original), originalHash);
  const firstBytes = bytesFor(first), secondBytes = bytesFor(second);
  assert.notEqual(hash(firstBytes), originalHash);
  assert.notEqual(hash(secondBytes), hash(firstBytes));
  assert.deepEqual(grid(secondBytes).grid, grid(firstBytes).grid);
  assert.equal(grid(secondBytes, "Notes").grid[2][0], "Revised");
  assert.equal(second.worksheets[0].rows[2][0], "");
  assert.equal(second.worksheets[0].rows[2][1], false);
  assert.equal(second.worksheets[0].rows[0][1], 0);
  assert.equal(second.worksheets[0].rows[0][2], "2026-11-14");
});

test("existing Office parser plus physical grid reconstructs old titled multi-sheet files without dropping blank rows", async () => {
  const original = bytesFor(fixture()), before = hash(original);
  const legacy = await prepareGeneratedWorkbookRevision(original, null, "same.xlsx");
  assert.equal(legacy.fidelity, "values");
  assert.deepEqual(legacy.spec.worksheets.map(sheet => sheet.name), ["Revenue", "Notes"]);
  assert.equal(legacy.spec.worksheets[0].title, "Quarterly sales");
  assert.equal(legacy.spec.worksheets[0].rows[0][1], 0);
  assert.equal(legacy.spec.worksheets[0].rows[0][2], "2026-11-14");
  assert.deepEqual(legacy.spec.worksheets[0].rows[2], ["", false, null]);
  assert.deepEqual(legacy.spec.worksheets[0].rows[3], [null, null, null]);
  assert.deepEqual(legacy.spec.worksheets[1].rows[2], [null, null]);
  assert.equal(legacy.spec.worksheets[0].columns[1].format, "currency_usd");
  assert.equal(legacy.spec.worksheets[0].columns[0].width, undefined);
  const revised = reviseCanonicalWorkbook(legacy, "same.xlsx", [{ sheet: "Revenue", row: 2, column: 2, value: 300 }]);
  assert.equal(grid(bytesFor(revised)).grid[3][1], "$300.00");
  assert.equal(hash(original), before);
  assert.equal((await prepareGeneratedWorkbookRevision(original, legacy)).fidelity, "values");
});

test("invalid versions, unknown metadata, oversized snapshots and invalid existing-cell edits are refused", () => {
  const source = canonicalWorkbookSpecFor(fixture());
  assert.equal(parseCanonicalWorkbookSpec({ ...source, version: 2 }), null);
  assert.equal(parseCanonicalWorkbookSpec({ ...source, objectKey: "not-accepted" }), null);
  const large = fixture(); large.worksheets[0].rows = Array.from({ length: 20 }, () => ["x".repeat(20000), 1, null]);
  assert.equal(canonicalWorkbookSpecFor(large), null, "large ordinary outputs need not retain a revision snapshot");
  for (const updates of [[], [{ sheet: "missing", row: 1, column: 1, value: 1 }],
    [{ sheet: "Revenue", row: 0, column: 1, value: 1 }], [{ sheet: "Revenue", row: 5, column: 1, value: 1 }],
    [{ sheet: "Revenue", row: 1, column: 4, value: 1 }],
    [{ sheet: "Revenue", row: 1, column: 1, value: 1 }, { sheet: "Revenue", row: 1, column: 1, value: 2 }],
    [{ sheet: "Revenue", row: 1, column: 1, value: { formula: "SUM(A1:A2)" } }]]) {
    assert.throws(() => reviseCanonicalWorkbook(source, "same.xlsx", updates));
  }
  assert.deepEqual(source.spec, fixture());
});

test("canonical snapshots remove XML-forbidden control characters rather than breaking JSONB persistence", () => {
  const spec = fixture(); spec.worksheets[0].rows[0][0] = "A\u0000B\u0001C";
  const source = canonicalWorkbookSpecFor(spec);
  assert.equal(source.spec.worksheets[0].rows[0][0], "ABC");
  assert.ok(!JSON.stringify(source).includes("\\u0000"));
  assert.equal(spec.worksheets[0].rows[0][0], "A\u0000B\u0001C");
  spec.worksheets[0].rows[0][0] = String.raw`literal \u0000 value`;
  assert.equal(canonicalWorkbookSpecFor(spec).spec.worksheets[0].rows[0][0], String.raw`literal \u0000 value`);
  spec.worksheets[0].rows[0][0] = "unpaired \ud800";
  assert.equal(canonicalWorkbookSpecFor(spec).spec.worksheets[0].rows[0][0], "unpaired \ufffd");
});

const mutate = (bytes, operation) => {
  const parts = unzipSync(bytes), key = "xl/worksheets/sheet1.xml";
  parts[key] = new TextEncoder().encode(operation(new TextDecoder().decode(parts[key])));
  return Buffer.from(zipSync(parts));
};

test("legacy formulas and merges are rejected rather than reported as preserved", async () => {
  const source = bytesFor(fixture());
  for (const changed of [
    mutate(source, xml => xml.replace('<v>0</v>', '<f>1+1</f><v>2</v>')),
    mutate(source, xml => xml.replace('</worksheet>', '<mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells></worksheet>')),
  ]) await assert.rejects(prepareGeneratedWorkbookRevision(changed, null, "same.xlsx"));
});

test("physical-grid revision bounds reject extreme sparse positions before padding", () => {
  const source = bytesFor(fixture());
  const farRow = mutate(source, xml => xml.replace('<row r="3">', '<row r="1048576">'));
  assert.throws(() => grid(farRow));
  const farColumn = mutate(source, xml => xml.replace('r="A3"', 'r="XFD3"'));
  assert.throws(() => grid(farColumn));
});

test("the separately gated revision schema allowance covers the measured schema expansion", () => {
  const original = [workbookSpecSchema, documentSpecSchema, presentationSpecSchema, textFileSpecSchema, archiveSpecSchema];
  const revised = [workbookRevisionToolSchema, ...original.slice(1).map(schema => schema.extend({ revisionOf: artifactRevisionOfSchema.optional() }))];
  const serialized = schemas => JSON.stringify(schemas.map(schema => z.toJSONSchema(schema, { io: "input" })));
  const delta = estimateTextTokens(serialized(revised)) - estimateTextTokens(serialized(original));
  assert.ok(delta > 0);
  assert.ok(delta <= ARTIFACT_REVISION_TOOL_DEFINITION_TOKENS,
    `revision schemas add ${delta} estimated input tokens`);
});

test("a titled legacy sheet at the data-row limit retains its last row", async () => {
  const admitted = admitWorkbookSpecSafely({ filename: "large.xlsx", worksheets: [{ name: "Large", title: "Title",
    columns: [{ header: "Item" }], rows: Array.from({ length: 10000 }, (_, index) => [index === 9999 ? "FINAL_ROW" : index]) }] });
  assert.equal(admitted.ok, true);
  const legacy = await prepareGeneratedWorkbookRevision(bytesFor(admitted.spec), null, "large.xlsx");
  assert.equal(legacy.spec.worksheets[0].rows.length, 10000);
  assert.equal(legacy.spec.worksheets[0].rows[9999][0], "FINAL_ROW");
});
