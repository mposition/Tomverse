import assert from "node:assert/strict";
import test from "node:test";

import { unzipSync } from "fflate";

import {
  ARTIFACT_LIMITS,
  admitArchiveSpec,
  admitDocumentBatchSpec,
  isArchiveDocumentEntry,
} from "../lib/generatedArtifactCore.ts";
import { renderArchiveArtifact } from "../lib/generatedArtifactRenderers.ts";

// docs/policy/generated-artifacts.md section 13.
//
// An archive used to be able to hold only text the model authored, which is
// why "make me ten Word documents" had no shape it could take: a .docx has no
// text a model could write. It holds server-rendered documents now, and the
// two ceilings that made the old answer a refusal -- three artifacts per
// answer, a hundred entries per archive -- are unchanged.

const decoder = new TextDecoder();

const textEntry = (path = "README.md") => ({
  path,
  format: "md",
  content: "# hello\n",
});

const documentEntry = (path = "reports/q1.docx") => ({
  path,
  documentFormat: "docx",
  title: "Q1",
  blocks: [
    { type: "heading", level: 1, text: "매출 보고" },
    { type: "paragraph", text: "1분기 요약입니다." },
    { type: "table", columns: ["팀", "매출"], rows: [["플랫폼팀", 100]] },
  ],
});

/* -------------------------------------------------------------------------- */
/* Admission                                                                    */
/* -------------------------------------------------------------------------- */

test("an archive may mix authored text and rendered documents", () => {
  const admission = admitArchiveSpec({
    filename: "bundle.zip",
    entries: [textEntry(), documentEntry()],
  });
  assert.equal(admission.ok, true);
  assert.equal(isArchiveDocumentEntry(admission.spec.entries[0]), false);
  assert.equal(isArchiveDocumentEntry(admission.spec.entries[1]), true);
});

test("a rendered entry obeys the same path rules as an authored one", () => {
  const admission = admitArchiveSpec({
    filename: "bundle.zip",
    entries: [documentEntry("../../etc/passwd.docx")],
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.code, "UNSAFE_PATH");
});

test("two entries cannot claim the same path, whichever kind they are", () => {
  const admission = admitArchiveSpec({
    filename: "bundle.zip",
    entries: [textEntry("a.md"), documentEntry("a.md")],
  });
  assert.equal(admission.ok, false);
  assert.equal(admission.code, "UNSAFE_PATH");
});

// The archive's character ceiling is one ceiling for the whole archive, not
// one per entry kind that each could slip under separately.
test("a rendered entry counts against the archive's character ceiling", () => {
  // Thirty full-size paragraphs per entry, so the ceiling that trips is the
  // character one and not the entry count.
  const blocks = Array.from({ length: 30 }, () => ({
    type: "paragraph",
    text: "가".repeat(ARTIFACT_LIMITS.maxTextLength),
  }));
  const perEntry = 30 * ARTIFACT_LIMITS.maxTextLength;
  const entries = Array.from(
    {
      length: Math.ceil(ARTIFACT_LIMITS.maxArchiveCharacters / perEntry) + 1,
    },
    (_, index) => ({
      path: `big-${index}.docx`,
      documentFormat: "docx",
      blocks,
    })
  );
  const admission = admitArchiveSpec({ filename: "bundle.zip", entries });
  assert.equal(admission.ok, false);
  assert.equal(admission.code, "ARCHIVE_TOO_LARGE");
});

test("the hundred-and-first entry is refused", () => {
  const entries = Array.from(
    { length: ARTIFACT_LIMITS.maxArchiveEntries + 1 },
    (_, index) => textEntry(`file-${index}.md`)
  );
  const admission = admitArchiveSpec({ filename: "bundle.zip", entries });
  assert.equal(admission.ok, false);
  assert.equal(admission.code, "SCHEMA_INVALID");
});

test("exactly a hundred entries is accepted", () => {
  const entries = Array.from(
    { length: ARTIFACT_LIMITS.maxArchiveEntries },
    (_, index) => textEntry(`file-${index}.md`)
  );
  assert.equal(
    admitArchiveSpec({ filename: "bundle.zip", entries }).ok,
    true
  );
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                    */
/* -------------------------------------------------------------------------- */

test("a rendered docx entry is a real Word package inside the zip", () => {
  const rendered = renderArchiveArtifact({
    filename: "bundle.zip",
    format: "zip",
    entries: [textEntry(), documentEntry()],
  });
  assert.equal(rendered.format, "zip");
  const files = unzipSync(rendered.bytes);
  assert.deepEqual(Object.keys(files).sort(), ["README.md", "reports/q1.docx"]);
  assert.equal(decoder.decode(files["README.md"]), "# hello\n");

  const inner = unzipSync(files["reports/q1.docx"]);
  assert.equal(Boolean(inner["word/document.xml"]), true);
  assert.equal(Boolean(inner["[Content_Types].xml"]), true);
  assert.match(decoder.decode(inner["word/document.xml"]), /매출 보고/);
});

test("a rendered docx entry inside a zip reopens in a Word-compatible parser", async () => {
  const { OfficeParser } = await import("officeparser");
  const rendered = renderArchiveArtifact({
    filename: "bundle.zip",
    format: "zip",
    entries: [documentEntry()],
  });
  const inner = unzipSync(rendered.bytes)["reports/q1.docx"];
  const parsed = await OfficeParser.parseOffice(Buffer.from(inner), {
    extractAttachments: false,
    ocr: false,
  });
  assert.match(parsed.toText(), /매출 보고/);
});

// Regression: the archive that existed before this change still builds the
// same way, and its entries still go through the text validation that stops a
// zip being the way to deliver what a direct request would refuse.
test("a text-only archive is unchanged, and malformed content still fails", () => {
  const rendered = renderArchiveArtifact({
    filename: "bundle.zip",
    format: "zip",
    entries: [
      { path: "src/app.py", format: "py", content: "print('hi')" },
      { path: "data.json", format: "json", content: '{"a":1}' },
    ],
  });
  const files = unzipSync(rendered.bytes);
  assert.equal(decoder.decode(files["src/app.py"]), "print('hi')\n");
  assert.throws(() =>
    renderArchiveArtifact({
      filename: "bundle.zip",
      format: "zip",
      entries: [{ path: "data.json", format: "json", content: '{"a":1,}' }],
    })
  );
});

/* -------------------------------------------------------------------------- */
/* The batch specification                                                      */
/* -------------------------------------------------------------------------- */

const batchSpec = (overrides = {}) => ({
  filename: "contracts.zip",
  templateAttachment: "att_1",
  dataAttachment: "att_2",
  filenameTemplate: "{{이름}}_근로계약서",
  ...overrides,
});

test("the batch specification takes handles, never keys or paths", () => {
  assert.equal(admitDocumentBatchSpec(batchSpec()).ok, true);
  for (const bad of [
    "attachments/abc/2026-08-22/file.docx",
    "/tmp/template.docx",
    "https://example.invalid/t.docx",
    "att_0",
    "1",
  ]) {
    const admission = admitDocumentBatchSpec(
      batchSpec({ templateAttachment: bad })
    );
    assert.equal(admission.ok, false, `${bad} was accepted`);
    assert.equal(admission.code, "SCHEMA_INVALID");
  }
});

test("the template and the data must be two different files", () => {
  const admission = admitDocumentBatchSpec(
    batchSpec({ dataAttachment: "att_1" })
  );
  assert.equal(admission.ok, false);
  assert.match(admission.detail, /two different/);
});

test("no field carries bytes, base64 or XML", () => {
  const admission = admitDocumentBatchSpec(
    batchSpec({ templateXml: "<w:document/>" })
  );
  assert.equal(admission.ok, false);
  assert.equal(admission.code, "SCHEMA_INVALID");
});
