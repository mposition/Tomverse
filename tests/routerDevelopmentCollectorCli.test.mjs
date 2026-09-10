import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, posix, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "collector-cli-test-"));
after(() => { const path = resolve(temporary); assert.equal(dirname(path), resolve(tmpdir())); assert.ok(basename(path).startsWith("collector-cli-test-")); rmSync(path, { recursive: true }); });
const trap = join(temporary, "no-network.mjs");
writeFileSync(trap, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram'; import {syncBuiltinESMExports} from 'node:module';
const blocked=()=>{throw new Error('COLLECTOR_TEST_NETWORK_FORBIDDEN');}; globalThis.fetch=blocked; http.request=blocked; http.get=blocked; https.request=blocked; https.get=blocked; net.connect=blocked; net.createConnection=blocked; net.Socket.prototype.connect=blocked; tls.connect=blocked; dgram.createSocket=blocked; syncBuiltinESMExports();`);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CHAT_MODEL_|.*API_KEY$)/i.test(key)));
const run = (args, env = {}, preloads = []) => spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "--import", pathToFileURL(trap).href, ...preloads.flatMap((path) => ["--import", pathToFileURL(path).href]), "scripts/router-development-collect.mjs", ...args], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: { ...environment, ...env } });
let preview;
let proposal;
const proposalPath = join(temporary, "proposal.json");

test("default preview is a network-free full census and never an approval", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  preview = JSON.parse(result.stdout);
  assert.equal(preview.plan.rows.length, 1008);
  assert.equal(preview.plan.summary.plannedCalls, 360);
  assert.equal(preview.approval, null);
  assert.equal(preview.collectionManifest, null);
});
test("explicit proposal binds all source/settings/rates/limits without approving spend", () => {
  const selected = preview.plan.rows.find((row) => row.benchmarkEligibility.eligible);
  const fixtureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = run([`--rows=${selected.rowId}`, "--max-total-microusd=1", "--max-request-microusd=1", "--max-calls=1", "--request-timeout-ms=1000", "--run-timeout-ms=5000", `--expires-at=${fixtureExpiry}`, `--output=${proposalPath}`]);
  assert.equal(result.status, 0, result.stderr);
  proposal = JSON.parse(readFileSync(proposalPath, "utf8"));
  assert.equal(proposal.status, "proposal");
  assert.equal(proposal.completionPossibleWithinLimits, false);
  assert.equal(proposal.plan.rows.length, 1008);
  assert.equal(proposal.calls.length, 1);
  assert.ok(proposal.totalReservedMicroUsd > 1);
  assert.ok(proposal.collectorSource.files["lib/activeAiModel.ts"]);
  assert.ok(proposal.collectorSource.files["package-lock.json"]);
  assert.equal(proposal.calls[0].reserve.outputCapTokens, selected.callConfig.proposedMaxOutputTokens);
  const before = readFileSync(proposalPath, "utf8");
  assert.equal(run([`--output=${proposalPath}`]).status, 1);
  assert.equal(readFileSync(proposalPath, "utf8"), before);
});
test("missing human approval/live flag, unknown or duplicate flags fail without any calls", () => {
  for (const args of [["--live"], ["--mode=execute"], ["--mode=execute", "--live"], ["--mode=export", "--live"], ["--mode=live"], ["--ledger=x"], ["--run-id=x"], ["--mode=preview", "--mode=execute"], ["--max-total-microusd=1"], ["--rows=x"], ["--help", "--live"], ["--live=true"]]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.ok(!result.stderr.includes("COLLECTOR_TEST_NETWORK_FORBIDDEN"));
  }
  const approvalPath = join(temporary, "not-an-approval.json");
  writeFileSync(approvalPath, JSON.stringify(proposal));
  assert.equal(run(["--mode=execute", "--live", `--manifest=${proposalPath}`, `--approval=${approvalPath}`]).status, 1);
});
test("malformed manifest cannot request arbitrary source-file hashing", () => {
  const manifestPath = join(temporary, "forged.json");
  const secret = join(temporary, "should-never-be-printed.txt");
  writeFileSync(secret, "NOT_A_REAL_SECRET_BUT_MUST_NOT_APPEAR");
  const forged = structuredClone(proposal);
  forged.collectorSource.files = { [secret]: "a".repeat(64) };
  writeFileSync(manifestPath, JSON.stringify(forged));
  const result = run(["--mode=execute", "--live", `--manifest=${manifestPath}`, `--approval=${proposalPath}`]);
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes("NOT_A_REAL_SECRET"));
  assert.ok(!result.stdout.includes("NOT_A_REAL_SECRET"));
});
test("case-insensitive pricing overrides are rejected and help is inert", () => {
  assert.equal(run([], { chat_model_gpt_5_6_luna_input_usd_per_million: "123" }).status, 1);
  assert.equal(run(["--help"]).status, 0);
});

test("basename preserves Windows and POSIX root filenames without filesystem access", () => {
  for (const [api, supplied] of [[win32, "C:/run.json"], [posix, "/run.json"], [win32, "C:/folder/run.json"], [posix, "/folder/run.json"]]) {
    const output = api.resolve(supplied);
    assert.equal(api.resolve(api.dirname(output), api.basename(output)), output);
    assert.equal(api.basename(output), "run.json");
  }
});

test("the actual CLI checks and writes one root target while all writes are redirected to a temp fixture", () => {
  const target = join(parse(root).root, `collector-root-fixture-${process.pid}.json`);
  const sink = join(temporary, "redirected-root-output.json");
  const preload = join(temporary, "root-output-trap.mjs");
  writeFileSync(preload, `import fs from 'node:fs'; import {resolve} from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
const target=${JSON.stringify(target)},sink=${JSON.stringify(sink)};let checked=false;const exists=fs.existsSync,open=fs.openSync;
fs.existsSync=(path)=>{if(resolve(String(path))===target){checked=true;return false;}return exists(path);};
fs.openSync=(path,flags,...args)=>{if(resolve(String(path))===target){if(!checked||flags!=='wx')throw new Error('ROOT_TARGET_NOT_CHECKED');return open(sink,flags,...args);}return open(path,flags,...args);};syncBuiltinESMExports();`);
  const result = run([`--output=${target}`], {}, [preload]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).output, target);
  assert.equal(JSON.parse(readFileSync(sink, "utf8")).plan.rows.length, 1008);
  // The root path is intercepted before any existence query or open reaches the filesystem.
});

test("a dot-dot-prefixed child of a temporary common directory is refused while a real outside path is allowed", () => {
  const common = mkdtempSync(join(temporary, "synthetic-common-"));
  const inside = join(common, "..collector.json");
  const outside = join(temporary, "outside-common.json");
  const preload = join(temporary, "common-directory-trap.mjs");
  writeFileSync(preload, `import cp from 'node:child_process'; import fs from 'node:fs'; import {resolve} from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
const common=${JSON.stringify(common)},inside=${JSON.stringify(inside)};const execute=cp.execFileSync,open=fs.openSync;
cp.execFileSync=(command,args,options)=>command==='git'&&args[0]==='rev-parse'&&args[1]==='--git-common-dir'?common:execute(command,args,options);
fs.openSync=(path,flags,...args)=>{if(resolve(String(path))===inside)throw new Error('COMMON_DIRECTORY_WRITE_FORBIDDEN');return open(path,flags,...args);};syncBuiltinESMExports();`);
  const refused = run([`--output=${inside}`], {}, [preload]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr.trim(), "collector_output_existing_or_state_path");
  assert.equal(existsSync(inside), false);
  const allowed = run([`--output=${outside}`], {}, [preload]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(readFileSync(outside, "utf8")).plan.rows.length, 1008);
});
