import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AMUX_V22_CONTEXT_FILES, AMUX_V22_TRANSPORT_MAX_BYTES,
  amuxV22EmbedContextFiles, amuxV22ExtractContextFiles, parseAmuxV22ContextFiles } from
  "../lib/amux/v22LocalCliFlowCore.ts";
import { AMUX_BRIDGE_CONTEXT_CHUNKS_FEATURE, AMUX_V22_CONTEXT_PART_NAMES,
  amuxBridgeFeatureListed, amuxV22ContextChunk, isAmuxV22ContextPartName,
  splitAmuxV22ContextFiles } from "../lib/amux/v22ContextPartsCore.ts";
import { AMUX_V22_TRANSFER_CHUNK_BYTES } from "../lib/amux/v22TransferCore.ts";

// docs/policy/amux-v22-result-transfer.md 10.1 (owner direction 2026-11-19):
// the two context files with no source-set size go down in chunks, and no
// byte bound of ours is left on the context set.

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const brief = { name: AMUX_V22_CONTEXT_FILES.brief, text: "Approved brief." };
const answer = { name: AMUX_V22_CONTEXT_FILES.ownerAnswer, text: "The answer." };
const patch = { name: AMUX_V22_CONTEXT_FILES.priorPatch, text: "diff --git a/é b/é\n+한글\n" };
const prior = { name: AMUX_V22_CONTEXT_FILES.priorConclusions, text: "From T-1:\nFindings: ok\n" };
const review = { name: AMUX_V22_CONTEXT_FILES.reviewFindings, text: "Prior findings." };

test("the bridge's feature header is read as an exact token of a comma list", () => {
  const feature = AMUX_BRIDGE_CONTEXT_CHUNKS_FEATURE;
  assert.equal(feature, "context_chunks");
  assert.equal(amuxBridgeFeatureListed("context_chunks", feature), true);
  assert.equal(amuxBridgeFeatureListed("other, context_chunks ,more", feature), true);
  assert.equal(amuxBridgeFeatureListed(null, feature), false);
  assert.equal(amuxBridgeFeatureListed("", feature), false);
  assert.equal(amuxBridgeFeatureListed("context_chunks_v2", feature), false);
  assert.equal(amuxBridgeFeatureListed("not_context_chunks", feature), false);
});

test("only the previous change and the prior conclusions are chunked files", () => {
  assert.deepEqual([...AMUX_V22_CONTEXT_PART_NAMES], ["prior.patch", "prior-conclusions.md"]);
  for (const name of AMUX_V22_CONTEXT_PART_NAMES) assert.equal(isAmuxV22ContextPartName(name), true);
  for (const name of ["brief.md", "owner-answer.md", "review-findings.md", "../prior.patch", "", 1, null])
    assert.equal(isAmuxV22ContextPartName(name), false, String(name));
});

test("without the feature every file stays in the prompt block, as before", () => {
  const files = [brief, answer, patch, prior, review];
  const split = splitAmuxV22ContextFiles(files, false);
  assert.deepEqual(split.embedded, files);
  assert.deepEqual(split.parts, []);
});

test("with the feature the two files become parts and the others stay embedded", () => {
  const files = [brief, answer, patch, prior, review];
  const split = splitAmuxV22ContextFiles(files, true);
  assert.deepEqual(split.embedded, [brief, answer, review]);
  assert.deepEqual(split.parts, [
    { name: "prior.patch", bytes: Buffer.byteLength(patch.text, "utf8"), sha256: sha256(Buffer.from(patch.text, "utf8")) },
    { name: "prior-conclusions.md", bytes: Buffer.byteLength(prior.text, "utf8"), sha256: sha256(Buffer.from(prior.text, "utf8")) },
  ]);
  assert.ok(split.parts[0].bytes > patch.text.length, "bytes are UTF-8 bytes, not characters");
  // The embedded block is exactly the one a sidecar reads back, without the parts.
  const block = amuxV22EmbedContextFiles(split.embedded, () => "a".repeat(32));
  assert.deepEqual(amuxV22ExtractContextFiles(`head\n\n${block}\n`).files, split.embedded);
  assert.equal(block.includes("prior.patch") || block.includes(patch.text), false);
  // No chunked file in the set leaves it unchanged.
  const none = splitAmuxV22ContextFiles([brief, review], true);
  assert.deepEqual(none.embedded, [brief, review]);
  assert.deepEqual(none.parts, []);
});

test("a chunk is the file's bytes at the transfer range, and the digest is of the whole", () => {
  const text = "é".repeat(AMUX_V22_TRANSFER_CHUNK_BYTES) + "tail";
  const whole = Buffer.from(text, "utf8");
  assert.ok(whole.length > 2 * AMUX_V22_TRANSFER_CHUNK_BYTES);
  const first = amuxV22ContextChunk(text, 0);
  const last = amuxV22ContextChunk(text, first.chunkCount - 1);
  assert.equal(first.totalBytes, whole.length);
  assert.equal(first.chunkCount, 3);
  assert.equal(first.sha256, sha256(whole));
  assert.equal(last.sha256, first.sha256);
  const parts = [0, 1, 2].map((index) => amuxV22ContextChunk(text, index).bytes);
  assert.equal(parts[0].length, AMUX_V22_TRANSFER_CHUNK_BYTES);
  assert.ok(Buffer.concat(parts).equals(whole), "the chunks put back the file, a character split across two");
  assert.throws(() => amuxV22ContextChunk(text, 3), RangeError);
  assert.throws(() => amuxV22ContextChunk(text, -1), RangeError);
  assert.throws(() => amuxV22ContextChunk("", 0), RangeError);
});

test("the context set has no byte bound of ours; only names and NUL are checked", () => {
  const big = "x".repeat(AMUX_V22_TRANSPORT_MAX_BYTES / 2 + 1);
  const files = [{ name: AMUX_V22_CONTEXT_FILES.brief, text: big },
    { name: AMUX_V22_CONTEXT_FILES.priorPatch, text: big }];
  assert.equal(parseAmuxV22ContextFiles(files).length, 2);
  assert.throws(() => parseAmuxV22ContextFiles([{ name: "brief.md", text: "a\0b" }]));
  assert.throws(() => parseAmuxV22ContextFiles([{ name: "evil.sh", text: "a" }]));
  assert.equal(AMUX_V22_TRANSPORT_MAX_BYTES, 32 * 1024 * 1024, "the memory backstop stays for the other users");
  const source = readFileSync("lib/amux/v22LocalCliFlowCore.ts", "utf8");
  const parse = source.slice(source.indexOf("export function parseAmuxV22ContextFiles"),
    source.indexOf("const BOUNDARY"));
  assert.doesNotMatch(parse, /AMUX_V22_TRANSPORT_MAX_BYTES|backstop/);
});
