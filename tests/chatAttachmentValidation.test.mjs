import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { strToU8, zipSync } from "fflate";

import { formatByMediaType } from "../lib/chatAttachmentFormats.ts";
import {
  ChatArchiveError,
  ChatAttachmentValidationError,
  validateChatAttachmentUpload,
} from "../lib/chatAttachmentValidation.ts";
import { CHAT_ARCHIVE_ERROR_CODES } from "../lib/chatArchiveLimits.ts";

/**
 * What "finalize actually looks at the bytes" means, per format.
 *
 * Before this module a signed-in upload was accepted on the strength of its
 * own Content-Type header, so a corrupt PDF or a renamed executable was only
 * discovered when the person pressed send.
 */

const format = (mediaType) => {
  const found = formatByMediaType(mediaType);
  assert.ok(found, mediaType);
  return found;
};

const validate = (buffer, mediaType, options = {}) =>
  validateChatAttachmentUpload({
    buffer,
    format: format(mediaType),
    scope: "account",
    ...options,
  });

const refuses = async (buffer, mediaType, code, options = {}) => {
  await assert.rejects(
    () => validate(buffer, mediaType, options),
    (error) => {
      assert.ok(
        error instanceof ChatAttachmentValidationError || error instanceof ChatArchiveError,
        String(error)
      );
      assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
      return true;
    }
  );
};

const stillGif = () =>
  sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 12, g: 34, b: 56 } },
  })
    .gif()
    .toBuffer();

/** Two 1x1 frames, hand-built so the answer does not depend on libvips. */
const animatedGif = () =>
  Buffer.from([
    ...Buffer.from("GIF89a", "ascii"),
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
    0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b,
  ]);

// -- Images ------------------------------------------------------------------

test("a still GIF is accepted and leaves as the PNG the provider will get", async () => {
  const result = await validate(await stillGif(), "image/gif");
  assert.equal(result.mediaType, "image/png");
  assert.deepEqual(
    [...result.bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );
});

test("an animated GIF is refused by name, not reduced to its first frame", async () => {
  await refuses(animatedGif(), "image/gif", "ATTACHMENT_ANIMATED_IMAGE");
});

test("a PNG that is not a PNG is refused", async () => {
  await refuses(Buffer.from("this is text", "utf8"), "image/png", "INVALID_IMAGE_ATTACHMENT");
  // A real PNG claiming to be a JPEG fails its signature check.
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .png()
    .toBuffer();
  await refuses(png, "image/jpeg", "INVALID_IMAGE_ATTACHMENT");
  await validate(png, "image/png");
});

test("a GIF header on something that is not a GIF is refused", async () => {
  await refuses(
    Buffer.from("GIF89a and then nothing that parses", "utf8"),
    "image/gif",
    "INVALID_IMAGE_ATTACHMENT"
  );
});

// -- Text --------------------------------------------------------------------

test("text is decoded strictly and stored as UTF-8", async () => {
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("안녕하세요", "utf16le"),
  ]);
  const result = await validate(utf16, "text/plain");
  assert.equal(result.bytes.toString("utf8"), "안녕하세요");
  assert.equal(result.mediaType, "text/plain");
});

test("a renamed binary claiming to be text is refused", async () => {
  await refuses(
    Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]),
    "text/plain",
    "ATTACHMENT_TYPE_MISMATCH"
  );
  await refuses(
    Buffer.from([0x41, 0xc3, 0x28, 0x42]),
    "text/x-python",
    "ATTACHMENT_ENCODING_UNREADABLE"
  );
});

test("source code is accepted as text and never run", async () => {
  const source = "import os\nos.system('echo nope')\n";
  const result = await validate(Buffer.from(source, "utf8"), "text/x-python");
  assert.equal(result.bytes.toString("utf8"), source);
});

test("malformed JSON and YAML are still accepted, because fixing them is the ask", async () => {
  // Structural validation is deliberately absent on input: a person uploading
  // a broken config is usually asking why it is broken.
  const broken = '{"a": 1,,}\n';
  const result = await validate(Buffer.from(broken, "utf8"), "application/json");
  assert.equal(result.bytes.toString("utf8"), broken);
});

test("the guest ceiling refuses a document longer than a guest message carries", async () => {
  const long = Buffer.from("x".repeat(50), "utf8");
  await refuses(long, "text/plain", "ATTACHMENT_TEXT_TOO_LARGE", {
    scope: "guest",
    maxExtractedCharacters: 10,
  });
  // Without a ceiling the same file is fine: the turn's budget decides later.
  await validate(long, "text/plain");
});

test("an empty upload is refused whatever it claims to be", async () => {
  await refuses(Buffer.alloc(0), "text/plain", "ATTACHMENT_TYPE_MISMATCH");
});

// -- Archives ----------------------------------------------------------------

test("an archive is planned at upload, so the counts are known before send", async () => {
  const zip = Buffer.from(
    zipSync({
      "src/main.py": strToU8("print(1)\n"),
      "README.md": strToU8("# hi\n"),
      "clip.mp4": strToU8("unsupported"),
      "folder/": new Uint8Array(0),
    })
  );
  const result = await validate(zip, "application/zip");
  assert.equal(result.mediaType, "application/zip");
  assert.deepEqual(result.archive, {
    totalEntries: 4,
    includedFiles: 2,
    excludedFiles: 1,
  });
});

test("an archive with nothing readable is refused at upload, not at send", async () => {
  await refuses(
    Buffer.from(zipSync({ "a.mp4": strToU8("x") })),
    "application/zip",
    CHAT_ARCHIVE_ERROR_CODES.noSupportedFiles
  );
});

test("a guest archive is planned against the guest limits", async () => {
  const files = {};
  for (let index = 0; index < 9; index += 1) {
    files[`f${index}.txt`] = strToU8("hello\n");
  }
  const zip = Buffer.from(zipSync(files));
  const guest = await validateChatAttachmentUpload({
    buffer: zip,
    format: format("application/zip"),
    scope: "guest",
  });
  assert.equal(guest.archive.includedFiles, 5);
  assert.equal(guest.archive.excludedFiles, 4);

  const account = await validate(zip, "application/zip");
  assert.equal(account.archive.includedFiles, 9);
  assert.equal(account.archive.excludedFiles, 0);
});

test("an Office file that is not the type it claims is refused", async () => {
  // The container walk runs at finalize; the full text extraction still waits
  // for the turn that sends it.
  await refuses(
    Buffer.from(zipSync({ "word/document.xml": strToU8("<w:document/>") })),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ATTACHMENT_TYPE_MISMATCH"
  );
});

test("a PDF that is not a PDF is refused", async () => {
  await refuses(
    Buffer.from("%PDF-1.7 but not really", "utf8"),
    "application/pdf",
    "INVALID_PDF_ATTACHMENT"
  );
  await refuses(
    Buffer.from("not even pretending", "utf8"),
    "application/pdf",
    "INVALID_PDF_ATTACHMENT"
  );
});
