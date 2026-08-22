import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXTAUTH_SECRET ||= "guest-attachment-policy-test-secret";

import {
  GUEST_ACCEPTED_MEDIA_TYPES,
  GUEST_MAX_ATTACHMENTS_PER_MESSAGE,
  GUEST_MAX_ATTACHMENT_BYTES,
} from "../lib/guestAttachmentPolicy.ts";
import {
  assertGuestAttachmentType,
  assertGuestTextPayload,
  createGuestAttachmentKey,
  createGuestAttachmentObjectId,
  guestAttachmentPrefix,
  guestFileExtension,
  isOwnGuestAttachmentKey,
  sanitizeGuestFilename,
  GUEST_ATTACHMENT_PREFIX,
  GUEST_ATTACHMENT_TYPES,
  GUEST_MAX_EXTRACTED_CHARACTERS,
} from "../lib/guestAttachments.ts";

// The guest upload path is the one attachment surface an unauthenticated
// caller can reach, so its policy is pinned here rather than only exercised
// through a route: every rule below is a rule the route depends on being true.

const SECRET = "guest-attachment-policy-test-secret";
const throws = (fn, code) =>
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });

test("a guest may attach exactly one file, at half the signed-in size ceiling", () => {
  assert.equal(GUEST_MAX_ATTACHMENTS_PER_MESSAGE, 1);
  assert.equal(GUEST_MAX_ATTACHMENT_BYTES, 5 * 1024 * 1024);
  // Never more permissive than the account limit it narrows.
  assert.ok(GUEST_MAX_ATTACHMENT_BYTES < 10 * 1024 * 1024);
});

test("the browser's accepted list and the server's allowlist are the same set", () => {
  // Two lists that can drift produce the worst failure mode there is: a file
  // the picker offers and the server refuses, after the user chose it.
  assert.deepEqual(
    [...GUEST_ACCEPTED_MEDIA_TYPES].sort(),
    Object.keys(GUEST_ATTACHMENT_TYPES).sort()
  );
});

test("other archive formats and executables are refused whatever media type is claimed", () => {
  // ZIP left this list when it became a supported format with its own
  // expansion contract; `.sh` and `.js` left it when source files became
  // readable text. The test is still "does opening this run it", which is why
  // every name below stays: they are containers this product does not open
  // and programs it will never read.
  for (const name of [
    "backup.tar",
    "archive.7z",
    "bundle.rar",
    "tool.exe",
    "lib.dll",
    "installer.msi",
    "app.apk",
    "macro.bat",
    "task.cmd",
    "module.wasm",
  ]) {
    throws(
      () => assertGuestAttachmentType(name, "text/plain"),
      "GUEST_ATTACHMENT_UNSUPPORTED_TYPE"
    );
    // ...and claiming a supported type for them does not help either.
    throws(
      () => assertGuestAttachmentType(name, "application/pdf"),
      "GUEST_ATTACHMENT_UNSUPPORTED_TYPE"
    );
  }
});

test("the formats added alongside archive support are accepted, paired correctly", () => {
  for (const [name, mediaType] of [
    ["project.zip", "application/zip"],
    ["deploy.sh", "application/x-sh"],
    ["bundle.js", "text/javascript"],
    ["still.gif", "image/gif"],
    ["config.yaml", "application/yaml"],
    ["page.html", "text/html"],
  ]) {
    assert.doesNotThrow(
      () => assertGuestAttachmentType(name, mediaType),
      `${name} / ${mediaType}`
    );
  }
  // A supported format still cannot borrow another one's media type.
  throws(
    () => assertGuestAttachmentType("project.zip", "text/plain"),
    "GUEST_ATTACHMENT_TYPE_MISMATCH"
  );
});

test("an unsupported media type is refused even with a plausible extension", () => {
  throws(
    () => assertGuestAttachmentType("clip.mp4", "video/mp4"),
    "GUEST_ATTACHMENT_UNSUPPORTED_TYPE"
  );
  throws(
    () => assertGuestAttachmentType("sheet.numbers", "application/x-iwork"),
    "GUEST_ATTACHMENT_UNSUPPORTED_TYPE"
  );
});

test("the extension and the media type must agree, in both directions", () => {
  // A renamed binary must not reach a parser...
  throws(
    () => assertGuestAttachmentType("invoice.png", "application/pdf"),
    "GUEST_ATTACHMENT_TYPE_MISMATCH"
  );
  // ...and a real PDF must not be able to hide its shape from the user.
  throws(
    () => assertGuestAttachmentType("notes.txt", "image/png"),
    "GUEST_ATTACHMENT_TYPE_MISMATCH"
  );
  throws(
    () => assertGuestAttachmentType("report", "application/pdf"),
    "GUEST_ATTACHMENT_TYPE_MISMATCH"
  );
});

test("every allowed pairing is accepted", () => {
  for (const [mediaType, extensions] of Object.entries(GUEST_ATTACHMENT_TYPES)) {
    for (const extension of extensions) {
      assert.doesNotThrow(
        () => assertGuestAttachmentType(`sample.${extension}`, mediaType),
        `${mediaType} .${extension}`
      );
    }
  }
});

test("filenames are normalised so nothing that reaches the prompt is a path", () => {
  assert.equal(sanitizeGuestFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeGuestFilename("..\\..\\windows\\system32\\cmd"), "cmd");
  assert.equal(sanitizeGuestFilename("%2e%2e%2fsecret.txt"), "secret.txt");
  assert.equal(sanitizeGuestFilename("a/b/c/report.pdf"), "report.pdf");
  assert.equal(sanitizeGuestFilename("....pdf"), "pdf");
  assert.equal(sanitizeGuestFilename(""), "attachment");
  assert.equal(sanitizeGuestFilename("   "), "attachment");
  // Non-Latin names survive intact: the filter is about separators, not scripts.
  assert.equal(sanitizeGuestFilename("분기보고서.pdf"), "분기보고서.pdf");
  assert.ok(sanitizeGuestFilename(`${"n".repeat(400)}.pdf`).length <= 120);
});

test("the extension is read from the sanitised name, not the raw one", () => {
  assert.equal(guestFileExtension("report.PDF"), "pdf");
  assert.equal(guestFileExtension("../../x.md"), "md");
  assert.equal(guestFileExtension("no-extension"), "");
});

test("a renamed binary is refused before its bytes can be read as text", () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
  const pe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
  const pdf = Buffer.from("%PDF-1.7\n...", "latin1");
  for (const buffer of [zip, elf, pe, pdf]) {
    throws(() => assertGuestTextPayload(buffer), "GUEST_ATTACHMENT_TYPE_MISMATCH");
  }
  // A NUL byte is not text either, whatever the first four bytes were.
  throws(
    () => assertGuestTextPayload(Buffer.from("hello\u0000world", "utf8")),
    "GUEST_ATTACHMENT_TYPE_MISMATCH"
  );
  // Nor is something that is simply not UTF-8 and carries no byte order mark.
  throws(
    () => assertGuestTextPayload(Buffer.from([0x41, 0xc3, 0x28, 0x42])),
    "GUEST_ATTACHMENT_UNREADABLE"
  );
});

test("UTF-16 with a byte order mark is converted rather than refused", () => {
  // A Windows editor writes this without being asked, and the previous check
  // read its NUL bytes as evidence of a binary. The byte order mark is the
  // evidence that it is not, and a strict decode is the proof.
  const utf16le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("hello", "utf16le"),
  ]);
  assert.equal(assertGuestTextPayload(utf16le), "hello");

  const utf16be = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
  assert.equal(assertGuestTextPayload(utf16be), "hi");

  // A UTF-8 byte order mark is stripped, not carried into the prompt.
  assert.equal(
    assertGuestTextPayload(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi", "utf8")])
    ),
    "hi"
  );
});

test("genuine text passes and comes back decoded", () => {
  assert.equal(assertGuestTextPayload(Buffer.from("hello", "utf8")), "hello");
  assert.equal(
    assertGuestTextPayload(Buffer.from("안녕하세요 · 你好", "utf8")),
    "안녕하세요 · 你好"
  );
});

test("one guest's storage prefix is unreachable from another's", () => {
  const a = "guest:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const b = "guest:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const prefixA = guestAttachmentPrefix(a, SECRET);
  const prefixB = guestAttachmentPrefix(b, SECRET);

  assert.notEqual(prefixA, prefixB);
  assert.ok(prefixA.startsWith(GUEST_ATTACHMENT_PREFIX));

  const keyA = createGuestAttachmentKey(
    a,
    SECRET,
    createGuestAttachmentObjectId("11111111-1111-4111-8111-111111111111")
  );
  assert.equal(isOwnGuestAttachmentKey(keyA, a, SECRET), true);
  // The whole point: guest B cannot read, delete or send guest A's object even
  // holding its exact key.
  assert.equal(isOwnGuestAttachmentKey(keyA, b, SECRET), false);
});

test("the prefix depends on the secret, so it cannot be recomputed offline", () => {
  const subject = "guest:cccccccccccccccccccccccccccccccc";
  assert.notEqual(
    guestAttachmentPrefix(subject, SECRET),
    guestAttachmentPrefix(subject, "a-different-secret")
  );
});

test("a key never carries the original filename", () => {
  const key = createGuestAttachmentKey(
    "guest:dddddddddddddddddddddddddddddddd",
    SECRET,
    createGuestAttachmentObjectId("22222222-2222-4222-8222-222222222222")
  );
  assert.ok(!key.includes("."));
  assert.match(key, /^guest-attachments\/[0-9a-f]{32}\/[0-9a-f]{40}$/);
});

test("a traversal-shaped key is refused even inside the right prefix", () => {
  const subject = "guest:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const prefix = guestAttachmentPrefix(subject, SECRET);
  for (const key of [
    `${prefix}../../attachments/someone/file`,
    `${prefix}nested//file`,
    `/${prefix}file`,
  ]) {
    assert.equal(isOwnGuestAttachmentKey(key, subject, SECRET), false, key);
  }
  // A key belonging to the signed-in attachment area is refused outright.
  assert.equal(
    isOwnGuestAttachmentKey("attachments/abc123/2026-07-30/x", subject, SECRET),
    false
  );
});

test("the extracted-text ceiling sits below the guest input-token budget", () => {
  // 16k tokens is the guest default (CHAT_GUEST_MAX_INPUT_TOKENS), and the
  // byte-per-token heuristic the chat route uses is ~4. A ceiling above that
  // would move the refusal from upload time -- where the message names the
  // file -- to send time, after the user has typed a question.
  const guestInputTokenBudget = 16_000;
  assert.ok(GUEST_MAX_EXTRACTED_CHARACTERS / 4 < guestInputTokenBudget);
});
