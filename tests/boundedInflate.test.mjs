import assert from "node:assert/strict";
import test from "node:test";

import { Zip, ZipDeflate, zipSync } from "fflate";

import { BoundedInflateError, visitZipEntries } from "../lib/boundedInflate.ts";
import { measureRenderInput } from "../lib/officeRenderInput.ts";

// docs/policy/chat-attachment-formats.md section 2.5: a package is read by
// its central directory, and its local headers must tell the same story --
// a reader that believes either one must meet the bytes that were measured.

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const text = (value) => new TextEncoder().encode(value);

const collect = (bytes) => {
  const seen = new Map();
  visitZipEntries(bytes, {
    accept: () => true,
    data: (name, chunk) => seen.set(name, (seen.get(name) ?? 0) + chunk.length),
  });
  return Object.fromEntries(seen);
};

const offsets = (bytes, signature) => {
  const found = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 4 <= bytes.length; at += 1) {
    if (view.getUint32(at, true) === signature) found.push(at);
  }
  return found;
};
const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

test("an ordinary package, stored or deflated, reads entry by entry", () => {
  const zip = zipSync({
    "word/document.xml": text("<w:document/>"),
    "word/media/image1.png": [new Uint8Array(10_000), { level: 0 }],
  });
  assert.deepEqual(collect(zip), { "word/document.xml": 13, "word/media/image1.png": 10_000 });
});

test("a package written with trailing data descriptors reads too", () => {
  const parts = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    parts.push(chunk);
  });
  const entry = new ZipDeflate("content.xml", { level: 6 });
  zip.add(entry);
  entry.push(text("<office:document/>".repeat(100)), true);
  zip.end();
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  // The local header defers its sizes to the descriptor.
  assert.notEqual(new DataView(bytes.buffer).getUint16(6, true) & 0x8, 0);
  assert.deepEqual(collect(bytes), { "content.xml": 1800 });
});

test("sixth review: a local header that hides a DEFLATE bomb as an empty stored entry is refused", () => {
  const zip = zipSync({
    "word/document.xml": text("<w:document/>"),
    "word/media/image1.png": new Uint8Array(201 * 1024 * 1024),
  });
  assert.deepEqual(measureRenderInput(DOCX, zip), { ok: false, reason: "EXPANDS_TOO_FAR" });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const bomb = offsets(zip, LOCAL)[1];
  view.setUint16(bomb + 8, 0, true); // method: stored
  view.setUint32(bomb + 18, 0, true); // compressed size
  view.setUint32(bomb + 22, 0, true); // size
  assert.throws(() => collect(zip), BoundedInflateError);
  assert.deepEqual(measureRenderInput(DOCX, zip), { ok: false, reason: "UNREADABLE" });
});

test("sixth review: a local entry the central directory does not list is refused", () => {
  const zip = zipSync({ "word/document.xml": text("<w:document/>"), "word/extra.bin": text("hidden") });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const [, second] = offsets(zip, CENTRAL);
  const end = offsets(zip, END).at(-1);
  // Drop the second central record and shift the end record back over it.
  const trimmed = new Uint8Array(second + (zip.length - end));
  trimmed.set(zip.subarray(0, second));
  trimmed.set(zip.subarray(end), second);
  const trimmedView = new DataView(trimmed.buffer);
  trimmedView.setUint16(second + 8, 1, true);
  trimmedView.setUint16(second + 10, 1, true);
  trimmedView.setUint32(second + 12, second - view.getUint32(end + 16, true), true);
  assert.throws(() => collect(trimmed), BoundedInflateError);
});

test("sixth review: an entry that inflates to other than its stated size is refused", () => {
  const zip = zipSync({ "word/document.xml": text("<w:document>".repeat(50)) });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const [local] = offsets(zip, LOCAL);
  const [central] = offsets(zip, CENTRAL);
  view.setUint32(local + 22, 12, true);
  view.setUint32(central + 24, 12, true);
  assert.throws(() => collect(zip), BoundedInflateError);
});

test("entries whose data overlaps are refused", () => {
  const zip = zipSync({ a: text("one"), b: text("two") });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const [, second] = offsets(zip, CENTRAL);
  view.setUint32(second + 42, 0, true); // b's record now points at a's header
  assert.throws(() => collect(zip), BoundedInflateError);
});

test("bytes that are not a ZIP, or a ZIP with no entries, are refused", () => {
  assert.throws(() => collect(text("not a zip at all")), BoundedInflateError);
  assert.throws(() => collect(zipSync({})), BoundedInflateError);
});
