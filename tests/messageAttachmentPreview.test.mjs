import assert from "node:assert/strict";
import test from "node:test";
import {
  PREVIEWABLE_ATTACHMENT_MEDIA_TYPES,
  isPreviewableAttachmentMediaType,
  messageAttachmentPreviewUrl,
} from "../lib/messageAttachmentPreview.ts";
import { CHAT_ATTACHMENT_FORMATS } from "../lib/chatAttachmentFormats.ts";

test("only raster image formats have a thumbnail", () => {
  for (const mediaType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    assert.equal(isPreviewableAttachmentMediaType(mediaType), true, mediaType);
  }
  for (const mediaType of [
    "image/svg+xml",
    "application/pdf",
    "text/html",
    "application/zip",
    "",
    undefined,
  ]) {
    assert.equal(isPreviewableAttachmentMediaType(mediaType), false, String(mediaType));
  }
});

test("every previewable type is a chat image format, and none is SVG", () => {
  const imageTypes = new Set(
    CHAT_ATTACHMENT_FORMATS.filter((format) => format.mediaType.startsWith("image/")).map(
      (format) => format.mediaType
    )
  );
  for (const mediaType of PREVIEWABLE_ATTACHMENT_MEDIA_TYPES) {
    assert.ok(imageTypes.has(mediaType), mediaType);
    assert.ok(!mediaType.includes("svg"));
  }
});

test("the URL carries only the encoded opaque id", () => {
  assert.equal(messageAttachmentPreviewUrl("att_1"), "/api/attachments/att_1/preview");
  assert.equal(
    messageAttachmentPreviewUrl("../x?y"),
    "/api/attachments/..%2Fx%3Fy/preview"
  );
});
