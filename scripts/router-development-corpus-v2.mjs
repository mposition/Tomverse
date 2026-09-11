// Standalone offline corpus checks. No provider, planner, collector or environment configuration.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkDigest, canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";
import {
  CORPUS_V2_LIMITS, developmentCorpusV2Coverage, parseDevelopmentCorpusV2,
  parseDevelopmentPartitionsV2, promptPacketForV2Corpus,
} from "../lib/routerDevelopmentCorpusV2.ts";
import { deriveExpectedForV2Prompt } from "../lib/routerDevelopmentCorpusOracleV2.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
class CliRefusal extends Error {}
const refuse = (code) => { throw new CliRefusal(code); };

function readBounded(path, maximum) {
  const absolute = resolve(path);
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) refuse("input_file_size_or_type");
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum) refuse("input_file_size_or_type");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > maximum) refuse("input_file_byte_limit");
    // Preserve a BOM for the strict JSON grammar to reject; never repair malformed UTF-8.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } finally { closeSync(descriptor); }
}

function assertDirectoryChain(directory) {
  let cursor = directory;
  for (;;) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) refuse("output_directory_chain");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function writeFreshArtifacts(destination, report, packet) {
  const directory = resolve(destination);
  // No recursive parent creation, existing-directory reuse, or symlink/junction traversal.
  assertDirectoryChain(dirname(directory));
  mkdirSync(directory, { mode: 0o700 });
  for (const [name, value] of [["coverage.json", report], ["prompt-only.json", packet]]) {
    assertDirectoryChain(directory);
    writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  // A partial output on filesystem failure is preserved, never silently replaced or retried.
}

function main() {
  const options = new Map();
  const allowed = new Set(["mode", "corpus", "partitions", "out", "help"]);
  const args = process.argv.slice(2);
  if (args.length > allowed.size || args.some((arg) => arg.length > 4096)) refuse("argument_limit");
  for (const argument of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match || !allowed.has(match[1])) refuse("unsupported_argument_no_live_mode");
    const [, key, value] = match;
    if (options.has(key)) refuse("duplicate_argument");
    if (key === "help" ? value !== undefined : !value?.trim()) refuse("argument_requires_equals_value");
    options.set(key, value ?? true);
  }
  if (options.has("help")) {
    if (options.size !== 1) refuse("help_must_be_used_alone");
    console.log("Offline development corpus checks only; no credentials or provider calls.\n" +
      "npm run check:router-development-corpus-v2 -- [--mode=verify] [--corpus=PATH] [--partitions=PATH] [--out=NEW_DIRECTORY]\n" +
      "Default: validate all 48 cases, the frozen family split, and deterministic prompt-rule gold agreement.\n" +
      "Stdout contains coverage/digests only. Optional new directory: coverage.json and prompt-only.json.\n" +
      "This does not collect model answers, run Replay, prove generic prompt unambiguity, or authorize spending.");
    return;
  }
  if ((options.get("mode") ?? "verify") !== "verify") refuse("unsupported_mode_only_verify");
  const corpusText = readBounded(options.get("corpus") ?? join(root, "docs/ops/router-development-benchmark/development-v2.json"), CORPUS_V2_LIMITS.corpusBytes);
  const partitionText = readBounded(options.get("partitions") ?? join(root, "docs/ops/router-development-benchmark/development-v2-partitions.json"), CORPUS_V2_LIMITS.partitionBytes);
  const corpus = parseDevelopmentCorpusV2(corpusText);
  const partitions = parseDevelopmentPartitionsV2(partitionText, corpus);
  let matchedCases = 0;
  for (const { id, prompt, expected } of corpus.cases) {
    // Only these two fields cross into the independently implemented oracle.
    const derived = deriveExpectedForV2Prompt({ id, prompt });
    if (canonicalBenchmarkJson(derived.expected) === canonicalBenchmarkJson(expected)) matchedCases++;
  }
  if (matchedCases !== CORPUS_V2_LIMITS.cases) refuse("oracle_expected_mismatch");
  const packet = promptPacketForV2Corpus(corpus);
  const report = {
    schemaVersion: "router-development-corpus-check-v2", purpose: "development-only",
    evidenceStatus: "development_corpus_checks_only",
    ...developmentCorpusV2Coverage(corpus, partitions),
    inputFileDigests: { corpus: benchmarkDigest(corpusText), partitions: benchmarkDigest(partitionText) },
    promptPacketDigest: packet.packetDigest,
    oracle: { checkedCases: corpus.cases.length, matchedCases, mismatchedCases: 0, promptRuleChecksOnly: true, humanLabels: false },
    providerCalls: 0, incurredProviderSpendUsd: 0, modelQualityMeasured: false,
    measuredDifficulty: null, sampleSizeApproval: null, collectionOrReplayExecuted: false,
    limitations: [
      "Agreement checks bounded supported prompt rules; it is not a proof of generic natural-language unambiguity.",
      "Oracle independence is a recorded development procedure, not certified by this CLI or enforced by filesystem ACLs.",
      "Whole-family separation retains shared task primitives; neither difficulty nor independent statistical sampling was measured.",
      "Standalone corpus only; existing v1 plans, collection manifests, observations and Replay remain separate.",
    ],
  };
  if (options.has("out")) writeFreshArtifacts(options.get("out"), report, packet);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try { main(); }
catch (error) {
  // Never echo parser messages, paths, prompt/gold bytes, credentials, or arbitrary exception text.
  console.error(`router-development-corpus-v2: ${error instanceof CliRefusal ? error.message : "input_or_validation_or_output_failed"}`);
  process.exitCode = 1;
}
