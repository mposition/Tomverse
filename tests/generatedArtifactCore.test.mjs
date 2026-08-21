import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_LIMITS,
  ARTIFACT_MEDIA_TYPES,
  admitWorkbookSpecSafely,
  artifactContentDisposition,
  artifactDownloadPath,
  asciiArtifactFilename,
  csvCell,
  formatArtifactSize,
  isSupportedArtifactFormat,
  needsFormulaGuard,
  parseChatStreamArtifact,
  parseChatStreamArtifacts,
  PERSISTED_ARTIFACT_STATUSES,
  sanitizeArtifactFilename,
  SUPPORTED_ARTIFACT_FORMATS,
} from "../lib/generatedArtifactCore.ts";

// docs/policy/generated-artifacts.md sections 3, 4, 5 and 6.

const sheet = (rows) => ({
  filename: "report.xlsx",
  worksheets: [
    {
      name: "Sheet1",
      columns: [{ header: "A" }, { header: "B" }],
      rows,
    },
  ],
});

/* -------------------------------------------------------------------------- */
/* File names                                                                   */
/* -------------------------------------------------------------------------- */

test("a path traversal loses its path, not its name", () => {
  assert.equal(
    sanitizeArtifactFilename("../../../etc/passwd", "xlsx"),
    "passwd.xlsx"
  );
  assert.equal(
    sanitizeArtifactFilename("..\\..\\windows\\system32\\cmd", "xlsx"),
    "cmd.xlsx"
  );
});

test("the extension comes from the format, never from the input", () => {
  // The double-extension trick, and a format the caller simply got wrong.
  assert.equal(sanitizeArtifactFilename("report.xlsx.exe", "xlsx"), "report.xlsx.exe.xlsx");
  assert.equal(sanitizeArtifactFilename("report.pdf", "xlsx"), "report.xlsx");
  assert.equal(sanitizeArtifactFilename("report.xlsx", "csv"), "report.csv");
});

test("control characters and bidirectional overrides are removed", () => {
  // U+202E renders "gpj.exe" as "exe.jpg"; a file name is exactly where that
  // matters.
  // Escapes, not literals: a literal control byte makes git call the file
  // binary, and a pull request touching it shows no diff at all.
  const name = sanitizeArtifactFilename(
    "in\u0000voi\u202ece\u0007",
    "xlsx"
  );
  assert.equal(name, "invoice.xlsx");
  assert.ok(!/[\u0000-\u001f\u202a-\u202e]/.test(name));
});

test("a name made only of dots is not a name", () => {
  assert.equal(sanitizeArtifactFilename("...", "xlsx"), "generated.xlsx");
  assert.equal(sanitizeArtifactFilename("   ", "xlsx"), "generated.xlsx");
});

test("Windows device names are given a suffix rather than shipped as-is", () => {
  assert.equal(sanitizeArtifactFilename("CON", "xlsx"), "CON-file.xlsx");
  assert.equal(sanitizeArtifactFilename("lpt9", "xlsx"), "lpt9-file.xlsx");
});

test("a Korean file name survives intact", () => {
  assert.equal(
    sanitizeArtifactFilename("분기별_매출", "xlsx"),
    "분기별_매출.xlsx"
  );
});

test("an over-long name is trimmed to the limit including its extension", () => {
  const name = sanitizeArtifactFilename("x".repeat(400), "xlsx");
  assert.ok(name.length <= ARTIFACT_LIMITS.maxFilenameLength);
  assert.ok(name.endsWith(".xlsx"));
});

/* -------------------------------------------------------------------------- */
/* Content-Disposition                                                          */
/* -------------------------------------------------------------------------- */

test("a Korean name travels in filename*, with an ASCII fallback beside it", () => {
  const header = artifactContentDisposition("분기별_매출.xlsx", "xlsx");
  assert.ok(header.startsWith("attachment; "));
  // The quoted field is literal, so it must not carry percent escapes.
  assert.match(header, /filename="generated\.xlsx"/);
  assert.ok(!/filename="[^"]*%/.test(header));
  assert.ok(
    header.includes(
      `filename*=UTF-8''${encodeURIComponent("분기별_매출.xlsx")}`
    )
  );
});

test("an ASCII name is repeated verbatim in both fields", () => {
  const header = artifactContentDisposition("quarterly.xlsx", "xlsx");
  assert.match(header, /filename="quarterly\.xlsx"/);
  assert.ok(header.includes("filename*=UTF-8''quarterly.xlsx"));
});

test("a quote in the name cannot break out of the quoted field", () => {
  const ascii = asciiArtifactFilename('a"; x="b.xlsx', "xlsx");
  assert.ok(!ascii.includes('"'));
  const header = artifactContentDisposition('a"; x="b.xlsx', "xlsx");
  assert.equal(header.split('"').length - 1, 2);
});

/* -------------------------------------------------------------------------- */
/* Formula neutralisation                                                       */
/* -------------------------------------------------------------------------- */

test("every leading character a spreadsheet reads as a formula is guarded", () => {
  for (const value of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=cmd", "\r=cmd"]) {
    assert.equal(needsFormulaGuard(value), true, value);
  }
  for (const value of ["1+1", "Q1", "정상", "", " =later"]) {
    assert.equal(needsFormulaGuard(value), false, JSON.stringify(value));
  }
});

test("a CSV field is guarded first and quoted second", () => {
  // The apostrophe is the whole defence; nothing here needs quoting on top
  // of it, and adding quotes it does not need would change the value.
  assert.equal(csvCell("=cmd|'/C calc'!A0"), "'=cmd|'/C calc'!A0");
  assert.equal(csvCell("=A1,B1"), `"'=A1,B1"`);
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
});

/* -------------------------------------------------------------------------- */
/* Admission                                                                    */
/* -------------------------------------------------------------------------- */

test("a well-formed specification is admitted and counted", () => {
  const result = admitWorkbookSpecSafely(sheet([["a", 1], ["b", 2]]));
  assert.equal(result.ok, true);
  // Two columns times (header + two data rows).
  assert.equal(result.cellCount, 6);
  assert.equal(result.spec.format, "xlsx");
});

test("rows shorter than the column list are padded rather than rejected", () => {
  const result = admitWorkbookSpecSafely(sheet([["a"]]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.spec.worksheets[0].rows[0], ["a", null]);
});

test("a row wider than its columns is refused, not silently truncated", () => {
  const result = admitWorkbookSpecSafely(sheet([["a", 1, "extra"]]));
  assert.equal(result.ok, false);
  assert.equal(result.code, "ROW_WIDER_THAN_COLUMNS");
});

test("the cell ceiling is enforced on the rectangle, not on the values present", () => {
  const columns = Array.from({ length: 64 }, (_, i) => ({ header: `c${i}` }));
  const rows = Array.from({ length: 2_000 }, () => []);
  const result = admitWorkbookSpecSafely({
    filename: "big.xlsx",
    worksheets: [{ name: "S", columns, rows }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "TOO_MANY_CELLS");
});

test("duplicate worksheet names are made unique rather than refused", () => {
  const result = admitWorkbookSpecSafely({
    filename: "d.xlsx",
    worksheets: [
      { name: "Q1", columns: [{ header: "a" }], rows: [] },
      { name: "Q1", columns: [{ header: "a" }], rows: [] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.spec.worksheets[0].name, "Q1");
  assert.equal(result.spec.worksheets[1].name, "Q1 (2)");
});

test("worksheet names are cut to Excel's own rules", () => {
  const result = admitWorkbookSpecSafely({
    filename: "d.xlsx",
    worksheets: [
      { name: "2026/Q1: [draft]*", columns: [{ header: "a" }], rows: [] },
    ],
  });
  assert.equal(result.ok, true);
  const name = result.spec.worksheets[0].name;
  assert.ok(name.length <= 31);
  assert.ok(!/[\\/?*[\]:]/.test(name));
});

test("the schema is strict: an unknown key is a rejection, not an ignored field", () => {
  const result = admitWorkbookSpecSafely({
    ...sheet([]),
    // The shape a model would reach for if it wanted to smuggle a formula in.
    formulas: [{ ref: "A1", f: "SUM(1,1)" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SCHEMA_INVALID");
});

test("there is no formula member anywhere in an admitted cell", () => {
  const result = admitWorkbookSpecSafely(
    sheet([[{ formula: "=SUM(A1:A2)" }, 1]])
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "SCHEMA_INVALID");
});

test("a specification with no worksheets is refused", () => {
  const result = admitWorkbookSpecSafely({ filename: "x.xlsx", worksheets: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SCHEMA_INVALID");
});

test("an unsupported format is refused at the schema, before anything is built", () => {
  const result = admitWorkbookSpecSafely({ ...sheet([]), format: "docx" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "SCHEMA_INVALID");
});

test("a cell string over the character limit is refused", () => {
  const result = admitWorkbookSpecSafely(
    sheet([["x".repeat(ARTIFACT_LIMITS.maxTextLength + 1), 1]])
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "SCHEMA_INVALID");
});

/* -------------------------------------------------------------------------- */
/* Formats                                                                      */
/* -------------------------------------------------------------------------- */

test("only formats with a generator behind them are supported", () => {
  assert.deepEqual([...SUPPORTED_ARTIFACT_FORMATS], ["xlsx", "csv"]);
  for (const format of ["docx", "pptx", "pdf", "json", "txt", "md"]) {
    assert.equal(isSupportedArtifactFormat(format), false, format);
  }
});

test("the xlsx media type is the one Excel is registered against", () => {
  assert.equal(
    ARTIFACT_MEDIA_TYPES.xlsx,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
});

test("only ready and failed can reach a database row", () => {
  assert.deepEqual([...PERSISTED_ARTIFACT_STATUSES], ["ready", "failed"]);
  assert.ok(!PERSISTED_ARTIFACT_STATUSES.includes("blocked"));
});

/* -------------------------------------------------------------------------- */
/* Transport                                                                    */
/* -------------------------------------------------------------------------- */

const validArtifact = {
  id: "art_1",
  ordinal: 0,
  format: "xlsx",
  filename: "분기별_매출.xlsx",
  mediaType: ARTIFACT_MEDIA_TYPES.xlsx,
  byteSize: 3053,
  status: "ready",
  modelId: "gpt-5-6-luna",
};

test("a well-formed artifact round-trips", () => {
  assert.deepEqual(parseChatStreamArtifact(validArtifact), validArtifact);
});

test("an unknown field on the wire is dropped, never carried through", () => {
  const parsed = parseChatStreamArtifact({
    ...validArtifact,
    objectKey: "message-artifacts/u/c/art_1.xlsx",
    signedUrl: "https://example.invalid/x",
  });
  assert.ok(!("objectKey" in parsed));
  assert.ok(!("signedUrl" in parsed));
});

test("a malformed artifact is dropped rather than repaired", () => {
  // A card describing a file that does not exist is worse than no card.
  assert.equal(parseChatStreamArtifact(null), null);
  assert.equal(parseChatStreamArtifact({ ...validArtifact, id: "" }), null);
  assert.equal(parseChatStreamArtifact({ ...validArtifact, format: "docx" }), null);
  assert.equal(parseChatStreamArtifact({ ...validArtifact, status: "queued" }), null);
  assert.equal(parseChatStreamArtifact({ ...validArtifact, filename: 5 }), null);
});

test("a non-numeric size becomes zero rather than NaN in the card", () => {
  const parsed = parseChatStreamArtifact({ ...validArtifact, byteSize: "big" });
  assert.equal(parsed.byteSize, 0);
});

test("an unrecognised failure code is dropped, the artifact is kept", () => {
  const parsed = parseChatStreamArtifact({
    ...validArtifact,
    status: "failed",
    byteSize: 0,
    failureCode: "who_knows",
  });
  assert.equal(parsed.status, "failed");
  assert.ok(!("failureCode" in parsed));
});

test("the artifact list is bounded and drops what it cannot read", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    ...validArtifact,
    id: `art_${i}`,
    ordinal: i,
  }));
  assert.equal(
    parseChatStreamArtifacts(many).length,
    ARTIFACT_LIMITS.maxArtifactsPerMessage
  );
  assert.equal(parseChatStreamArtifacts([{ nope: true }]), null);
  assert.equal(parseChatStreamArtifacts([]), null);
  assert.equal(parseChatStreamArtifacts("artifacts"), null);
});

test("the download path is built from the id and nothing else", () => {
  assert.equal(artifactDownloadPath("art_1"), "/api/artifacts/art_1");
  // An id is server-generated, but the encoder is what stops a crafted one
  // from reaching another route.
  assert.equal(
    artifactDownloadPath("../conversations/1"),
    "/api/artifacts/..%2Fconversations%2F1"
  );
});

test("sizes read as sizes", () => {
  assert.equal(formatArtifactSize(0), "0 KB");
  assert.equal(formatArtifactSize(512), "512 B");
  assert.equal(formatArtifactSize(3053), "3.0 KB");
  assert.equal(formatArtifactSize(1024 * 1024 * 2), "2.0 MB");
});
