import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { REPLAY_COLLECTOR_SOURCE_PATHS, REPLAY_CORPUS_PATH, validateReplaySourceFiles } from "../lib/routerDevelopmentReplaySource.ts";
import { makeReplayFixture, control } from "./routerDevelopmentReplayFixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "router-development-replay-"));
after(() => {
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("router-development-replay-"));
  rmSync(target, { recursive: true });
});
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const ref = git(["rev-parse", "HEAD"]).trim();
const paths = [...REPLAY_COLLECTOR_SOURCE_PATHS, REPLAY_CORPUS_PATH];
const anchored = Object.fromEntries(paths.map((path) => [path, git(["show", `${ref}:${path}`])]));
const current = Object.fromEntries(paths.map((path) => [path, readFileSync(join(root, path), "utf8")]));
const source = validateReplaySourceFiles({ observationSourceRef: ref, anchored, current });
const fixture = makeReplayFixture({ source: source.benchmark, collectorSource: source.collector });
const manifestPath = join(temporary, "manifest.json");
const answersPath = join(temporary, "answers.json");
const candidatePath = join(temporary, "candidate.json");
writeFileSync(manifestPath, JSON.stringify(fixture.manifest));
writeFileSync(answersPath, JSON.stringify(fixture.answers));
writeFileSync(candidatePath, JSON.stringify(control));
const trap = join(temporary, "no-network.mjs");
writeFileSync(trap, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram'; import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{throw new Error('REPLAY_TEST_NETWORK_FORBIDDEN');};
globalThis.fetch=blocked;http.request=blocked;http.get=blocked;https.request=blocked;https.get=blocked;net.connect=blocked;net.createConnection=blocked;net.Socket.prototype.connect=blocked;tls.connect=blocked;dgram.createSocket=blocked;syncBuiltinESMExports();`);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CHAT_MODEL_|.*API_KEY$)/i.test(key)));
const run = (args, env = {}) => spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(trap).href, "scripts/router-development-replay.mjs", ...args], {
  cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
  env: { ...environment, OPENAI_API_KEY: "test-only-not-a-provider-key", ...env },
});
const validArgs = () => [`--manifest=${manifestPath}`, `--answers=${answersPath}`, `--candidate=${candidatePath}`, `--observation-source-ref=${ref}`];

test("CLI compares a full frozen plan using an independently selected source ref without network", () => {
  const result = run(validArgs());
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.observationSource.benchmark.commit, ref);
  assert.equal(Object.keys(report.observationSource.collector.files).length, 37);
  assert.ok(report.replaySource.files["lib/routerDevelopmentReplay.ts"]);
  assert.equal(report.benchmarkDomain.paired.commonObservedCases, 4);
  assert.equal(report.benchmarkDomain.paired.wholePopulationCorrectOutcomeShareDelta, null);
  assert.equal(report.productCompatibility.baselineObservedCompatibleCases, 0);
  assert.equal(report.inputFileDigests.manifest.length, 64);
  assert.doesNotMatch(result.stdout + result.stderr, /test-only-not-a-provider-key/);
});

test("CLI requires a full explicit source ref, refuses executable policies and ambiguous flags", () => {
  for (const args of [[], ["--live"], ["--plugin=untrusted.mjs"], ["--candidate-js=untrusted.mjs"], ["--output"], ["--help=1"], ["--help", "--live"], [...validArgs(), "--answers=other.json"], validArgs().filter((arg) => !arg.startsWith("--observation-source-ref=")), validArgs().map((arg) => arg.startsWith("--observation-source-ref=") ? "--observation-source-ref=HEAD" : arg)]) {
    assert.equal(run(args).status, 1, JSON.stringify(args));
  }
  assert.equal(run(["--help"]).status, 0);
});

test("CLI refuses original-source self-certification and malformed source paths in a manifest", () => {
  const forged = structuredClone(fixture.manifest);
  forged.plan.source.files = { "C:/must-never-be-read/untrusted-secret.txt": "f".repeat(64) };
  const path = join(temporary, "forged-source.json"); writeFileSync(path, JSON.stringify(forged));
  const result = run(validArgs().map((arg) => arg.startsWith("--manifest=") ? `--manifest=${path}` : arg));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source_snapshot_mismatch/);
  assert.doesNotMatch(result.stderr, /must-never-be-read|untrusted-secret/);
  const untrustedRef = run(validArgs().map((arg) => arg.startsWith("--observation-source-ref=") ? `--observation-source-ref=${"f".repeat(40)}` : arg));
  assert.equal(untrustedRef.status, 1);
});

test("CLI creates only a new output and refuses overwrites or missing parent directories", () => {
  const output = join(temporary, "replay.json");
  assert.equal(run([...validArgs(), `--output=${output}`]).status, 0);
  const original = readFileSync(output, "utf8");
  assert.equal(run([...validArgs(), `--output=${output}`]).status, 1);
  assert.equal(readFileSync(output, "utf8"), original);
  assert.equal(run([...validArgs(), `--output=${join(temporary, "absent-parent", "replay.json")}`]).status, 1);
  assert.equal(run([...validArgs(), `--output=${manifestPath}`]).status, 1);
});

test("CLI rejects overrides and bounded malformed JSON without exposing contents", () => {
  assert.equal(run(validArgs(), { chat_model_gpt_5_6_luna_max_output_tokens: "1" }).status, 1);
  assert.equal(run(["--help"], { CHAT_MODEL_GPT_5_6_LUNA_MAX_OUTPUT_TOKENS: "1" }).status, 0);
  for (const [name, bytes] of [["bad-utf8", Buffer.from([255])], ["too-large", Buffer.alloc(1_048_577, 32)], ["duplicate", Buffer.from('{"schemaVersion":"sensitive-content","schemaVersion":"sensitive-content"}')], ["script", Buffer.from('export default () => process.env.OPENAI_API_KEY')]]) {
    const path = join(temporary, `${name}.json`); writeFileSync(path, bytes);
    const result = run(validArgs().map((arg) => arg.startsWith("--candidate=") ? `--candidate=${path}` : arg));
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /sensitive-content|process.env.OPENAI_API_KEY|test-only-not-a-provider-key/);
  }
});
