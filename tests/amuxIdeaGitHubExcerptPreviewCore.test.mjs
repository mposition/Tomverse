import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { prepareAmuxGitHubExcerptPreview } from "../lib/amux/ideaGitHubExcerptPreviewCore.ts";

const SECRET = "s".repeat(32);
const COMMIT = "a".repeat(40);
const REF = "b".repeat(40);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blobSha = (bytes) => createHash("sha1")
  .update(`blob ${bytes.byteLength}\0`, "utf8").update(bytes).digest("hex");

function candidate(text = "alpha\n한국어 beta\n", refName = "refs/heads/main") {
  const bytes = Buffer.from(text, "utf8");
  return {
    status: "unscanned_candidate",
    inspectedRefs: 1,
    witness: {
      repositoryId: 25, name: refName, protected: null,
      refObjectSha: REF, refCommitSha: REF,
    },
    file: {
      status: "verified_file", repositoryId: 25, commitSha: COMMIT,
      path: "docs/guide.md", blobSha: blobSha(bytes), size: bytes.byteLength,
      sha256: sha(bytes), text,
    },
  };
}

function candidateSha256(text = "sha256 payload") {
  const item = candidate(text);
  const content = Buffer.from(text, "utf8");
  item.witness.refObjectSha = "b".repeat(64);
  item.witness.refCommitSha = "b".repeat(64);
  item.file.commitSha = "a".repeat(64);
  item.file.blobSha = createHash("sha256")
    .update(`blob ${content.byteLength}\0`, "utf8").update(content).digest("hex");
  return item;
}

const selectAll = (value) => ({
  candidate: value,
  startByte: 0,
  endByte: Buffer.byteLength(value.file.text, "utf8"),
});

test("preview candidate preserves exact excerpt and binds scope with a keyed digest", () => {
  const source = candidate();
  const result = prepareAmuxGitHubExcerptPreview(
    "Review this source", "gpt-6-astra", [selectAll(source)], SECRET,
  );
  assert.equal(result.status, "preview_candidate");
  assert.equal(result.scannerVersion, "amux-v4-intake-scan-v1");
  assert.equal(result.sources[0].excerptText, source.file.text);
  assert.equal(result.sources[0].refName, "refs/heads/main");
  assert.equal(result.sources[0].fileSha256, source.file.sha256);
  assert.match(result.previewDigest, /^[a-f0-9]{64}$/);
  assert(result.payloadBytes <= 8_192);
  assert(!JSON.stringify(result).includes("Review this source"));
});

test("preview digest changes with model, idea, witness, bytes and selected range", () => {
  const base = candidate();
  const prepare = (idea, model, selection) => prepareAmuxGitHubExcerptPreview(
    idea, model, [selection], SECRET,
  );
  const original = prepare("Review this source", "gpt-6-astra", selectAll(base));
  for (const changed of [
    prepare("Review this file", "gpt-6-astra", selectAll(base)),
    prepare("Review this source", "gpt-6-sol", selectAll(base)),
    prepare("Review this source", "gpt-6-astra", selectAll(candidate(base.file.text, "refs/heads/release"))),
    prepare("Review this source", "gpt-6-astra", selectAll(candidate("alpha\n한국어 beta!\n"))),
    prepare("Review this source", "gpt-6-astra", { candidate: base, startByte: 0, endByte: 5 }),
    prepare("Review this source", "gpt-6-astra", selectAll({
      ...base, witness: { ...base.witness, refObjectSha: "c".repeat(40) },
    })),
    prepare("Review this source", "gpt-6-astra", selectAll({
      ...base, file: { ...base.file, commitSha: "d".repeat(40) },
    })),
    prepare("Review this source", "gpt-6-astra", selectAll({
      ...base, file: { ...base.file, path: "docs/other.md" },
    })),
  ]) {
    assert.equal(changed.status, "preview_candidate");
    assert.notEqual(changed.previewDigest, original.previewDigest);
  }
  assert.equal(prepare("Review this source", "gpt-6-astra", selectAll(base)).previewDigest,
    original.previewDigest);
  assert.notEqual(prepareAmuxGitHubExcerptPreview(
    "Review this source", "gpt-6-astra", [selectAll(base)], "t".repeat(32),
  ).previewDigest, original.previewDigest);
});

test("UTF-8 byte boundaries are strict; no invisible truncation or normalization", () => {
  const source = candidate("한글");
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [{ candidate: source, startByte: 1, endByte: 3 }], SECRET,
  ), { status: "reject", reason: "invalid_utf8_boundary" });
  const valid = prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [{ candidate: source, startByte: 0, endByte: 3 }], SECRET,
  );
  assert.equal(valid.status, "preview_candidate");
  assert.equal(valid.sources[0].excerptText, "한");
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "unpaired \ud800", "gpt-6-astra", [selectAll(candidate())], SECRET,
  ), { status: "reject", reason: "invalid_utf8_input" });
});

test("scanner rejects secrets, personal data and private paths before preview", () => {
  for (const text of ["key=sk-abc123", "email user@example.com", "C:\\Users\\Alice\\secret.txt"]) {
    const source = candidate(text);
    const result = prepareAmuxGitHubExcerptPreview("Inspect", "gpt-6-astra", [selectAll(source)], SECRET);
    assert.equal(result.status, "reject");
    assert.match(result.reason, /^excerpt_/);
  }
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Contact me at user@example.com", "gpt-6-astra", [selectAll(candidate())], SECRET,
  ), { status: "reject", reason: "input_personal_data" });
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [selectAll(candidate("safe", "refs/heads/user@example.com"))], SECRET,
  ), { status: "reject", reason: "metadata_personal_data" });
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "sk-", "gpt-6-astra", [selectAll(candidate("abcdef"))], SECRET,
  ), { status: "reject", reason: "combined_secret" });
});

test("v4 preview refuses additional secret shapes and invisible controls before confirmation", () => {
  for (const text of [
    "API key: abcdefgh12",
    ["sk", "_live_", "1234567890abcdefghijklmnop"].join(""),
    "Please follow \u202Ehidden directions",
    "\uFEFFheader",
    "⚠️ review",
  ]) {
    const result = prepareAmuxGitHubExcerptPreview(
      "Inspect", "gpt-6-astra", [selectAll(candidate(text))], SECRET,
    );
    assert.equal(result.status, "reject");
    assert.match(result.reason, /^excerpt_/);
  }
  const crlf = prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [selectAll(candidate("A\r\nB"))], SECRET,
  );
  assert.equal(crlf.status, "preview_candidate");
  assert.equal(crlf.sources[0].excerptText, "A\r\nB");
});

test("the 8 KiB cap includes typed metadata and all selected text", () => {
  const source = candidate("x".repeat(8_000));
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [selectAll(source)], SECRET,
  ), { status: "reject", reason: "chunk_input_too_large" });
  const first = candidate("x".repeat(4_000));
  const second = candidate("y".repeat(4_000));
  second.file.path = "docs/second.md";
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [selectAll(first), selectAll(second)], SECRET,
  ), { status: "reject", reason: "chunk_input_too_large" });
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", Array.from({ length: 13 }, () => selectAll(candidate("ok"))), SECRET,
  ), { status: "reject", reason: "invalid_excerpt_selection" });
});

test("source hashes, object format and range bounds are checked independently", () => {
  const source = candidate();
  for (const change of [
    (item) => { item.file.size++; },
    (item) => { item.file.sha256 = "f".repeat(64); },
    (item) => { item.file.blobSha = "f".repeat(40); },
    (item) => { item.witness.refCommitSha = "b".repeat(64); },
  ]) {
    const altered = structuredClone(source);
    change(altered);
    assert.deepEqual(prepareAmuxGitHubExcerptPreview(
      "Inspect", "gpt-6-astra", [selectAll(altered)], SECRET,
    ), { status: "hold", reason: "source_unverified" });
  }
  assert.equal(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [selectAll(candidateSha256())], SECRET,
  ).status, "preview_candidate");
  for (const [startByte, endByte] of [[-1, 1], [2, 2], [3, 2], [0, 999], [0.5, 2]]) {
    const result = prepareAmuxGitHubExcerptPreview(
      "Inspect", "gpt-6-astra", [{ candidate: source, startByte, endByte }], SECRET,
    );
    assert.equal(result.status === "reject" || result.status === "hold", true);
  }
});

test("tampered candidate, duplicate ranges and missing selections fail closed", () => {
  const source = candidate();
  source.file.text = "not the original file";
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [selectAll(source)], SECRET,
  ), { status: "hold", reason: "source_unverified" });
  const good = candidate();
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [selectAll(good), selectAll(good)], SECRET,
  ), { status: "reject", reason: "duplicate_excerpt" });
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [
      { candidate: good, startByte: 0, endByte: 5 },
      { candidate: good, startByte: 2, endByte: 5 },
    ], SECRET,
  ), { status: "reject", reason: "duplicate_excerpt" });
  const incompatible = candidate("different file bytes");
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [
      { candidate: good, startByte: 0, endByte: 5 },
      { candidate: incompatible, startByte: 5, endByte: 9 },
    ], SECRET,
  ), { status: "hold", reason: "source_unverified" });
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [], SECRET,
  ), { status: "reject", reason: "invalid_excerpt_selection" });
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [selectAll(good)], "short-key",
  ), { status: "hold", reason: "preview_contract_unverified" });
  const throwing = Object.defineProperty({}, "candidate", {
    get() { throw new Error("sensitive details"); },
  });
  assert.deepEqual(prepareAmuxGitHubExcerptPreview(
    "Inspect", "gpt-6-astra", [throwing], SECRET,
  ), { status: "hold", reason: "preview_unavailable" });
});
