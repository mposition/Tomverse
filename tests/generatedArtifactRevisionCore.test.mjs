import assert from "node:assert/strict";
import test from "node:test";
import { ARTIFACT_FORMAT_TABLE } from "../lib/generatedArtifactFormats.ts";
import { resolveChatAttachmentFormat } from "../lib/chatAttachmentFormats.ts";
import { generatedArtifactRevisionEnabled, isGeneratedArtifactRevisionSupported } from "../lib/generatedArtifactRevisionCore.ts";

test("revision entry defaults off and requires an explicit local enable", () => {
  const previous = process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
  delete process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
  assert.equal(generatedArtifactRevisionEnabled(), false);
  process.env.GENERATED_ARTIFACT_REVISION_ENABLED = "true";
  assert.equal(generatedArtifactRevisionEnabled(), true);
  if (previous === undefined) delete process.env.GENERATED_ARTIFACT_REVISION_ENABLED;
  else process.env.GENERATED_ARTIFACT_REVISION_ENABLED = previous;
});

test("P0 eligibility is the actual generation/input intersection, with Office limited to DOCX and PPTX", () => {
  for (const output of ARTIFACT_FORMAT_TABLE) {
    const filename = `fixture${output.extension}`;
    const attachment = resolveChatAttachmentFormat({ filename, declaredMediaType: output.mediaType });
    const expected = Boolean(attachment && ((attachment.category === "text" &&
      (output.kind === "text" || ["txt", "md", "csv"].includes(output.id))) ||
      (attachment.category === "office" && ["docx", "pptx"].includes(output.id))));
    assert.equal(isGeneratedArtifactRevisionSupported({ format: output.id, filename, mediaType: output.mediaType }), expected, output.id);
  }
  for (const format of ["txt", "md", "csv", "json", "py", "docx", "pptx"]) {
    assert.equal(isGeneratedArtifactRevisionSupported({ format, filename: `fixture.${format}` }), true, format);
  }
  for (const format of ["xlsx", "pdf", "zip", "png", "unknown"]) {
    assert.equal(isGeneratedArtifactRevisionSupported({ format, filename: `fixture.${format}` }), false, format);
  }
  assert.equal(isGeneratedArtifactRevisionSupported({ format: "txt", filename: "renamed.pdf" }), false);
});
