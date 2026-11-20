import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import {
  CODING_EVAL_LIMITS,
  CODING_EVAL_RUNNER_FILE,
  CODING_EVAL_TASKS,
} from "../lib/codingTaskEvalCore.ts";
import {
  createCodingEvalTools,
  runCodingEval,
  runCodingEvalTask,
  runSandboxedCases,
} from "../lib/codingTaskEval.ts";

// No test in this file reaches a real provider: every model is a MockLanguageModelV4
// handed in through `callModel`.

const task = CODING_EVAL_TASKS.find((candidate) => candidate.id === "range-sum-and-tail");
const SOLUTION = [
  "export function sumRange(start, end) {",
  "  let total = 0;",
  "  for (let i = start; i <= end; i++) total += i;",
  "  return total;",
  "}",
  "export function lastN(items, n) {",
  "  return n <= 0 ? [] : items.slice(-n);",
  "}",
  "",
].join("\n");

const usage = (input, output) => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output, reasoning: 0 },
});
const toolCalls = (calls, input = 100, output = 10) => ({
  content: calls.map(([toolName, args], index) => ({
    type: "tool-call",
    toolCallId: `call-${toolName}-${index}`,
    toolName,
    input: JSON.stringify(args),
  })),
  finishReason: { unified: "tool-calls", raw: "tool_calls" },
  usage: usage(input, output),
  warnings: [],
});
const finalText = (text = "done", input = 50, output = 5) => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: usage(input, output),
  warnings: [],
});
const scripted = (script) => {
  const model = new MockLanguageModelV4({
    doGenerate: async (request) => {
      const step = script[model.doGenerateCalls.length - 1];
      assert.ok(step !== undefined, "the model was called more often than scripted");
      return typeof step === "function" ? step(request) : step;
    },
  });
  return model;
};
const fakeAiModel = (id = "fake-model") => ({ id, name: id, apiModel: id, provider: "openai" });

const harnessDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith("coding-eval-"));

async function withDirs(fn) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ceval-test-")));
  const workspace = join(base, "ws");
  await mkdir(join(workspace, "src"), { recursive: true });
  try {
    return await fn(base, workspace);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const withModule = (source, fn) =>
  withDirs(async (base, workspace) => {
    await writeFile(join(workspace, "src", "index.mjs"), source, "utf8");
    return fn(base, workspace);
  });

// ---------------------------------------------------------------------------
// Sandbox boundary: the probe is the model's module and reports what it could do
// ---------------------------------------------------------------------------

const probeModule = ({ secretFile, secretDir, writeInside, writeOutside, repoFile, home }) => `
import fs from "node:fs";
import childProcess from "node:child_process";
import { Worker } from "node:worker_threads";

const attempt = (action) => {
  try {
    action();
    return "allowed";
  } catch (error) {
    return error && error.code ? error.code : "failed";
  }
};

export function probe() {
  return {
    secretEnv: process.env.CODING_EVAL_SECRET_PROBE === undefined ? "absent" : "present",
    filledEnv: Object.entries(process.env)
      .filter(([key, value]) => value !== "" && key.toLowerCase() !== "systemroot")
      .map(([key]) => key),
    readParentAbsolute: attempt(() => fs.readFileSync(${JSON.stringify(secretFile)}, "utf8")),
    listParentAbsolute: attempt(() => fs.readdirSync(${JSON.stringify(secretDir)})),
    listParentRelative: attempt(() => fs.readdirSync("..")),
    readRepoFile: attempt(() => fs.readFileSync(${JSON.stringify(repoFile)}, "utf8")),
    listHome: attempt(() => fs.readdirSync(${JSON.stringify(home)})),
    readInside: attempt(() => fs.readFileSync("./marker.txt", "utf8")),
    writeInside: attempt(() => fs.writeFileSync(${JSON.stringify(writeInside)}, "x")),
    writeOutside: attempt(() => fs.writeFileSync(${JSON.stringify(writeOutside)}, "x")),
    spawnProcess: attempt(() => childProcess.spawnSync(process.execPath, ["-e", "1"])),
    startWorker: attempt(() => new Worker("1", { eval: true }).terminate()),
  };
}
`;

const DENIED = "ERR_ACCESS_DENIED";

async function prepareProbe(base, workspace) {
  const secretFile = join(base, "secret.txt");
  await writeFile(secretFile, "PARENT-FILE-SECRET", "utf8");
  await writeFile(join(workspace, "marker.txt"), "inside", "utf8");
  return probeModule({
    secretFile,
    secretDir: base,
    writeInside: join(workspace, "written-inside.txt"),
    writeOutside: join(base, "written-outside.txt"),
    repoFile: resolve("package.json"),
    home: homedir(),
  });
}

test("sandboxed code cannot read other files, see the parent environment, write, or start processes", async () => {
  process.env.CODING_EVAL_SECRET_PROBE = "PARENT-ENV-SECRET";
  try {
    await withDirs(async (base, workspace) => {
      await writeFile(join(workspace, "src", "index.mjs"), await prepareProbe(base, workspace), "utf8");
      const result = await runSandboxedCases(workspace, [
        {
          call: "probe",
          args: [],
          expect: {
            secretEnv: "absent",
            filledEnv: [],
            readParentAbsolute: DENIED,
            listParentAbsolute: DENIED,
            listParentRelative: DENIED,
            readRepoFile: DENIED,
            listHome: DENIED,
            readInside: "allowed",
            writeInside: DENIED,
            writeOutside: DENIED,
            spawnProcess: DENIED,
            startWorker: DENIED,
          },
        },
      ]);
      assert.equal(result.problem, null, result.logs);
      assert.deepEqual(result.verdicts, [{ passed: true, reason: "ok" }]);
      assert.equal(result.passed, true);
      assert.ok(!existsSync(join(workspace, "written-inside.txt")) && !existsSync(join(base, "written-outside.txt")));
    });
  } finally {
    delete process.env.CODING_EVAL_SECRET_PROBE;
  }
});

test("the probe is not vacuous: the same module run without the permission model reaches everything", async () => {
  process.env.CODING_EVAL_SECRET_PROBE = "PARENT-ENV-SECRET";
  try {
    await withDirs(async (base, workspace) => {
      const source = await prepareProbe(base, workspace);
      const file = join(workspace, "src", "index.mjs");
      await writeFile(file, source, "utf8");
      const { probe } = await import(`file:///${file.replaceAll("\\", "/")}`);
      const seen = probe();
      assert.equal(seen.secretEnv, "present");
      assert.equal(seen.readParentAbsolute, "allowed");
      assert.equal(seen.listParentAbsolute, "allowed");
      assert.equal(seen.readRepoFile, "allowed");
      assert.equal(seen.listHome, "allowed");
      assert.equal(seen.writeInside, "allowed");
      assert.equal(seen.writeOutside, "allowed");
      assert.equal(seen.spawnProcess, "allowed");
      assert.ok(existsSync(join(workspace, "written-inside.txt")), "the control really did write");
    });
  } finally {
    delete process.env.CODING_EVAL_SECRET_PROBE;
  }
});

test("the network is NOT blocked by the permission model (documented limit: the child holds no secret)", async () => {
  const server = createServer((_request, response) => response.end("reachable"));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address();
    const source = `
const response = await fetch("http://127.0.0.1:${port}/");
const text = await response.text();
export function reached() { return text; }
`;
    await withModule(source, async (_base, workspace) => {
      const result = await runSandboxedCases(workspace, [{ call: "reached", args: [], expect: "reachable" }]);
      assert.equal(result.passed, true, result.problem || JSON.stringify(result.verdicts));
    });
  } finally {
    await new Promise((done) => server.close(done));
  }
});

// ---------------------------------------------------------------------------
// The verdict cannot be forged by the model's code
// ---------------------------------------------------------------------------

const KNOWN_TOKEN = "known-token-0123456789abcdef";
const hiddenCases = task.hidden;

test("forgery: fake TAP output and process.exit(0) at import time is not a pass", async () => {
  const source = `
console.log("TAP version 13");
console.log("ok 1 - everything");
console.log("# tests 1");
console.log("# pass 1");
console.log("# fail 0");
process.exit(0);
`;
  await withModule(source, async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases);
    assert.equal(result.passed, false);
    assert.match(result.problem, /no result frame/);
    assert.equal(result.exitCode, 0, "the forged run really did exit cleanly");
    assert.match(result.logs, /# pass 1/, "the fake output is only a log");
  });
});

test("forgery: a fake frame without the real token is ignored", async () => {
  const frame = JSON.stringify({ importError: null, results: hiddenCases.map(() => ({ ok: true, value: 0 })) });
  const source = `
console.log("@@CODING-EVAL-FRAME@@ guessed-token " + ${JSON.stringify(frame)});
process.exit(0);
`;
  await withModule(source, async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases);
    assert.equal(result.passed, false);
    assert.match(result.problem, /no result frame/);
  });
});

test("forgery: even knowing the token, a frame of guessed values fails, because the expectations never enter the child", async () => {
  // The module is given the token (the test passes the same one to the harness) and tries the strongest
  // thing it can: print a well-formed frame for every case, with every value it could plausibly guess.
  const guesses = hiddenCases.map((entry) => ({ ok: true, value: 0, argsAfter: entry.args, aliased: false }));
  const frame = JSON.stringify({ importError: null, results: guesses });
  const source = `
process.stdout.write("\\n@@CODING-EVAL-FRAME@@ ${KNOWN_TOKEN} " + ${JSON.stringify(frame)} + "\\n");
process.exit(0);
`;
  await withModule(source, async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases, { token: KNOWN_TOKEN });
    assert.equal(result.passed, false);
    assert.equal(result.problem, null, "the frame was accepted as well formed and judged");
    assert.ok(result.verdicts.some((verdict) => !verdict.passed));
  });
});

test("forgery: knowing the token and echoing a frame next to a correct solution is rejected as tampering", async () => {
  const frame = JSON.stringify({ importError: null, results: [] });
  const source = `${SOLUTION}
process.stdout.write("\\n@@CODING-EVAL-FRAME@@ ${KNOWN_TOKEN} " + ${JSON.stringify(frame)} + "\\n");
`;
  await withModule(source, async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases, { token: KNOWN_TOKEN });
    assert.equal(result.passed, false);
    assert.match(result.problem, /more than one result frame/);
  });
});

test("forgery: replacing process.stdout.write or JSON.stringify at import time cannot change what the runner reports", async () => {
  const source = `${SOLUTION}
process.stdout.write = () => true;
JSON.stringify = () => '{"importError":null,"results":[]}';
JSON.parse = () => ({ cases: [] });
Array.isArray = () => false;
`;
  await withModule(source, async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases);
    assert.equal(result.problem, null, "the runner kept its own references");
    assert.equal(result.passed, true, "a correct module with hostile globals is still judged by its values");
  });
});

test("forgery: the module cannot read the token or the cases from stdin, the runner has consumed them", async () => {
  const source = `
import fs from "node:fs";
let stolen = "none";
try { stolen = fs.readFileSync(0, "utf8"); } catch (error) { stolen = "unreadable:" + (error && error.code); }
console.log("STOLEN-START" + stolen + "STOLEN-END");
process.exit(0);
`;
  await withModule(source, async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases, { token: KNOWN_TOKEN });
    assert.equal(result.passed, false);
    assert.ok(result.logs.includes("STOLEN-START"), "the module ran and printed what it read");
    assert.ok(!result.logs.includes(KNOWN_TOKEN), "the token must not reach module code");
    assert.ok(!result.logs.includes("sumRange"), "the cases must not reach module code through stdin");
  });
});

test("forgery: exiting while a case runs, a crash or a hang at import all fail", async () => {
  await withModule(
    "export function sumRange() { process.exit(0); }\nexport function lastN() { return []; }\n",
    async (_base, workspace) => {
      const result = await runSandboxedCases(workspace, hiddenCases);
      assert.equal(result.passed, false);
      assert.match(result.problem, /no result frame/);
    },
  );
  await withModule('throw new Error("boom at import");\n', async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases);
    assert.equal(result.passed, false);
    assert.match(result.problem, /failed to load: Error: boom at import/);
  });
  await withModule("export const = ;\n", async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases);
    assert.equal(result.passed, false);
    assert.match(result.problem, /failed to load: SyntaxError/);
  });
  await withModule("setInterval(() => {}, 1000);\nawait new Promise(() => {});\n", async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases, {
      limits: { testTimeoutMs: 700, testOutputMaxChars: 4000 },
    });
    assert.equal(result.passed, false);
    assert.equal(result.timedOut, true);
  });
});

test("a correct module passes, and its console output is only a log", async () => {
  await withModule(`${SOLUTION}\nconsole.log("debug line from the module");\n`, async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases);
    assert.equal(result.passed, true);
    assert.match(result.logs, /debug line from the module/);
    assert.ok(!existsSync(join(workspace, CODING_EVAL_RUNNER_FILE)), "the runner is removed afterwards");
  });
});

test("a busy loop and an abort signal both stop the child", async () => {
  await withModule(
    "export function sumRange() { while (true) {} }\nexport function lastN() { return []; }\n",
    async (_base, workspace) => {
      const started = Date.now();
      const result = await runSandboxedCases(workspace, hiddenCases, {
        limits: { testTimeoutMs: 700, testOutputMaxChars: 4000 },
      });
      assert.equal(result.timedOut, true);
      assert.equal(result.passed, false);
      assert.equal(result.problem, "timeout");
      assert.ok(Date.now() - started < 8000);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const aborted = await runSandboxedCases(workspace, hiddenCases, { signal: controller.signal });
      assert.equal(aborted.timedOut, true);
    },
  );
});

test("module output is cut to its tail and the workspace path is masked", async () => {
  const source = `${SOLUTION}
for (let i = 0; i < 3000; i++) console.log("noise line " + i);
console.log("cwd is " + process.cwd());
`;
  await withModule(source, async (_base, workspace) => {
    const result = await runSandboxedCases(workspace, hiddenCases, {
      limits: { testTimeoutMs: 15000, testOutputMaxChars: 500 },
    });
    assert.equal(result.passed, true);
    assert.ok(result.logs.length <= 500);
    assert.ok(result.logs.startsWith("[...output truncated...]"));
    assert.ok(!result.logs.includes(workspace), "the real temp path must not reach the model");
    assert.match(result.logs, /cwd is <workspace>/);
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const callTool = (tools, name, input) => tools[name].execute(input, { toolCallId: "t", messages: [] });

test("tools refuse paths that leave the workspace and never write outside it", async () => {
  await withDirs(async (base, workspace) => {
    const tools = createCodingEvalTools(workspace, task);
    const absoluteTarget = join(base, "absolute-escape.txt");
    const attempts = [
      "../escape.txt",
      "src/../../escape.txt",
      absoluteTarget,
      "/tmp/escape.txt",
      "C:\\escape.txt",
      "C:/escape.txt",
      "..\\escape.txt",
      "a\0b.txt",
      CODING_EVAL_RUNNER_FILE,
    ];
    for (const path of attempts) {
      const written = await callTool(tools, "write_file", { path, content: "pwned" });
      assert.ok("error" in written, `write_file accepted ${JSON.stringify(path)}`);
      const read = await callTool(tools, "read_file", { path });
      assert.ok("error" in read, `read_file accepted ${JSON.stringify(path)}`);
    }
    assert.ok(!existsSync(join(base, "escape.txt")));
    assert.ok(!existsSync(absoluteTarget));
    assert.deepEqual(readdirSync(base).sort(), ["ws"]);
    assert.deepEqual(readdirSync(workspace), ["src"]);
  });
});

test("tools read, write, list and cap the workspace", async () => {
  await withDirs(async (_base, workspace) => {
    const limits = { ...CODING_EVAL_LIMITS, maxFiles: 3, maxFileBytes: 100, maxWorkspaceBytes: 110, maxTestRunsPerTask: 1 };
    const tools = createCodingEvalTools(workspace, task, limits);
    assert.deepEqual(await callTool(tools, "write_file", { path: "./src/a.mjs", content: "export const a = 1;\n" }), {
      ok: true,
      bytes: 20,
    });
    assert.deepEqual(await callTool(tools, "read_file", { path: "src/a.mjs" }), { content: "export const a = 1;\n" });
    assert.deepEqual(await callTool(tools, "read_file", { path: "src/missing.mjs" }), { error: "file not found" });
    await callTool(tools, "write_file", { path: "b.txt", content: "b" });
    await callTool(tools, "write_file", { path: "c.txt", content: "c" });
    assert.match((await callTool(tools, "write_file", { path: "d.txt", content: "d" })).error, /3 files/);
    assert.deepEqual(await callTool(tools, "write_file", { path: "c.txt", content: "c2" }), { ok: true, bytes: 2 });
    assert.match((await callTool(tools, "write_file", { path: "c.txt", content: "x".repeat(101) })).error, /larger/);
    // a.mjs (20) and c.txt (2) stay; b.txt may grow until the total reaches the 110 byte cap.
    assert.match((await callTool(tools, "write_file", { path: "b.txt", content: "y".repeat(100) })).error, /in total/);
    assert.deepEqual(await callTool(tools, "write_file", { path: "b.txt", content: "y".repeat(88) }), { ok: true, bytes: 88 });
    const listed = await callTool(tools, "list_files", {});
    assert.deepEqual(listed.files.map((file) => file.path), ["b.txt", "c.txt", "src/a.mjs"]);
  });
});

test("tool output is metered: once the task's budget is spent every tool refuses", async () => {
  await withDirs(async (_base, workspace) => {
    await writeFile(join(workspace, "src", "big.mjs"), "x".repeat(400), "utf8");
    const tools = createCodingEvalTools(workspace, task, { ...CODING_EVAL_LIMITS, maxToolOutputBytes: 600 });
    assert.ok("content" in (await callTool(tools, "read_file", { path: "src/big.mjs" })));
    // About 400 bytes of content and its envelope are spent; a second copy does not fit.
    const refusal = { error: "tool output budget exhausted" };
    assert.deepEqual(await callTool(tools, "read_file", { path: "src/big.mjs" }), refusal);
    assert.deepEqual(await callTool(tools, "list_files", {}), refusal);
    assert.deepEqual(await callTool(tools, "run_tests", {}), refusal);
    assert.deepEqual(await callTool(tools, "write_file", { path: "n.txt", content: "n" }), refusal);
    assert.ok(!existsSync(join(workspace, "n.txt")), "a refused write must not happen");
  });
});

test("run_tests shows the examples' input, expected and actual values and nothing from the hidden cases", async () => {
  await withDirs(async (_base, workspace) => {
    await writeFile(join(workspace, "src", "index.mjs"), task.files["src/index.mjs"], "utf8");
    const tools = createCodingEvalTools(workspace, task);
    const run = await callTool(tools, "run_tests", {});
    assert.equal(run.passed, false);
    assert.equal(run.examples, task.examples.length);
    assert.match(run.output, /sumRange\(1,5\)/);
    assert.match(run.output, /expected: 15/);
    assert.match(run.output, /actual: {3}10/);
    for (const hiddenOnly of ["sumRange(5,1)", "sumRange(-2,2)", "lastN([1,2,3],10)"]) {
      assert.ok(!run.output.includes(hiddenOnly), `${hiddenOnly} is a hidden case`);
    }

    await writeFile(join(workspace, "src", "index.mjs"), SOLUTION, "utf8");
    const passing = await callTool(tools, "run_tests", {});
    assert.equal(passing.passed, true);
    assert.match(passing.output, /all \d+ checks passed/);
  });
});

test("run_tests is limited per task", async () => {
  await withDirs(async (_base, workspace) => {
    await writeFile(join(workspace, "src", "index.mjs"), SOLUTION, "utf8");
    const tools = createCodingEvalTools(workspace, task, { ...CODING_EVAL_LIMITS, maxTestRunsPerTask: 1 });
    assert.equal((await callTool(tools, "run_tests", {})).passed, true);
    assert.match((await callTool(tools, "run_tests", {})).error, /limited/);
  });
});

// ---------------------------------------------------------------------------
// Agent loop with a fake model
// ---------------------------------------------------------------------------

test("a model that writes the fix and runs the tests passes", async () => {
  const before = harnessDirs();
  const model = scripted([
    toolCalls([["list_files", {}], ["read_file", { path: "src/index.mjs" }]], 120, 12),
    toolCalls([["write_file", { path: "src/index.mjs", content: SOLUTION }]], 200, 90),
    toolCalls([["run_tests", {}]], 260, 8),
    finalText("All tests pass.", 300, 7),
  ]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel("fake-solver"), callModel: () => model });
  assert.deepEqual(
    { ...result, durationMs: 0 },
    {
      taskId: "range-sum-and-tail",
      difficulty: "easy",
      modelId: "fake-solver",
      passed: true,
      steps: 4,
      durationMs: 0,
      inputTokens: 120 + 200 + 260 + 300,
      outputTokens: 12 + 90 + 8 + 7,
      failure: null,
      usageUnknown: false,
    },
  );
  assert.equal(model.doGenerateCalls.length, 4);
  const first = model.doGenerateCalls[0];
  assert.deepEqual(first.tools.map((entry) => entry.name).sort(), ["list_files", "read_file", "run_tests", "write_file"]);
  assert.equal(first.maxOutputTokens, CODING_EVAL_LIMITS.maxOutputTokensPerStep);
  // The model saw the task and the starting code, and no case beyond the examples.
  const everything = JSON.stringify(model.doGenerateCalls.map((call) => call.prompt));
  assert.match(everything, /sumRange/);
  assert.ok(!everything.includes("sumRange(5,1)"));
  assert.deepEqual(harnessDirs().filter((name) => !before.includes(name)), [], "the temp workspace must be removed");
});

test("the verdict comes from the final files on the hidden cases, not from the examples", async () => {
  // Passes every example, fails a hidden one: lastN(items, -1) is not an empty array.
  const examplesOnly = SOLUTION.replace("return n <= 0 ? [] : items.slice(-n);", "return n === 0 ? [] : items.slice(-n);");
  const model = scripted([
    toolCalls([["write_file", { path: "src/index.mjs", content: examplesOnly }]]),
    toolCalls([["run_tests", {}]]),
    finalText("done"),
  ]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  const shown = JSON.stringify(model.doGenerateCalls[2].prompt);
  assert.match(shown, /all \d+ checks passed/, "the examples passed, as the model saw");
  assert.equal(result.passed, false);
  assert.equal(result.failure, "tests_failed");
});

test("a model that only claims success is no_change", async () => {
  const model = scripted([finalText("I fixed it, trust me.")]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  assert.equal(result.passed, false);
  assert.equal(result.failure, "no_change");
  assert.equal(result.steps, 1);
  assert.equal(result.usageUnknown, false);
});

test("a change that still fails the cases is tests_failed", async () => {
  const wrong = SOLUTION.replace("n <= 0 ? [] : items.slice(-n)", "items.slice(-n)");
  const model = scripted([toolCalls([["write_file", { path: "src/index.mjs", content: wrong }]]), finalText("done")]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  assert.equal(result.passed, false);
  assert.equal(result.failure, "tests_failed");
});

test("a model that keeps calling tools stops at the step limit", async () => {
  const forever = new MockLanguageModelV4({ doGenerate: async () => toolCalls([["list_files", {}]], 10, 1) });
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => forever, limits: { maxSteps: 3 } });
  assert.equal(forever.doGenerateCalls.length, 3);
  assert.equal(result.steps, 3);
  assert.equal(result.passed, false);
  assert.equal(result.failure, "step_limit");
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 3);
  assert.equal(result.usageUnknown, false);
});

test("the default step limit is 10", async () => {
  const forever = new MockLanguageModelV4({ doGenerate: async () => toolCalls([["list_files", {}]]) });
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => forever });
  assert.equal(CODING_EVAL_LIMITS.maxSteps, 10);
  assert.equal(result.steps, 10);
  assert.equal(result.failure, "step_limit");
});

test("a model that solves the task on its last allowed step is a pass, not a step limit", async () => {
  const model = scripted([toolCalls([["write_file", { path: "src/index.mjs", content: SOLUTION }]]), finalText("done")]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model, limits: { maxSteps: 2 } });
  assert.equal(result.passed, true);
  assert.equal(result.failure, null);
});

test("an attempt to write outside the workspace is refused and leaves nothing behind", async () => {
  const marker = `escape-probe-${process.pid}-${Date.now()}.txt`;
  const outside = join(tmpdir(), marker);
  const model = scripted([
    toolCalls([
      ["write_file", { path: `../${marker}`, content: "pwned" }],
      ["write_file", { path: outside, content: "pwned" }],
      ["read_file", { path: "../../../../etc/passwd" }],
    ]),
    (request) => {
      const results = JSON.stringify(request.prompt);
      assert.match(results, /invalid path/);
      assert.ok(!results.includes("root:"), "a file outside the workspace was read");
      return finalText("could not");
    },
  ]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  assert.ok(!existsSync(outside), "a file was written outside the workspace");
  assert.equal(result.passed, false);
  assert.equal(result.failure, "no_change");
  assert.equal(result.steps, 2);
});

test("a provider error is reported as error, never retried, and its usage is unknown", async () => {
  const broken = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({
        message: "overloaded",
        url: "https://provider.invalid/v1",
        requestBodyValues: {},
        statusCode: 529,
        isRetryable: true,
      });
    },
  });
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => broken });
  assert.equal(broken.doGenerateCalls.length, 1, "maxRetries is 0: a retryable error is still one call");
  assert.equal(result.passed, false);
  assert.equal(result.failure, "error");
  assert.equal(result.steps, 0);
  assert.equal(result.usageUnknown, true);
});

test("an error after some steps keeps the counted usage and marks it unknown", async () => {
  const model = scripted([
    toolCalls([["list_files", {}]], 100, 10),
    () => {
      throw new Error("provider exploded");
    },
  ]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  assert.equal(result.failure, "error");
  assert.equal(result.steps, 1);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.usageUnknown, true);
});

test("a step that reports no usage marks the result usageUnknown", async () => {
  const silent = {
    content: [{ type: "text", text: "done" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
    warnings: [],
  };
  const model = scripted([silent]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  assert.equal(result.failure, "no_change");
  assert.equal(result.usageUnknown, true);
});

test("a failing model factory is reported as error", async () => {
  const result = await runCodingEvalTask({
    task,
    model: fakeAiModel(),
    callModel: () => {
      throw new Error("no api key");
    },
  });
  assert.equal(result.failure, "error");
  assert.equal(result.usageUnknown, true);
});

test("the task timeout stops a stuck model and is reported as timeout with unknown usage", async () => {
  const stuck = new MockLanguageModelV4({
    doGenerate: (options) =>
      new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const started = Date.now();
  const result = await runCodingEvalTask({
    task,
    model: fakeAiModel(),
    callModel: () => stuck,
    limits: { taskTimeoutMs: 400 },
  });
  assert.equal(result.passed, false);
  assert.equal(result.failure, "timeout");
  assert.equal(result.usageUnknown, true);
  assert.ok(Date.now() - started < 8000);
});

// ---------------------------------------------------------------------------
// Batch runner
// ---------------------------------------------------------------------------

test("runCodingEval stops dispatching when shouldContinue turns false", async () => {
  const talker = () => new MockLanguageModelV4({ doGenerate: async () => finalText("nothing to do") });
  const started = [];
  let checks = 0;
  const results = await runCodingEval({
    tasks: CODING_EVAL_TASKS.slice(0, 3),
    models: [fakeAiModel("model-a"), fakeAiModel("model-b")],
    callModel: (model) => {
      started.push(model.id);
      return talker();
    },
    shouldContinue: () => ++checks <= 3,
  });
  assert.equal(results.length, 3);
  assert.equal(checks, 4, "one check per task started plus the one that said stop");
  assert.deepEqual(started, ["model-a", "model-b", "model-a"]);
  assert.deepEqual(results.map((result) => [result.taskId, result.modelId]), [
    [CODING_EVAL_TASKS[0].id, "model-a"],
    [CODING_EVAL_TASKS[0].id, "model-b"],
    [CODING_EVAL_TASKS[1].id, "model-a"],
  ]);
});

test("runCodingEval never starts anything when shouldContinue is false from the start", async () => {
  let built = 0;
  const results = await runCodingEval({
    tasks: CODING_EVAL_TASKS,
    models: [fakeAiModel()],
    callModel: () => {
      built += 1;
      return new MockLanguageModelV4({ doGenerate: async () => finalText() });
    },
    shouldContinue: async () => false,
  });
  assert.deepEqual(results, []);
  assert.equal(built, 0);
});

test("runCodingEval handles a single (task, model) pair", async () => {
  const model = scripted([toolCalls([["write_file", { path: "src/index.mjs", content: SOLUTION }]]), finalText()]);
  const results = await runCodingEval({
    tasks: [task],
    models: [fakeAiModel("single")],
    callModel: () => model,
    shouldContinue: () => true,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].passed, true);
  assert.equal(results[0].modelId, "single");
});

test("runCodingEval runs at most two tasks at once and returns results in dispatch order", async () => {
  let running = 0;
  let peak = 0;
  const delays = { m0: 150, m1: 10, m2: 80, m3: 10 };
  const finished = [];
  const results = await runCodingEval({
    tasks: [task],
    models: Object.keys(delays).map((id) => fakeAiModel(id)),
    concurrency: 9,
    callModel: (model) =>
      new MockLanguageModelV4({
        doGenerate: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((done) => setTimeout(done, delays[model.id]));
          running -= 1;
          return finalText();
        },
      }),
    shouldContinue: () => true,
    onResult: (result) => finished.push(result.modelId),
  });
  assert.equal(peak, 2, "concurrency is clamped to 2");
  assert.deepEqual(results.map((result) => result.modelId), ["m0", "m1", "m2", "m3"]);
  assert.equal(finished.length, 4);
  assert.notDeepEqual(finished, ["m0", "m1", "m2", "m3"], "completion order differs from dispatch order here");
});

test("runCodingEval defaults to one task at a time", async () => {
  let running = 0;
  let peak = 0;
  await runCodingEval({
    tasks: CODING_EVAL_TASKS.slice(0, 3),
    models: [fakeAiModel()],
    callModel: () =>
      new MockLanguageModelV4({
        doGenerate: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((done) => setTimeout(done, 20));
          running -= 1;
          return finalText();
        },
      }),
    shouldContinue: () => true,
  });
  assert.equal(peak, 1);
});

test("the task data is unchanged after a run (the harness copies the files)", async () => {
  const snapshot = JSON.stringify(CODING_EVAL_TASKS);
  const model = scripted([toolCalls([["write_file", { path: "src/index.mjs", content: SOLUTION }]]), finalText()]);
  await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  assert.equal(JSON.stringify(CODING_EVAL_TASKS), snapshot);
});

test("a negative or non-finite step count marks the run unknown, never cancels a real count", async () => {
  for (const bad of [-90, Number.NaN, Number.POSITIVE_INFINITY]) {
    const model = scripted([toolCalls([["list_files", {}]], 100, 10), finalText("done", bad, 5)]);
    const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
    assert.equal(result.usageUnknown, true, String(bad));
    assert.equal(result.inputTokens, 100, "only the valid count is added");
  }
});

test("a write is refused before it is made once its answer no longer fits the tool output budget", async () => {
  await withDirs(async (_base, workspace) => {
    await writeFile(join(workspace, "src", "index.mjs"), "export const x = 1;\n");
    const tools = createCodingEvalTools(workspace, task, { ...CODING_EVAL_LIMITS, maxToolOutputBytes: 200 });
    // Spend the budget down with listings until a write's answer cannot fit.
    for (let i = 0; i < 10; i += 1) await tools.list_files.execute({}, { toolCallId: `l${i}`, messages: [] });
    const answer = await tools.write_file.execute(
      { path: "src/index.mjs", content: "export const x = 2;\n" },
      { toolCallId: "w", messages: [] }
    );
    assert.match(answer.error ?? "", /budget exhausted/);
    assert.equal(await readFile(join(workspace, "src", "index.mjs"), "utf8"), "export const x = 1;\n", "nothing changed behind the refusal");
  });
});
