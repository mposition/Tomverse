import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { benchmarkDigest, canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "router-corpus-v2-cli-"));
const links = [];
after(() => {
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("router-corpus-v2-cli-"));
  for (const link of links) {
    assert.equal(dirname(resolve(link)), target);
    assert.ok(lstatSync(link).isSymbolicLink());
    unlinkSync(link);
  }
  rmSync(target, { recursive: true });
});
const allowedEnvironment = new Set(["path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "userprofile", "appdata", "localappdata"]);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.has(key.toLowerCase())));
const canary = "CORPUS_V2_PRIVATE_TEST_SENTINEL";
const trap = join(temporary, "no-network.mjs");
writeFileSync(trap, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram'; import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{throw new Error('CORPUS_V2_TEST_NETWORK_FORBIDDEN');};
globalThis.fetch=blocked;http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;net.connect=blocked;net.createConnection=blocked;net.Socket.prototype.connect=blocked;tls.connect=blocked;dgram.createSocket=blocked;syncBuiltinESMExports();`);
const run = (args = []) => spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--import", pathToFileURL(trap).href, "scripts/router-development-corpus-v2.mjs", ...args], {
  cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  env: { ...environment, OPENAI_API_KEY: canary, ANTHROPIC_API_KEY: canary, DEEPSEEK_API_KEY: canary, GOOGLE_GENERATIVE_AI_API_KEY: canary },
});
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const corpusPath = join(root, "docs/ops/router-development-benchmark/development-v2.json");
const partitionsPath = join(root, "docs/ops/router-development-benchmark/development-v2-partitions.json");
const digest = (value) => benchmarkDigest(canonicalBenchmarkJson(value));
function custom(name, corpus, partitions = read(partitionsPath)) {
  const corpusFile = join(temporary, `${name}.corpus.json`);
  const partitionFile = join(temporary, `${name}.partitions.json`);
  writeFileSync(corpusFile, JSON.stringify(corpus));
  writeFileSync(partitionFile, JSON.stringify({ ...partitions, corpusDigest: digest(corpus) }));
  return [`--corpus=${corpusFile}`, `--partitions=${partitionFile}`];
}
function rejected(args) {
  const result = run(args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^router-development-corpus-v2: [a-z_]+\r?\n$/);
  assert.doesNotMatch(result.stderr, new RegExp(canary));
  return result;
}

test("v2 CLI validates all 48 cases offline and reports no measured quality or spending", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.cases, 48);
  assert.equal(report.familyCount, 12);
  assert.equal(report.cells.length, 8);
  assert.ok(report.cells.every((cell) => cell.cases === 6 && cell.tuning === 3 && cell.developmentValidation === 3));
  assert.deepEqual(report.partitions, { tuning: 24, developmentValidation: 24 });
  assert.deepEqual(report.oracle, { checkedCases: 48, matchedCases: 48, mismatchedCases: 0, promptRuleChecksOnly: true, humanLabels: false });
  assert.equal(report.oracle.checkedCases, report.oracle.matchedCases + report.oracle.mismatchedCases);
  assert.equal(report.providerCalls, 0);
  assert.equal(report.incurredProviderSpendUsd, 0);
  assert.equal(report.decisionEvidence, false);
  assert.equal(report.modelQualityMeasured, false);
  assert.equal(report.collectionOrReplayExecuted, false);
  assert.equal(report.measuredDifficulty, null);
  assert.equal(report.sampleSizeApproval, null);
  for (const value of [report.corpusDigest, report.partitionDigest, report.promptPacketDigest, ...Object.values(report.inputFileDigests)]) assert.match(value, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${canary}|SOURCE_JSON|"expected"|"prompt"`));
});

test("v2 CLI exports a deterministic prompt-only packet into one new directory", () => {
  const output = join(temporary, "new-artifacts");
  const result = run([`--out=${output}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(output).sort(), ["coverage.json", "prompt-only.json"]);
  const report = read(join(output, "coverage.json"));
  assert.deepEqual(report, JSON.parse(result.stdout));
  const packet = read(join(output, "prompt-only.json"));
  assert.deepEqual(Object.keys(packet).sort(), ["cases", "packetDigest", "schemaVersion"]);
  assert.equal(packet.cases.length, 48);
  assert.ok(packet.cases.every((item) => Object.keys(item).sort().join(",") === "id,prompt"));
  assert.deepEqual(packet.cases.map((item) => item.id), packet.cases.map((item) => item.id).sort());
  assert.equal(packet.packetDigest, digest({ schemaVersion: packet.schemaVersion, cases: packet.cases }));
  assert.equal(report.promptPacketDigest, packet.packetDigest);
  assert.deepEqual(packet.cases, read(corpusPath).cases.map(({ id, prompt }) => ({ id, prompt })).sort((a, b) => a.id < b.id ? -1 : 1));
  const rerun = run(["--mode=verify"]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.deepEqual(JSON.parse(rerun.stdout), report);
});

test("v2 CLI never overwrites an existing destination or input", () => {
  const output = join(temporary, "existing-artifacts");
  mkdirSync(output);
  const marker = join(output, "keep.txt");
  writeFileSync(marker, canary);
  rejected([`--out=${output}`]);
  assert.deepEqual(readdirSync(output), ["keep.txt"]);
  assert.equal(readFileSync(marker, "utf8"), canary);
  const before = readFileSync(corpusPath);
  rejected([`--out=${corpusPath}`]);
  assert.deepEqual(readFileSync(corpusPath), before);
  rejected([`--out=${join(temporary, "missing-parent", "output")}`]);
});

test("v2 CLI refuses output symlinks and symlinked ancestors without touching targets", () => {
  const target = join(temporary, "link-target");
  mkdirSync(target);
  const link = join(temporary, "output-link");
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  links.push(link);
  rejected([`--out=${link}`]);
  rejected([`--out=${join(link, "descendant")}`]);
  assert.deepEqual(readdirSync(target), []);
});

test("v2 CLI refuses live, executable configuration, ambiguous or unbounded flags", () => {
  for (const args of [
    ["--live"], ["--mode=collect"], ["--mode=score"], ["--plugin=code.mjs"], ["--oracle=code.mjs"], ["--corpus"],
    ["--corpus="], ["--help=1"], ["--help", "--out=unused"], ["--mode=verify", "--mode=verify"],
    ["positional.json"], ["--partitions= "], [`--out=${"x".repeat(4097)}`],
  ]) rejected(args);
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /no credentials or provider calls/);
  assert.doesNotMatch(help.stdout + help.stderr, new RegExp(canary));
});

test("v2 CLI rejects invalid UTF-8, BOM, oversized and malformed corpus input without content leaks", () => {
  const invalid = [
    ["utf8", Buffer.from([255])], ["oversized", Buffer.alloc(1_048_577, 32)],
    ["bom", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(corpusPath)])],
    ["duplicate", `{"x":"${canary}","x":"${canary}"}`],
    ["script", `process.env.OPENAI_API_KEY; ${canary}`],
    ["deep", "[".repeat(100) + "0" + "]".repeat(100)], ["unsafe-integer", '{"n":9007199254740993}'],
  ];
  for (const [name, bytes] of invalid) {
    const file = join(temporary, `${name}.json`);
    writeFileSync(file, bytes);
    rejected([`--corpus=${file}`]);
  }
  rejected([`--corpus=${temporary}`]);
  rejected([`--corpus=${join(temporary, `${canary}-absent.json`)}`]);
});

test("v2 CLI rejects oversized or incompatible partitions before creating artifacts", () => {
  const oversized = join(temporary, "large-partition.json");
  writeFileSync(oversized, Buffer.alloc(16_385, 32));
  rejected([`--partitions=${oversized}`]);
  for (const [name, mutate] of [
    ["digest", (value) => { value.corpusDigest = "f".repeat(64); }],
    ["purpose", (value) => { value.purpose = "decision"; }],
    ["membership", (value) => { value.families[0].partition = "development-validation"; }],
  ]) {
    const partitions = read(partitionsPath);
    mutate(partitions);
    const file = join(temporary, `${name}.partitions.json`);
    writeFileSync(file, JSON.stringify(partitions));
    const output = join(temporary, `${name}-refused-output`);
    rejected([`--partitions=${file}`, `--out=${output}`]);
    assert.ok(!readdirSync(temporary).includes(basename(output)));
  }
});

test("v2 CLI rejects changed gold even when corpus and partition digests agree", () => {
  const corpus = read(corpusPath);
  corpus.cases[0].expected = { wrong: canary };
  const output = join(temporary, "mismatched-gold-refused-output");
  const result = rejected([...custom("mismatched-gold", corpus), `--out=${output}`]);
  assert.match(result.stderr, /oracle_expected_mismatch/);
  assert.ok(!readdirSync(temporary).includes(basename(output)));
});

test("v2 CLI validates custom input and keeps prompt packet stable across case order", () => {
  const corpus = read(corpusPath);
  corpus.cases.reverse();
  const result = run(custom("reordered-corpus", corpus));
  assert.equal(result.status, 0, result.stderr);
  const normal = run();
  assert.equal(normal.status, 0, normal.stderr);
  const changed = JSON.parse(result.stdout);
  const original = JSON.parse(normal.stdout);
  assert.notEqual(changed.corpusDigest, original.corpusDigest);
  assert.notEqual(changed.partitionDigest, original.partitionDigest);
  assert.equal(changed.promptPacketDigest, original.promptPacketDigest);
  assert.deepEqual(changed.oracle, original.oracle);
});

test("v2 CLI implementation has a bounded offline import surface and never reads credential variables", () => {
  const source = readFileSync(join(root, "scripts/router-development-corpus-v2.mjs"), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), ["node:fs", "node:path", "node:url", "../lib/routerDevelopmentBenchmark.ts", "../lib/routerDevelopmentCorpusV2.ts", "../lib/routerDevelopmentCorpusOracleV2.ts"].sort());
  assert.doesNotMatch(source, /process\.env|\bimport\s*\(|\b(?:fetch|eval|Function)\s*\(/);
});
