import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  benchmarkDigest, canonicalBenchmarkJson, DEVELOPMENT_LIMITS,
  parseDevelopmentCorpus, validateDevelopmentCorpus,
} from "../lib/routerDevelopmentBenchmark.ts";
import {
  CORPUS_V2_LIMITS, CORPUS_V2_FAMILIES, developmentCorpusV2Coverage,
  gradeDevelopmentV2Answer, modelInputForV2Case, parseDevelopmentCorpusV2,
  parseDevelopmentPartitionsV2, promptPacketForV2Corpus,
  validateDevelopmentCorpusV2, validateDevelopmentPartitionsV2,
} from "../lib/routerDevelopmentCorpusV2.ts";

const corpusText = readFileSync(new URL("../docs/ops/router-development-benchmark/development-v2.json", import.meta.url), "utf8");
const corpus = parseDevelopmentCorpusV2(corpusText);
const partitionText = readFileSync(new URL("../docs/ops/router-development-benchmark/development-v2-partitions.json", import.meta.url), "utf8");
const partitions = parseDevelopmentPartitionsV2(partitionText, corpus);
const changeCase = (edit) => { const changed = structuredClone(corpus); edit(changed.cases[0]); return changed; };

test("v2 keeps 48 cases, eight cells and whole-family 24/24 partitions", () => {
  const report = developmentCorpusV2Coverage(corpus, partitions);
  assert.equal(report.cases, 48);
  assert.equal(report.familyCount, 12);
  assert.equal(report.cells.length, 8);
  assert.deepEqual(report.partitions, { tuning: 24, developmentValidation: 24 });
  for (const cell of report.cells) assert.deepEqual([cell.cases, cell.tuning, cell.developmentValidation], [6, 3, 3]);
  for (const family of report.families) {
    assert.equal(family.cases, 4);
    const matrix = corpus.cases.filter((item) => item.familyId === family.familyId).map((item) => `${item.language}:${item.difficulty}`).sort();
    assert.deepEqual(matrix, ["en:advanced", "en:basic", "ko:advanced", "ko:basic"]);
  }
  assert.equal(report.decisionEvidence, false);
  assert.match(report.difficultyBasis, /not_measured/);
  assert.match(report.partitionBasis, /not_independent/);
});

test("v1 exact-24 schema remains unchanged and rejects v2", () => {
  const original = readFileSync(new URL("../docs/ops/router-development-benchmark/development-v1.json", import.meta.url), "utf8");
  // Semantic content is portable across checked-out line endings; historical raw-byte checks remain separate.
  assert.equal(parseDevelopmentCorpus(original).cases.length, 24);
  assert.throws(() => validateDevelopmentCorpus(corpus), /version_or_purpose/);
  assert.throws(() => validateDevelopmentCorpusV2(parseDevelopmentCorpus(original)), /version_or_purpose/);
  const expanded = structuredClone(parseDevelopmentCorpus(original));
  expanded.cases.push(...structuredClone(expanded.cases));
  assert.throws(() => validateDevelopmentCorpus(expanded), /requires_24/);
});

test("strict v2 root and case fields refuse extra metadata and decision purposes", () => {
  assert.throws(() => validateDevelopmentCorpusV2({ ...corpus, approved: true }), /unexpected_or_missing/);
  assert.throws(() => validateDevelopmentCorpusV2({ ...corpus, purpose: "decision" }), /version_or_purpose/);
  assert.throws(() => validateDevelopmentCorpusV2(changeCase((item) => { item.partition = "tuning"; })), /unexpected_or_missing/);
  assert.throws(() => validateDevelopmentCorpusV2(changeCase((item) => { delete item.difficulty; })), /unexpected_or_missing/);
});

test("case count, IDs, cell identity and template ownership are strict", () => {
  assert.throws(() => validateDevelopmentCorpusV2({ ...corpus, cases: corpus.cases.slice(1) }), /requires_48/);
  const duplicate = structuredClone(corpus);
  duplicate.cases[1] = structuredClone(duplicate.cases[0]);
  assert.throws(() => validateDevelopmentCorpusV2(duplicate), /id_or_duplicate/);
  for (const edit of [
    (item) => { item.id = item.id.replace(/01$/, "07"); },
    (item) => { item.language = "fr"; },
    (item) => { item.difficulty = "expert"; },
    (item) => { item.task = "coding"; },
    (item) => { item.familyId = "invented-family"; },
  ]) assert.throws(() => validateDevelopmentCorpusV2(changeCase(edit)), /corpus_v2/);
});

test("duplicate prompts are rejected even under distinct valid IDs", () => {
  const changed = structuredClone(corpus);
  changed.cases[1].prompt = changed.cases[0].prompt;
  assert.throws(() => validateDevelopmentCorpusV2(changed), /duplicate_prompt/);
});

test("requirements never grant search, tool or attachment execution", () => {
  for (const requirements of [
    { needsSearch: true, attachments: [], tools: [] },
    { needsSearch: false, attachments: ["file"], tools: [] },
    { needsSearch: false, attachments: [], tools: ["code"] },
    { needsSearch: false, attachments: [], tools: [], live: true },
  ]) assert.throws(() => validateDevelopmentCorpusV2(changeCase((item) => { item.requirements = requirements; })), /unsupported_mode|unexpected_or_missing/);
});

test("only the original exact JSON grading semantics are accepted", () => {
  for (const edit of [
    (item) => { item.grading.kind = "model-judge"; },
    (item) => { item.grading.arrayOrder = "unordered"; },
    (item) => { item.grading.stringNormalization = "trim"; },
    (item) => { item.expected = []; },
    (item) => { item.expected = {}; },
  ]) assert.throws(() => validateDevelopmentCorpusV2(changeCase(edit)), /grading|expected_object/);
});

test("source blocks must be singular bounded JSON objects with surrounding instructions", () => {
  for (const prompt of [
    "no source block",
    "rule\nSOURCE_JSON\n{}\nEND_SOURCE_JSON\n",
    "rule\nSOURCE_JSON\n[]\nEND_SOURCE_JSON\noutput",
    "rule\nSOURCE_JSON\n{\"x\":1,\"x\":2}\nEND_SOURCE_JSON\noutput",
    "rule\nSOURCE_JSON\n{}\nEND_SOURCE_JSON\noutput\nSOURCE_JSON\n{}\nEND_SOURCE_JSON\noutput",
  ]) assert.throws(() => validateDevelopmentCorpusV2(changeCase((item) => { item.prompt = prompt; })), /source_|json_duplicate_key/);
});

test("corpus and prompt bounds fail closed without changing shared limits", () => {
  assert.equal(CORPUS_V2_LIMITS.corpusBytes, 1_048_576);
  assert.equal(DEVELOPMENT_LIMITS.nodes, 200_000);
  assert.throws(() => parseDevelopmentCorpusV2(" ".repeat(CORPUS_V2_LIMITS.corpusBytes + 1)), /json_byte_limit/);
  assert.throws(() => validateDevelopmentCorpusV2(changeCase((item) => { item.prompt = "x".repeat(DEVELOPMENT_LIMITS.promptBytes + 1); })), /invalid_string/);
  assert.throws(() => validateDevelopmentCorpusV2(changeCase((item) => { item.expected = { oversized: "x".repeat(CORPUS_V2_LIMITS.corpusBytes) }; })), /byte_limit/);
  assert.throws(() => parseDevelopmentCorpusV2('{"schemaVersion":1,"schemaVersion":2}'), /json_duplicate_key/);
  let nested = 0;
  for (let index = 0; index < 34; index++) nested = [nested];
  assert.throws(() => validateDevelopmentCorpusV2(changeCase((item) => { item.expected = { nested }; })), /json_complexity_limit/);
  assert.throws(() => validateDevelopmentCorpusV2(changeCase((item) => { item.expected = { nodes: Array(DEVELOPMENT_LIMITS.nodes + 1).fill(0) }; })), /json_complexity_limit/);
});

test("partition binds the full corpus including gold, rules and difficulty", () => {
  const changed = changeCase((item) => { item.expected.extra = 1; });
  assert.throws(() => validateDevelopmentPartitionsV2(partitions, changed), /partition_corpus_digest/);
  assert.throws(() => validateDevelopmentPartitionsV2({ ...partitions, corpusDigest: "0".repeat(64) }, corpus), /partition_corpus_digest/);
  assert.throws(() => validateDevelopmentPartitionsV2({ ...partitions, purpose: "decision" }, corpus), /partition_version_or_purpose/);
  assert.throws(() => validateDevelopmentPartitionsV2({ ...partitions, selectedCases: [] }, corpus), /unexpected_or_missing/);
});

test("partition refuses omissions, unknown or duplicate families and imbalance", () => {
  assert.throws(() => validateDevelopmentPartitionsV2({ ...partitions, families: partitions.families.slice(1) }, corpus), /partition_families/);
  for (const edit of [
    (rows) => { rows[1] = structuredClone(rows[0]); },
    (rows) => { rows[0].familyId = "unknown"; },
    (rows) => { rows[0].partition = "decision"; },
    (rows) => { rows[0].partition = "development-validation"; },
    (rows) => { rows[0].caseIds = []; },
  ]) {
    const changed = structuredClone(partitions);
    edit(changed.families);
    assert.throws(() => validateDevelopmentPartitionsV2(changed, corpus), /partition_|unexpected_or_missing/);
  }
  assert.throws(() => parseDevelopmentPartitionsV2(" ".repeat(CORPUS_V2_LIMITS.partitionBytes + 1), corpus), /json_byte_limit/);
});

test("balanced family swaps cannot reuse the frozen split-v1 identity", () => {
  const changed = structuredClone(partitions);
  changed.families[0].partition = "development-validation";
  changed.families[3].partition = "tuning";
  assert.throws(() => validateDevelopmentPartitionsV2(changed, corpus), /partition_frozen_assignment/);
});

test("provider projection is exactly prompt only for every case", () => {
  for (const item of corpus.cases) assert.deepEqual(modelInputForV2Case(item), { prompt: item.prompt });
  assert.equal(Object.values(CORPUS_V2_FAMILIES).flat().length, 12);
});

test("prompt packet omits gold and partition and has a deterministic body digest", () => {
  const packet = promptPacketForV2Corpus(corpus);
  const { packetDigest, ...body } = packet;
  assert.equal(packetDigest, benchmarkDigest(canonicalBenchmarkJson(body)));
  assert.equal(packet.cases.length, 48);
  for (const row of packet.cases) assert.deepEqual(Object.keys(row).sort(), ["id", "prompt"]);
  const reordered = structuredClone(corpus);
  reordered.cases.reverse();
  assert.deepEqual(promptPacketForV2Corpus(reordered), packet);
  const changedGold = changeCase((item) => { item.expected.changed = true; });
  assert.deepEqual(promptPacketForV2Corpus(changedGold), packet);
});

test("coverage contains no prompt or answer content and reports every declared cell", () => {
  const report = developmentCorpusV2Coverage(corpus, partitions);
  const serialized = JSON.stringify(report);
  for (const item of corpus.cases) assert.equal(serialized.includes(JSON.stringify(item.prompt)), false);
  assert.equal(Object.hasOwn(report, "expected"), false);
  assert.equal(Object.hasOwn(report, "qualityDelta"), false);
  assert.equal(Object.hasOwn(report, "actualProviderGenerations"), false);
});

// These checks exercise the reused grader. Independent expected-value derivation
// is owned by the separate oracle suite, not these authored-gold positive tests.
for (const item of corpus.cases) {
  test(`${item.id}: exact grader rejects wrong values, extra/missing keys and blank text`, () => {
    assert.equal(gradeDevelopmentV2Answer(item, JSON.stringify(item.expected)).pass, true);
    assert.equal(gradeDevelopmentV2Answer(item, `\n${JSON.stringify(item.expected, null, 2)}\t`).pass, true);
    const keys = Object.keys(item.expected);
    const wrong = structuredClone(item.expected);
    wrong[keys[0]] = "deliberately wrong value";
    assert.equal(gradeDevelopmentV2Answer(item, JSON.stringify(wrong)).pass, false);
    const missing = structuredClone(item.expected);
    delete missing[keys[0]];
    assert.equal(gradeDevelopmentV2Answer(item, JSON.stringify(missing)).pass, false);
    assert.equal(gradeDevelopmentV2Answer(item, JSON.stringify({ ...item.expected, unexpected: true })).pass, false);
    assert.equal(gradeDevelopmentV2Answer(item, " \n\t").reason, "blank_answer");
    assert.equal(gradeDevelopmentV2Answer(item, "```json\n{}\n```").reason, "invalid_json");
  });
}
