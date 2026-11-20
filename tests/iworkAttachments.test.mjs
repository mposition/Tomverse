import assert from "node:assert/strict";
import test from "node:test";

import { zipSync } from "fflate";

import {
  CHAT_ATTACHMENT_FORMATS,
  chatAttachmentAcceptAttribute,
  resolveChatAttachmentFormat,
} from "../lib/chatAttachmentFormats.ts";
import { validateChatAttachmentUpload } from "../lib/chatAttachmentValidation.ts";
import { OFFICE_RENDERABLE_EXTENSIONS } from "../lib/fileConversionCore.ts";
import { IworkPackageError, assertSafeIworkPackage } from "../lib/iworkPackage.ts";

// docs/policy/chat-attachment-formats.md (Apple iWork) and
// docs/policy/generated-artifacts.md section 15.
//
// Pages, Numbers and Keynote files are accepted so the renderer can lay them
// out as PDFs, from iCloud Drive as easily as from a desktop. They are never
// read here, so the check is the package's shape.

const pkg = (entries) =>
  zipSync(Object.fromEntries(entries.map(([name, text]) => [name, new TextEncoder().encode(text)])));

const pagesFile = () =>
  pkg([
    ["Index/Document.iwa", "records"],
    ["Metadata/Properties.plist", "<plist/>"],
    ["preview.jpg", "jpeg"],
  ]);

test("the two iWork types resolve by extension and by the types Apple's systems report", () => {
  for (const [name, type, id] of [
    ["Report.pages", "application/vnd.apple.pages", "pages"],
    ["Budget.numbers", "application/x-iwork-numbers-sffnumbers", "numbers"],
    ["Budget.numbers", "", "numbers"],
  ]) {
    const format = resolveChatAttachmentFormat({ filename: name, declaredMediaType: type });
    assert.equal(format?.id, id, name);
    assert.equal(format.category, "iwork");
  }
});

test("the file picker offers iWork files, so iCloud Drive's are selectable on iOS", () => {
  const accept = chatAttachmentAcceptAttribute();
  for (const token of [".pages", ".numbers", "application/vnd.apple.pages"]) {
    assert.ok(accept.split(",").includes(token), token);
  }
  // .key is a private key's extension as well as Keynote's, and stays refused.
  assert.equal(accept.split(",").includes(".key"), false);
  assert.equal(resolveChatAttachmentFormat({ filename: "Pitch.key", declaredMediaType: "application/vnd.apple.keynote" }), null);
  // A guest has no renderer turn, so a guest's picker does not offer them.
  const guest = chatAttachmentAcceptAttribute({ guest: true });
  assert.equal(guest.includes(".pages"), false);
});

test("every iWork type is one the renderer is told how to open", () => {
  for (const format of CHAT_ATTACHMENT_FORMATS.filter((entry) => entry.category === "iwork")) {
    assert.ok(OFFICE_RENDERABLE_EXTENSIONS[format.mediaType], format.id);
    assert.equal(format.allowedInArchive, false);
    assert.equal(format.guestAllowed, false);
  }
});

test("a well-formed package passes; anything else is refused before it is stored", async () => {
  assert.doesNotThrow(() => assertSafeIworkPackage(pagesFile()));
  assert.doesNotThrow(() => assertSafeIworkPackage(pkg([["index.xml.gz", "x"]])));

  for (const [label, bytes] of [
    ["not a zip", new TextEncoder().encode("hello")],
    ["a zip with no iWork index", pkg([["readme.txt", "hi"]])],
    ["a path that leaves the package", pkg([["Index/Document.iwa", "x"], ["../evil", "x"]])],
  ]) {
    assert.throws(() => assertSafeIworkPackage(bytes), IworkPackageError, label);
  }

  const format = resolveChatAttachmentFormat({ filename: "Report.pages", declaredMediaType: "application/vnd.apple.pages" });
  const accepted = await validateChatAttachmentUpload({
    buffer: Buffer.from(pagesFile()),
    format,
    scope: "account",
  });
  assert.equal(accepted.mediaType, "application/vnd.apple.pages");
  await assert.rejects(
    validateChatAttachmentUpload({ buffer: Buffer.from(pkg([["readme.txt", "hi"]])), format, scope: "account" }),
    (error) => error.code === "ATTACHMENT_TYPE_MISMATCH"
  );
});

test("a package that expands too far is refused from its directory alone", () => {
  const many = pkg(Array.from({ length: 5_001 }, (_, index) => [`Data/${index}`, ""]));
  assert.throws(() => assertSafeIworkPackage(many), /Too many entries/);
});

test("a package is measured by what it really expands to, not what it declares", () => {
  // Over the 200 MB ceiling once inflated, a few hundred KB as uploaded.
  const bomb = zipSync({
    "Index/Document.iwa": new Uint8Array(16),
    "Data/blob": new Uint8Array(201 * 1024 * 1024),
  });
  assert.ok(bomb.length < 2 * 1024 * 1024);
  assert.throws(() => assertSafeIworkPackage(bomb), /Expands too far/);
});

/* ------------------------------------------------------------------------ */
/* Found by the fourth review: what is compressed inside the package counts   */
/* ------------------------------------------------------------------------ */

import { gzipSync } from "fflate";

test("a gzipped index that expands too far is refused, though small as stored", () => {
  const bomb = zipSync({
    "index.xml.gz": [gzipSync(new Uint8Array(201 * 1024 * 1024)), { level: 0 }],
  });
  assert.ok(bomb.length < 2 * 1024 * 1024);
  assert.throws(() => assertSafeIworkPackage(bomb), (error) => error.refusal === "TOO_LARGE");
});

test("a nested Index.zip is measured against the same total", () => {
  const inner = zipSync({ "Document.iwa": new Uint8Array(201 * 1024 * 1024) });
  const bomb = zipSync({ "Index.zip": [inner, { level: 0 }] });
  assert.throws(() => assertSafeIworkPackage(bomb), (error) => error.refusal === "TOO_LARGE");
});

test("an .iwa record's stated Snappy length counts, since a decoder writes that much", () => {
  // One IWA chunk: [0][3-byte length][varint uncompressed length = 300 MB]...
  const varint = [];
  let value = 300 * 1024 * 1024;
  while (value >= 0x80) {
    varint.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  varint.push(value);
  const body = new Uint8Array([...varint, 0, 0, 0, 0]);
  const chunk = new Uint8Array([0, body.length & 0xff, (body.length >> 8) & 0xff, 0, ...body]);
  const bomb = zipSync({ "Index/Document.iwa": chunk });
  assert.throws(() => assertSafeIworkPackage(bomb), (error) => error.refusal === "TOO_LARGE");
});

test("a size refusal reaches the user as a size error, not a type mismatch", async () => {
  const format = resolveChatAttachmentFormat({ filename: "Big.pages", declaredMediaType: "application/vnd.apple.pages" });
  const bomb = zipSync({
    "Index/Document.iwa": new Uint8Array(16),
    "Data/blob": new Uint8Array(201 * 1024 * 1024),
  });
  await assert.rejects(
    validateChatAttachmentUpload({ buffer: Buffer.from(bomb), format, scope: "account" }),
    (error) => error.code === "ATTACHMENT_TOO_LARGE" && error.status === 413
  );
});
