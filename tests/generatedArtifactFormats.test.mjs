import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_FORMAT_TABLE,
  ARTIFACT_KINDS,
  ARTIFACT_LABEL_GROUPS,
  REFUSED_ARTIFACT_EXTENSIONS,
  SUPPORTED_ARTIFACT_FORMATS,
  artifactFormat,
  formatIdsOfKind,
  isRefusedArtifactExtension,
  isSupportedArtifactFormat,
  requireArtifactFormat,
} from "../lib/generatedArtifactFormats.ts";

// docs/policy/generated-artifacts.md section 4.
//
// The format table is the one place the domain's per-format facts live, and
// every other file reads it rather than repeating it. So the properties worth
// testing are the ones that would let two of those facts disagree: an id that
// is not its own extension, a format claimed by no generator, an extension in
// both the supported and the refused list.

test("every id is its own extension", () => {
  for (const format of ARTIFACT_FORMAT_TABLE) {
    assert.equal(format.extension, `.${format.id}`, format.id);
    assert.equal(format.id, format.id.toLowerCase(), format.id);
  }
});

test("ids are unique", () => {
  const seen = new Set();
  for (const format of ARTIFACT_FORMAT_TABLE) {
    assert.equal(seen.has(format.id), false, `duplicate: ${format.id}`);
    seen.add(format.id);
  }
  assert.equal(seen.size, SUPPORTED_ARTIFACT_FORMATS.length);
});

test("every format names a kind that has a generator", () => {
  for (const format of ARTIFACT_FORMAT_TABLE) {
    assert.ok(ARTIFACT_KINDS.includes(format.kind), format.id);
  }
  for (const kind of ARTIFACT_KINDS) {
    assert.ok(formatIdsOfKind(kind).length > 0, `${kind} has no formats`);
  }
});

test("every format names a label group the card can render", () => {
  for (const format of ARTIFACT_FORMAT_TABLE) {
    assert.ok(
      ARTIFACT_LABEL_GROUPS.includes(format.labelGroup),
      `${format.id}: ${format.labelGroup}`
    );
  }
});

test("every media type carries a charset when it is text", () => {
  for (const format of ARTIFACT_FORMAT_TABLE) {
    if (!format.mediaType.startsWith("text/") && format.kind !== "text") continue;
    if (format.mediaType === "application/zip") continue;
    assert.match(format.mediaType, /charset=utf-8/, format.id);
  }
});

test("only text formats declare a content validation", () => {
  for (const format of ARTIFACT_FORMAT_TABLE) {
    if (format.kind === "text") {
      assert.ok(format.validation, format.id);
    } else {
      assert.equal(format.validation, undefined, format.id);
    }
  }
});

// The rule this exists for: an archive must not be able to deliver what a
// direct request is refused. Both lists are consulted by the same admission,
// so an extension in both would make the refusal unreachable.
test("the refused list is disjoint from the supported list", () => {
  for (const extension of REFUSED_ARTIFACT_EXTENSIONS) {
    assert.equal(
      isSupportedArtifactFormat(extension),
      false,
      `${extension} is both supported and refused`
    );
    assert.equal(isRefusedArtifactExtension(extension), true, extension);
  }
});

test("the refused list holds the Windows auto-execute set", () => {
  for (const extension of ["exe", "dll", "bat", "cmd", "msi", "vbs", "reg", "hta"]) {
    assert.equal(isRefusedArtifactExtension(extension), true, extension);
  }
});

test("refusal is case-insensitive and tolerates a leading dot", () => {
  assert.equal(isRefusedArtifactExtension(".EXE"), true);
  assert.equal(isRefusedArtifactExtension("Exe"), true);
});

test("script and markup extensions users ask for are supported, not refused", () => {
  for (const extension of ["sh", "bash", "ps1", "py", "js", "html", "svg", "sql"]) {
    assert.equal(isSupportedArtifactFormat(extension), true, extension);
    assert.equal(isRefusedArtifactExtension(extension), false, extension);
  }
});

test("lookup throws for an unknown id and returns undefined softly", () => {
  assert.equal(artifactFormat("psd"), undefined);
  assert.throws(() => requireArtifactFormat("psd"), /Unknown artifact format/);
});

test("the formats the user asked for are all present", () => {
  for (const format of [
    "xlsx", "docx", "pptx", "pdf",
    "csv", "json", "txt", "md",
    "html", "svg", "zip",
    "yaml", "xml", "sql",
    "ts", "js", "py", "go", "rs", "java", "sh",
  ]) {
    assert.equal(isSupportedArtifactFormat(format), true, format);
  }
});
