import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { formatByMediaType } from "../lib/chatAttachmentFormats.ts";
import { MAX_EXTRACTED_ATTACHMENT_CHARACTERS } from "../lib/chatAttachmentLimits.ts";
import { ChatAttachmentValidationError, validateChatAttachmentUpload } from "../lib/chatAttachmentValidation.ts";
import { OfficeTextOverflowError, parseOfficeSafely } from "../lib/officeSecurity.ts";
import { renderDocumentDocx } from "../lib/generatedArtifactDocx.ts";
import { renderPresentationPptx } from "../lib/generatedArtifactPptx.ts";

const docxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pptxType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const documentBytes = (text) => Buffer.from(renderDocumentDocx({
  filename: "source.docx", format: "docx", blocks: [{ type: "paragraph", text }],
}));
const presentationBytes = (text) => Buffer.from(renderPresentationPptx({
  filename: "source.pptx", format: "pptx", slides: [{ layout: "titleAndContent", title: "Plan", bullets: [text] }],
}));
const prepare = (bytes, mediaType, limit = MAX_EXTRACTED_ATTACHMENT_CHARACTERS) =>
  validateChatAttachmentUpload({ buffer: bytes, format: formatByMediaType(mediaType),
    scope: "account", maxExtractedCharacters: limit });

for (const [label, mediaType, render] of [["DOCX", docxType, documentBytes], ["PPTX", pptxType, presentationBytes]]) {
  test(`${label} strict extraction accepts the exact text budget and refuses one character less`, async () => {
    const bytes = render("Keep the blue section. Change the date to Friday.");
    const text = await parseOfficeSafely(bytes, mediaType, 1000, { strictOverflow: true });
    assert.match(text, /Keep the blue section/);
    assert.equal(await parseOfficeSafely(bytes, mediaType, text.length, { strictOverflow: true }), text);
    await assert.rejects(parseOfficeSafely(bytes, mediaType, text.length - 1, { strictOverflow: true }), OfficeTextOverflowError);
    await assert.rejects(prepare(bytes, mediaType, text.length - 1), error =>
      error instanceof ChatAttachmentValidationError && error.code === "ATTACHMENT_TEXT_TOO_LARGE" && error.status === 413);
    assert.deepEqual((await prepare(bytes, mediaType, text.length)).bytes, bytes);
  });

  test(`${label} generated text can be rewritten twice into independent real files without changing the source`, async () => {
    const source = render("Budget: 100. Keep blue section.");
    const originalHash = hash(source);
    const extracted = await parseOfficeSafely(source, mediaType, 1000, { strictOverflow: true });
    const first = render(extracted.replace("Budget: 100", "Budget: 200"));
    const firstText = await parseOfficeSafely(first, mediaType, 1000, { strictOverflow: true });
    assert.match(firstText, /Budget: 200/);
    assert.match(firstText, /Keep blue section/);
    const second = render(firstText.replace("Budget: 200", "Budget: 300"));
    const secondText = await parseOfficeSafely(second, mediaType, 1000, { strictOverflow: true });
    assert.match(secondText, /Budget: 300/);
    assert.match(secondText, /Keep blue section/);
    assert.equal(hash(source), originalHash);
    assert.notEqual(hash(first), originalHash);
    assert.notEqual(hash(second), hash(first));
    // Deterministic renderer/parser coverage; no live model or Office app is used.
  });
}

test("a literal truncation marker is ordinary document content, never completeness metadata", async () => {
  const bytes = documentBytes("Before [Document truncated] after");
  const text = await parseOfficeSafely(bytes, docxType, 1000, { strictOverflow: true });
  assert.equal(text, "Before [Document truncated] after");
  await prepare(bytes, docxType, text.length);
});

test("empty Office text is refused at preparation", async () => {
  await assert.rejects(prepare(documentBytes(""), docxType), error =>
    error instanceof ChatAttachmentValidationError && error.code === "ATTACHMENT_NO_TEXT");
});

test("historical Office extraction keeps its existing bounded truncation behavior", async () => {
  const bytes = documentBytes("Longer text than the historical budget.");
  assert.equal(await parseOfficeSafely(bytes, docxType, 6), "Longer\n\n[Document truncated]");
});

test("text and CSV preparation reject complete inputs beyond the extraction ceiling without altering bytes", async () => {
  for (const mediaType of ["text/plain", "text/csv"]) {
    const bytes = Buffer.from("name,value\nkeep,100\n");
    const before = hash(bytes);
    await assert.rejects(prepare(bytes, mediaType, bytes.length - 1), error =>
      error instanceof ChatAttachmentValidationError && error.code === "ATTACHMENT_TEXT_TOO_LARGE");
    assert.equal(hash(bytes), before);
    assert.deepEqual((await prepare(bytes, mediaType, bytes.length)).bytes, bytes);
  }
});
