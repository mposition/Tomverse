import assert from "node:assert/strict";
import test from "node:test";

import { deflateSync, gzipSync, zipSync } from "fflate";

import { measureRenderInput } from "../lib/officeRenderInput.ts";
import { buildCompoundFile } from "./support/compoundFile.mjs";

// docs/policy/generated-artifacts.md section 15.3: every compressed part of a
// document is measured by what it really expands to before the shared
// renderer sees it.

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const hwpHeader = (properties) => {
  const header = new Uint8Array(256);
  header.set(new TextEncoder().encode("HWP Document File"));
  new DataView(header.buffer).setUint32(36, properties, true);
  return header;
};

test("an ordinary document passes; one with a bomb in any part does not", () => {
  const ordinary = zipSync({ "word/document.xml": new TextEncoder().encode("<w:document/>") });
  assert.deepEqual(measureRenderInput(DOCX, ordinary), { ok: true });

  const bomb = zipSync({
    "word/document.xml": new TextEncoder().encode("<w:document/>"),
    "word/media/image1.png": new Uint8Array(201 * 1024 * 1024),
  });
  assert.deepEqual(measureRenderInput(DOCX, bomb), { ok: false, reason: "EXPANDS_TOO_FAR" });
});

test("an HWP whose compressed picture stream is a bomb is refused; its text sections alone are not the measure", () => {
  const hwp = (extra) =>
    buildCompoundFile([
      { name: "FileHeader", data: hwpHeader(1) },
      { name: "Section0", data: deflateSync(new Uint8Array(64)) },
      ...extra,
    ]);
  assert.deepEqual(measureRenderInput("application/x-hwp", hwp([])), { ok: true });
  assert.deepEqual(
    measureRenderInput("application/x-hwp", hwp([{ name: "BIN0001.png", data: deflateSync(new Uint8Array(201 * 1024 * 1024)) }])),
    { ok: false, reason: "EXPANDS_TOO_FAR" }
  );
});

test("a compound file that is not an HWP is passed through: nothing in it inflates", () => {
  const doc = buildCompoundFile([{ name: "WordDocument", data: new Uint8Array(512) }]);
  assert.deepEqual(measureRenderInput("application/msword", doc), { ok: true });
});

test("fourth review: a workbook embedded in a Word file is measured too", () => {
  const embedded = zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(201 * 1024 * 1024) });
  const docx = zipSync({
    "word/document.xml": new TextEncoder().encode("<w:document/>"),
    "word/embeddings/Microsoft_Excel_Worksheet.xlsx": [embedded, { level: 0 }],
  });
  assert.deepEqual(measureRenderInput(DOCX, docx), { ok: false, reason: "EXPANDS_TOO_FAR" });
});

test("fifth review: of two HWP streams sharing a name, the second is measured too", () => {
  const hwp = buildCompoundFile([
    { name: "FileHeader", data: hwpHeader(1) },
    { name: "Section0", data: deflateSync(new Uint8Array(64)) },
    { name: "BIN0001.png", data: deflateSync(new Uint8Array(64)) },
    { name: "BIN0001.png", data: deflateSync(new Uint8Array(201 * 1024 * 1024)) },
  ]);
  assert.deepEqual(measureRenderInput("application/x-hwp", hwp), { ok: false, reason: "EXPANDS_TOO_FAR" });
});

/**
 * A stored entry whose data starts `before` bytes short of a 4096-byte input
 * step, so its first piece of output is that short: the reader hands stored
 * data through in the slices it was fed.
 */
const zipWithSplitHead = (inner, before) => {
  const build = (fillerLength) =>
    zipSync({
      "word/document.xml": [new Uint8Array(fillerLength), { level: 0 }],
      "word/embeddings/object.bin": [inner, { level: 0 }],
    });
  const draft = build(4000);
  const at = Buffer.from(draft).indexOf(Buffer.from(inner.subarray(0, 16)));
  const zip = build(4000 + (4096 - before) - at);
  assert.equal(Buffer.from(zip).indexOf(Buffer.from(inner.subarray(0, 16))) % 4096, 4096 - before);
  return zip;
};

test("fifth review: a nested container is found when its first bytes arrive in pieces", () => {
  const gzipped = gzipSync(new Uint8Array(201 * 1024 * 1024));
  assert.deepEqual(measureRenderInput(DOCX, zipWithSplitHead(gzipped, 1)), {
    ok: false,
    reason: "EXPANDS_TOO_FAR",
  });
  const zipped = zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(201 * 1024 * 1024) });
  for (const before of [1, 2, 3]) {
    assert.deepEqual(measureRenderInput(DOCX, zipWithSplitHead(zipped, before)), {
      ok: false,
      reason: "EXPANDS_TOO_FAR",
    });
  }
});
