import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_LIMITS,
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
  requireArtifactFormat,
  sanitizeArtifactFilename,
  SUPPORTED_ARTIFACT_FORMATS,
  visibleGeneratedArtifacts,
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
  for (const format of ["xlsx", "csv", "docx", "pptx", "pdf", "json", "txt", "md", "zip"]) {
    assert.equal(isSupportedArtifactFormat(format), true, format);
  }
  // A format nobody wrote a generator for stays out of the list, which is what
  // keeps the database CHECK and the download route honest.
  for (const format of ["exe", "psd", "mp4", "doc", "xls"]) {
    assert.equal(isSupportedArtifactFormat(format), false, format);
  }
  assert.equal(SUPPORTED_ARTIFACT_FORMATS.length > 40, true);
});

test("the xlsx media type is the one Excel is registered against", () => {
  assert.equal(
    requireArtifactFormat("xlsx").mediaType,
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
  mediaType: requireArtifactFormat("xlsx").mediaType,
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
  assert.equal(parseChatStreamArtifact({ ...validArtifact, format: "psd" }), null);
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

/* -------------------------------------------------------------------------- */
/* Which cards a turn shows -- docs/policy/generated-artifacts.md section 9      */
/* -------------------------------------------------------------------------- */

const shown = (artifacts, options) =>
  visibleGeneratedArtifacts(artifacts, options).map(
    (artifact) => `${artifact.ordinal}:${artifact.status}`
  );

/** One artifact, named by the fields the identity rule actually reads. */
const artifactAt = (ordinal, status, overrides = {}) => ({
  id: `art_${ordinal}`,
  ordinal,
  format: "xlsx",
  filename: "report.xlsx",
  mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  byteSize: status === "ready" ? 3053 : 0,
  status,
  ...(status === "ready" ? {} : { failureCode: "spec_rejected" }),
  modelId: "gpt-5-6-luna",
  ...overrides,
});

test("a failure the same turn fixed does not keep its card", () => {
  assert.deepEqual(
    shown([artifactAt(0, "failed"), artifactAt(1, "ready")]),
    ["1:ready"]
  );
});

test("every earlier failure for one file goes, not just the last one", () => {
  assert.deepEqual(
    shown([artifactAt(0, "failed"), artifactAt(1, "failed"), artifactAt(2, "ready")]),
    ["2:ready"]
  );
});

test("the order the artifacts arrive in does not change what is shown", () => {
  // The streamed trailer and a reloaded conversation are the same set; only
  // `ordinal` decides which of two artifacts came second.
  const streamed = [artifactAt(0, "failed"), artifactAt(1, "ready")];
  assert.deepEqual(shown([...streamed].reverse()), ["1:ready"]);
});

test("a failure nothing resolved keeps its card and its retry", () => {
  assert.deepEqual(shown([artifactAt(0, "failed")]), ["0:failed"]);
  assert.deepEqual(
    shown([artifactAt(0, "failed"), artifactAt(1, "failed")]),
    ["0:failed", "1:failed"]
  );
});

test("a failure after the success is the newest news and stays", () => {
  assert.deepEqual(
    shown([artifactAt(0, "ready"), artifactAt(1, "failed")]),
    ["0:ready", "1:failed"]
  );
});

test("only a matching file resolves a failure", () => {
  // A different name.
  assert.deepEqual(
    shown([artifactAt(0, "failed"), artifactAt(1, "ready", { filename: "summary.xlsx" })]),
    ["0:failed", "1:ready"]
  );
  // A different format under the same name.
  assert.deepEqual(
    shown([
      artifactAt(0, "failed"),
      artifactAt(1, "ready", { format: "csv", filename: "report.csv" }),
    ]),
    ["0:failed", "1:ready"]
  );
  // Another model's success.
  assert.deepEqual(
    shown([artifactAt(0, "failed"), artifactAt(1, "ready", { modelId: "claude-sonnet-4-5" })]),
    ["0:failed", "1:ready"]
  );
});

test("a name that differs only in case is the same file", () => {
  assert.deepEqual(
    shown([artifactAt(0, "failed"), artifactAt(1, "ready", { filename: "Report.XLSX" })]),
    ["1:ready"]
  );
});

test("the panel's model stands in for an artifact that names none", () => {
  const unattributed = (ordinal, status) => {
    const artifact = artifactAt(ordinal, status);
    delete artifact.modelId;
    return artifact;
  };
  // Both fall back to the panel, so they are one file.
  assert.deepEqual(
    shown([unattributed(0, "failed"), unattributed(1, "ready")], {
      fallbackModelId: "gpt-5-6-luna",
    }),
    ["1:ready"]
  );
  // The failure names no model and the success names another one: with the
  // panel's model standing in for the failure, these are two different files.
  assert.deepEqual(
    shown([unattributed(0, "failed"), artifactAt(1, "ready", { modelId: "claude-sonnet-4-5" })], {
      fallbackModelId: "gpt-5-6-luna",
    }),
    ["0:failed", "1:ready"]
  );
  // With no panel model either, an unattributed pair is still one file.
  assert.deepEqual(shown([unattributed(0, "failed"), unattributed(1, "ready")]), [
    "1:ready",
  ]);
});

test("a sign-in card is never hidden by a later success", () => {
  // `blocked` asks the visitor to sign in; another artifact succeeding does
  // not answer that, and the guest still cannot download this one.
  assert.deepEqual(
    shown([
      artifactAt(0, "blocked", { failureCode: "sign_in_required" }),
      artifactAt(1, "ready"),
    ]),
    ["0:blocked", "1:ready"]
  );
});

test("two successes with one name are two versions, not one card", () => {
  assert.deepEqual(
    shown([artifactAt(0, "ready"), artifactAt(1, "ready")]),
    ["0:ready", "1:ready"]
  );
});

test("the input is not mutated and an all-ready turn is returned intact", () => {
  const artifacts = [artifactAt(0, "ready"), artifactAt(1, "failed", { filename: "other.xlsx" })];
  const frozen = JSON.stringify(artifacts);
  const result = visibleGeneratedArtifacts(artifacts);
  assert.notEqual(result, artifacts);
  assert.equal(result.length, 2);
  assert.equal(JSON.stringify(artifacts), frozen);
  assert.deepEqual(visibleGeneratedArtifacts([]), []);
});
