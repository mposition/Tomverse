import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeAttachmentText,
  hasBinarySignature,
} from "../lib/chatAttachmentText.ts";

// A text attachment is the one shape with no signature of its own, so this is
// where "is it text" is actually decided -- for guests and accounts alike,
// and for every file lifted out of an archive.

const bytes = (...values) => Uint8Array.from(values);
const utf8 = (text) => new TextEncoder().encode(text);

test("plain UTF-8 decodes unchanged", () => {
  const result = decodeAttachmentText(utf8("hello\nworld\n"));
  assert.equal(result.ok, true);
  assert.equal(result.text, "hello\nworld\n");
  assert.equal(result.encoding, "utf-8");
});

test("non-Latin text survives intact", () => {
  for (const sample of ["안녕하세요 세계", "你好，世界", "Ωμέγα ± ½", "🙂 emoji"]) {
    const result = decodeAttachmentText(utf8(sample));
    assert.equal(result.ok, true, sample);
    assert.equal(result.text, sample);
  }
});

test("a UTF-8 byte order mark is stripped rather than carried into the prompt", () => {
  const result = decodeAttachmentText(
    Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("id,name\n1,a\n")])
  );
  assert.equal(result.ok, true);
  assert.equal(result.text, "id,name\n1,a\n");
  assert.equal(result.encoding, "utf-8-bom");
  // A leading U+FEFF would break a CSV header and a JSON parse alike.
  assert.equal(result.text.charCodeAt(0), "i".charCodeAt(0));
});

test("UTF-16 with a byte order mark is converted, not refused", () => {
  // Half of a UTF-16 file is NUL bytes, which the previous check read as
  // evidence of a binary. A Windows editor writes this without being asked.
  const le = Uint8Array.from([0xff, 0xfe, ...Buffer.from("hello", "utf16le")]);
  const leResult = decodeAttachmentText(le);
  assert.equal(leResult.ok, true);
  assert.equal(leResult.text, "hello");
  assert.equal(leResult.encoding, "utf-16le");

  const be = bytes(0xfe, 0xff, 0x00, 0x68, 0x00, 0x69);
  const beResult = decodeAttachmentText(be);
  assert.equal(beResult.ok, true);
  assert.equal(beResult.text, "hi");
  assert.equal(beResult.encoding, "utf-16be");
});

test("a UTF-16 file that decodes to NUL characters is still refused", () => {
  const le = bytes(0xff, 0xfe, 0x00, 0x00, 0x41, 0x00);
  const result = decodeAttachmentText(le);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "binary");
});

test("an embedded NUL is not text, whatever the first bytes were", () => {
  const result = decodeAttachmentText(
    Uint8Array.from([...utf8("hello"), 0x00, ...utf8("world")])
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "binary");
});

test("known binary signatures are refused before any decode", () => {
  const samples = {
    zip: bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00),
    gzip: bytes(0x1f, 0x8b, 0x08, 0x00),
    elf: bytes(0x7f, 0x45, 0x4c, 0x46, 0x02),
    pe: bytes(0x4d, 0x5a, 0x90, 0x00),
    ole: bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1),
    pdf: utf8("%PDF-1.7\nnot text"),
    png: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    gif: utf8("GIF89a...."),
    jpeg: bytes(0xff, 0xd8, 0xff, 0xe0),
    wasm: bytes(0x00, 0x61, 0x73, 0x6d, 0x01),
  };
  for (const [name, sample] of Object.entries(samples)) {
    assert.equal(hasBinarySignature(sample), true, name);
    const result = decodeAttachmentText(sample);
    assert.equal(result.ok, false, name);
    assert.equal(result.reason, "binary", name);
  }
});

test("a broken encoding is an error, never a repair", () => {
  // `Buffer.toString("utf8")` would substitute U+FFFD for each invalid
  // sequence and hand the damage to the model as content.
  const result = decodeAttachmentText(bytes(0x41, 0xc3, 0x28, 0x42));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "encoding");

  const truncated = decodeAttachmentText(bytes(0xed, 0x95, 0x9c, 0xea, 0xb5));
  assert.equal(truncated.ok, false);
  assert.equal(truncated.reason, "encoding");
});

test("a legitimate U+FFFD in the source survives", () => {
  // The old guard searched the decoded string for the replacement character,
  // so a document that genuinely contained one was called unreadable.
  const result = decodeAttachmentText(utf8("before � after"));
  assert.equal(result.ok, true);
  assert.equal(result.text, "before � after");
});

test("an empty file decodes to empty text rather than failing", () => {
  const result = decodeAttachmentText(new Uint8Array(0));
  assert.equal(result.ok, true);
  assert.equal(result.text, "");
});

test("source code is text and nothing more", () => {
  // Nothing here is executed, imported or evaluated -- the assertion is that
  // the decoder returns the characters and takes no other action.
  const source = "import os\nos.system('echo pwned')\n";
  const result = decodeAttachmentText(utf8(source));
  assert.equal(result.ok, true);
  assert.equal(result.text, source);
});
