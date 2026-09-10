import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { REPLAY_COLLECTOR_SOURCE_PATHS, REPLAY_CORPUS_PATH, REPLAY_IMPLEMENTATION_PATHS, validateReplaySourceFiles } from "../lib/routerDevelopmentReplaySource.ts";
import { makeReplayFixture, control } from "./routerDevelopmentReplayFixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "router-development-replay-"));
const checkout = join(temporary, "checkout");
const dependencyLink = join(checkout, "node_modules");
let dependenciesLinked = false;
after(() => {
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("router-development-replay-"));
  if (dependenciesLinked) {
    assert.equal(dirname(dirname(resolve(dependencyLink))), target);
    assert.ok(lstatSync(dependencyLink).isSymbolicLink());
    // Remove the link itself before recursively cleaning the owned temporary tree.
    unlinkSync(dependencyLink);
  }
  rmSync(target, { recursive: true });
});
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|CHAT_MODEL_|.*API_KEY$)/i.test(key))), GIT_ATTR_NOSYSTEM: "1" };
mkdirSync(checkout);
const emptyHooks = join(temporary, "empty-hooks-and-template");
mkdirSync(emptyHooks);
const emptyAttributes = join(temporary, "empty-attributes");
writeFileSync(emptyAttributes, "");
const git = (args) => execFileSync("git", args, { cwd: checkout, env: environment, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
git(["init", "--quiet", `--template=${emptyHooks}`]);
for (const [key, value] of Object.entries({
  "core.autocrlf": "false", "core.eol": "lf", "core.attributesFile": emptyAttributes,
  "core.hooksPath": emptyHooks, "commit.gpgsign": "false", "user.name": "Offline Replay Fixture", "user.email": "replay-fixture@example.invalid",
})) git(["config", "--local", key, value]);
const paths = [...REPLAY_COLLECTOR_SOURCE_PATHS, REPLAY_CORPUS_PATH];
// Anchor the currently tested bytes, including uncommitted edits, in an isolated repository.
// No Git command here reads or writes the real checkout's HEAD, index or configuration.
const copiedPaths = [...paths, ...REPLAY_IMPLEMENTATION_PATHS];
for (const path of copiedPaths) {
  const destination = join(checkout, path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, path), destination);
}
const eolProbePath = "checkout-eol-probe.txt";
const eolProbe = "original LF bytes\nsecond line\n";
writeFileSync(join(checkout, eolProbePath), eolProbe);
git(["add", "--", ...copiedPaths, eolProbePath]);
git(["commit", "--quiet", "--no-gpg-sign", "-m", "Synthetic offline replay source snapshot"]);
const ref = git(["rev-parse", "HEAD"]).trim();
symlinkSync(realpathSync(join(root, "node_modules")), dependencyLink, process.platform === "win32" ? "junction" : "dir");
dependenciesLinked = true;
const anchored = Object.fromEntries(paths.map((path) => [path, git(["show", `${ref}:${path}`])]));
const current = Object.fromEntries(paths.map((path) => [path, readFileSync(join(checkout, path), "utf8")]));
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
const run = (args, env = {}) => spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(trap).href, "scripts/router-development-replay.mjs", ...args], {
  cwd: checkout, encoding: "utf8", maxBuffer: 20 * 1024 * 1024,
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

test("CLI refuses byte and EOL drift in the temporary tracked source without rewriting evidence", () => {
  for (const path of ["lib/models.ts", REPLAY_CORPUS_PATH]) {
    const target = join(checkout, path);
    const original = readFileSync(target, "utf8");
    try {
      writeFileSync(target, `${original}\n`);
      let result = run(validArgs());
      assert.equal(result.status, 1);
      assert.match(result.stderr, /replay_runtime_source_drift/);
      const otherEol = original.includes("\r\n") ? original.replaceAll("\r\n", "\n") : original.replaceAll("\n", "\r\n");
      writeFileSync(target, otherEol);
      result = run(validArgs());
      assert.equal(result.status, 1);
      assert.match(result.stderr, /replay_source_eol_mismatch_requires_byte_preserving_checkout/);
      assert.equal(readFileSync(target, "utf8"), otherEol);
    } finally { writeFileSync(target, original); }
  }
});

test("documented fresh-worktree flags preserve LF blobs despite autocrlf on the synthetic repository", () => {
  const crlfCheckout = join(temporary, "crlf-checkout");
  const lfCheckout = join(temporary, "lf-checkout");
  git(["config", "--local", "core.autocrlf", "true"]);
  try {
    git(["worktree", "add", "--quiet", "--detach", crlfCheckout, ref]);
    assert.equal(readFileSync(join(crlfCheckout, eolProbePath), "utf8"), eolProbe.replaceAll("\n", "\r\n"));
    git(["-c", "core.autocrlf=false", "-c", "core.eol=lf", "worktree", "add", "--quiet", "--detach", lfCheckout, ref]);
    assert.equal(readFileSync(join(lfCheckout, eolProbePath), "utf8"), eolProbe);
    const restored = Object.fromEntries(paths.map((path) => [path, readFileSync(join(lfCheckout, path), "utf8")]));
    assert.deepEqual(validateReplaySourceFiles({ observationSourceRef: ref, anchored, current: restored }), source);
    assert.equal(git(["config", "--local", "--get", "core.autocrlf"]).trim(), "true");
  } finally { git(["config", "--local", "core.autocrlf", "false"]); }
});
