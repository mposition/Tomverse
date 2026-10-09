import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { diffPromptRefinerPreview } from "../lib/promptRefinerPreviewDiff.ts";

const reconstructSource = (diff) =>
  diff.commonPrefix + diff.removed + diff.commonSuffix;
const reconstructProposal = (diff) =>
  diff.commonPrefix + diff.added + diff.commonSuffix;

test("preview diff preserves whitespace and Unicode exactly", () => {
  const source = "  질문\t👩🏽‍💻\n이 부분을 유지해 주세요.  ";
  const proposal = "  질문\t👩🏽‍💻\n이 문장을 유지해 주세요.  ";
  const diff = diffPromptRefinerPreview(source, proposal);

  assert.equal(reconstructSource(diff), source);
  assert.equal(reconstructProposal(diff), proposal);
  assert.equal(diff.removed, "부분");
  assert.equal(diff.added, "문장");
});

test("preview diff does not split a changed supplementary Unicode code point", () => {
  const sharedStart = "a".repeat(7_999);
  const sharedEnd = "b".repeat(7_999);
  const source = `${sharedStart}😀${sharedEnd}`;
  const proposal = `${sharedStart}🧪${sharedEnd}`;
  const diff = diffPromptRefinerPreview(source, proposal);

  assert.equal(source.length, 16_000);
  assert.equal(proposal.length, 16_000);
  assert.equal(reconstructSource(diff), source);
  assert.equal(reconstructProposal(diff), proposal);
  assert.equal(diff.removed, "😀");
  assert.equal(diff.added, "🧪");
});

test("preview diff highlights a base character and its new combining mark together", () => {
  const source = "Cafe";
  const proposal = "Cafe\u0301";
  const diff = diffPromptRefinerPreview(source, proposal);

  assert.equal(reconstructSource(diff), source);
  assert.equal(reconstructProposal(diff), proposal);
  assert.equal(diff.commonPrefix, "Caf");
  assert.equal(diff.removed, "e");
  assert.equal(diff.added, "e\u0301");
  assert.equal(diff.commonSuffix, "");
});

test("preview diff highlights a whole joined emoji grapheme", () => {
  const source = "역할: 👩🏽‍💻 완료";
  const proposal = "역할: 👩🏽‍🔬 완료";
  const diff = diffPromptRefinerPreview(source, proposal);

  assert.equal(reconstructSource(diff), source);
  assert.equal(reconstructProposal(diff), proposal);
  assert.equal(diff.removed, "👩🏽‍💻");
  assert.equal(diff.added, "👩🏽‍🔬");
});

test("preview diff keeps a decomposed Hangul syllable inside one changed cluster", () => {
  const source = "끝: \u1100\u1161";
  const proposal = "끝: \u1100\u1162";
  const diff = diffPromptRefinerPreview(source, proposal);

  assert.equal(reconstructSource(diff), source);
  assert.equal(reconstructProposal(diff), proposal);
  assert.equal(diff.commonPrefix, "끝: ");
  assert.equal(diff.removed, "\u1100\u1161");
  assert.equal(diff.added, "\u1100\u1162");
  assert.equal(diff.commonSuffix, "");
});

test("module import and conservative fallback work without Intl.Segmenter", () => {
  const script = String.raw`
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    const imported = await import("./lib/promptRefinerPreviewDiff.ts");
    const diffPromptRefinerPreview = imported.diffPromptRefinerPreview
      ?? imported.default?.diffPromptRefinerPreview;
    const source = "Cafe\u0301 👩🏽‍💻";
    const proposal = "Cafe 👩🏽‍🔬";
    process.stdout.write(JSON.stringify(diffPromptRefinerPreview(source, proposal)));
  `;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(child.status, 0, child.stderr);
  const diff = JSON.parse(child.stdout);
  assert.deepEqual(diff, {
    commonPrefix: "",
    removed: "Cafe\u0301 👩🏽‍💻",
    added: "Cafe 👩🏽‍🔬",
    commonSuffix: "",
  });
});

test("preview diff handles insertion, deletion and identical text", () => {
  for (const [source, proposal] of [
    ["prefixsuffix", "prefix-new-suffix"],
    ["prefix-old-suffix", "prefixsuffix"],
    ["same", "same"],
  ]) {
    const diff = diffPromptRefinerPreview(source, proposal);
    assert.equal(reconstructSource(diff), source);
    assert.equal(reconstructProposal(diff), proposal);
  }
});
