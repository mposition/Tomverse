import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { benchmarkDigest } from "../lib/routerDevelopmentBenchmark.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "router-development-benchmark-"));
after(() => {
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith("router-development-benchmark-"));
  rmSync(target, { recursive: true });
});
const trap = join(temporary, "no-network.mjs");
// A local test preload makes accidental network attempts fail, even with credentials present.
writeFileSync(trap, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram'; import { syncBuiltinESMExports } from 'node:module';
const refused = () => { throw new Error('FORBIDDEN_PROVIDER_OR_NETWORK_CALL'); };
globalThis.fetch = refused; http.request = refused; http.get = refused; https.request = refused; https.get = refused; net.connect = refused; net.createConnection = refused; net.Socket.prototype.connect = refused; tls.connect = refused; dgram.createSocket = refused; syncBuiltinESMExports();\n`);
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CHAT_MODEL_/i.test(key)));
const run = (args, overrides = {}) => spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(trap).href, "scripts/router-development-benchmark.mjs", ...args], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: { ...cleanEnvironment, OPENAI_API_KEY: "test-only-not-a-real-key", ...overrides } });
const planPath = join(temporary, "plan.json");
let plan;

test("CLI defaults to offline full matrix and writes a new plan with no provider traffic", () => {
  const before = readdirSync(temporary).sort();
  const result = run([`--output=${planPath}`]);
  assert.equal(result.status, 0, result.stderr);
  plan = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(plan.inputs.plan, "Pro");
  assert.equal(plan.inputs.requestedModelId, "gpt-5-6-luna");
  assert.equal(plan.summary.cases, 24);
  assert.equal(plan.summary.catalogueRows, 24 * plan.models.length);
  assert.equal(plan.summary.completedActualGenerations, 0);
  assert.equal(plan.summary.incurredProviderSpendUsd, 0);
  assert.ok(plan.byCase.every((item) => item.plannedCalls > 0));
  assert.deepEqual(readdirSync(temporary).sort(), [...before, "plan.json"].sort());
});

test("CLI refuses live/unknown/ambiguous arguments before work", () => {
  for (const args of [["--live"], ["--mode=live"], ["--mode=pilot"], ["--send"], ["--mode=dry-run", "--mode=score"], ["--output"], ["--plan=Unlimited"], ["--requested-model=unknown-model"], ["--mode=score"], ["--answers=missing"], ["--help", "--output=x"]]) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.ok(!result.stderr.includes("test-only-not-a-real-key"));
  }
  assert.equal(run(["--help"]).status, 0);
});

test("CLI refuses accidental overwrite and pricing environment overrides", () => {
  const original = readFileSync(planPath, "utf8");
  assert.equal(run([`--output=${planPath}`]).status, 1);
  assert.equal(readFileSync(planPath, "utf8"), original);
  const result = run(["--help"], { CHAT_MODEL_GPT_5_6_LUNA_MAX_OUTPUT_TOKENS: "2048" });
  assert.equal(result.status, 0); // Help never reads a catalogue or pricing.
  const overridden = run([], { CHAT_MODEL_GPT_5_6_LUNA_MAX_OUTPUT_TOKENS: "2048" });
  assert.equal(overridden.status, 1);
  assert.match(overridden.stderr, /pricing_environment_overrides_unsupported/);
  const lowercase = run([], { chat_model_gpt_5_6_luna_input_usd_per_million: "123" });
  assert.equal(lowercase.status, 1);
  assert.match(lowercase.stderr, /pricing_environment_overrides_unsupported/);
});

test("CLI grades saved fixtures offline and keeps missing coverage explicit", () => {
  const corpus = JSON.parse(readFileSync(join(root, "docs/ops/router-development-benchmark/development-v1.json"), "utf8"));
  const selected = plan.rows.find((row) => row.benchmarkEligibility.eligible);
  const answerText = JSON.stringify(corpus.cases.find((item) => item.id === selected.caseId).expected);
  const answers = { schemaVersion: "router-development-results-v1", purpose: "development-only", corpusDigest: plan.corpusDigest, planDigest: plan.planDigest, origin: { kind: "synthetic-fixture", description: "CLI test only; no provider output." }, rows: [{ rowId: selected.rowId, caseId: selected.caseId, modelId: selected.modelId, provider: selected.provider, apiModel: selected.apiModel, promptDigest: selected.promptDigest, callConfigDigest: selected.callConfigDigest, status: "succeeded", answerText, answerDigest: benchmarkDigest(answerText), failureCode: null, recordedAt: null, providerResponseId: null, modelVersion: null, metrics: { inputTokens: null, outputTokens: null, latencyMs: null, providerCostUsd: null } }] };
  const answersPath = join(temporary, "answers.json");
  writeFileSync(answersPath, JSON.stringify(answers));
  const scorePath = join(temporary, "score.json");
  const result = run(["--mode=score", `--plan-file=${planPath}`, `--answers=${answersPath}`, `--output=${scorePath}`]);
  assert.equal(result.status, 0, result.stderr);
  const score = JSON.parse(readFileSync(scorePath, "utf8"));
  assert.equal(score.summary.passed, 1);
  assert.equal(score.summary.notRun, plan.summary.plannedCalls - 1);
  assert.equal(score.summary.correctnessRate, null);
  assert.equal(score.summary.failed, 0);
  assert.equal(score.reportedMetrics.providerCostUsd.total, null);
  assert.equal(score.providerCallsByThisTool, 0);
  assert.equal(score.evidenceStatus, "fixture_validation_only");
  assert.equal(run(["--mode=score", `--plan-file=${planPath}`, `--answers=${answersPath}`, `--output=${scorePath}`]).status, 1);
  const duplicatePath = join(temporary, "duplicate.json");
  writeFileSync(duplicatePath, JSON.stringify({ ...answers, rows: [...answers.rows, ...answers.rows] }));
  assert.equal(run(["--mode=score", `--plan-file=${planPath}`, `--answers=${duplicatePath}`]).status, 1);
  const forgedPath = join(temporary, "forged-plan.json");
  writeFileSync(forgedPath, JSON.stringify({ ...plan, summary: { ...plan.summary, plannedCalls: 1 } }));
  assert.equal(run(["--mode=score", `--plan-file=${forgedPath}`, `--answers=${answersPath}`]).status, 1);
});

test("CLI rejects malformed UTF-8, oversized input and duplicate JSON keys", () => {
  for (const [name, bytes] of [["invalid-utf8.json", Buffer.from([0xff])], ["too-big.json", Buffer.alloc(1_048_577, 32)], ["duplicate-keys.json", Buffer.from('{"schemaVersion":"x","schemaVersion":"x"}')]]) {
    const path = join(temporary, name); writeFileSync(path, bytes);
    const result = run([`--corpus=${path}`]);
    assert.equal(result.status, 1);
  }
});
