import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import {
  CODING_EVAL_HIDDEN_TEST_FILE,
  CODING_EVAL_LIMITS,
  CODING_EVAL_TASKS,
} from "../lib/codingTaskEvalCore.ts";
import {
  createCodingEvalTools,
  runCodingEval,
  runCodingEvalTask,
  runSandboxedTests,
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
  await mkdir(workspace);
  try {
    return await fn(base, workspace);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Sandbox boundary
// ---------------------------------------------------------------------------

const probeSource = ({ secretFile, secretDir, repoFile, home }) => `
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const denied = { code: "ERR_ACCESS_DENIED" };

test("the parent environment is not visible", () => {
  assert.equal(process.env.CODING_EVAL_SECRET_PROBE, undefined);
  // Windows: SystemRoot is required to start node. libuv also fills in a fixed list of
  // variables unless they are given, so the harness passes them blank.
  const blankOnWindows = new Set(["homedrive", "homepath", "logonserver", "path", "systemdrive", "temp", "userdomain", "username", "userprofile", "windir"]);
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toLowerCase();
    if (name === "systemroot") continue;
    assert.ok(blankOnWindows.has(name), "unexpected variable " + key);
    assert.equal(value, "", key + " must be blank");
  }
});
test("a file in the parent folder cannot be read by absolute path", () => {
  assert.throws(() => fs.readFileSync(${JSON.stringify(secretFile)}, "utf8"), denied);
});
test("a file in the parent folder cannot be read by relative path", () => {
  assert.throws(() => fs.readFileSync("../secret.txt", "utf8"), denied);
});
test("the parent folder cannot be listed", () => {
  assert.throws(() => fs.readdirSync(".."), denied);
  assert.throws(() => fs.readdirSync(${JSON.stringify(secretDir)}), denied);
});
test("a repository file and the home folder cannot be read", () => {
  assert.throws(() => fs.readFileSync(${JSON.stringify(repoFile)}, "utf8"), denied);
  assert.throws(() => fs.readdirSync(${JSON.stringify(home)}), denied);
});
test("the workspace itself is readable", () => {
  assert.equal(fs.readFileSync("./marker.txt", "utf8"), "inside");
});
test("nothing can be written, in the workspace or outside it", () => {
  assert.throws(() => fs.writeFileSync("./written.txt", "x"), denied);
  assert.throws(() => fs.writeFileSync("../written.txt", "x"), denied);
  assert.throws(() => fs.mkdirSync("./newdir"), denied);
});
test("child processes cannot be started", async () => {
  const childProcess = await import("node:child_process");
  assert.throws(() => childProcess.spawnSync(process.execPath, ["-e", "1"]), denied);
});
test("worker threads cannot be started", async () => {
  const { Worker } = await import("node:worker_threads");
  assert.throws(() => new Worker("1", { eval: true }), denied);
});
`;

async function prepareProbe(base, workspace) {
  const secretFile = join(base, "secret.txt");
  await writeFile(secretFile, "PARENT-FILE-SECRET", "utf8");
  await writeFile(join(workspace, "marker.txt"), "inside", "utf8");
  return probeSource({
    secretFile,
    secretDir: base,
    repoFile: resolve("package.json"),
    home: homedir(),
  });
}

test("sandboxed code cannot read other files, the parent environment, or start processes", async () => {
  process.env.CODING_EVAL_SECRET_PROBE = "PARENT-ENV-SECRET";
  try {
    await withDirs(async (base, workspace) => {
      const source = await prepareProbe(base, workspace);
      const result = await runSandboxedTests(workspace, source);
      assert.equal(result.passed, true, result.output);
      assert.ok(!existsSync(join(workspace, "written.txt")) && !existsSync(join(base, "written.txt")));
      assert.ok(!existsSync(join(workspace, "newdir")));
    });
  } finally {
    delete process.env.CODING_EVAL_SECRET_PROBE;
  }
});

test("the probe is not vacuous: the same probe fails without the permission model", async () => {
  process.env.CODING_EVAL_SECRET_PROBE = "PARENT-ENV-SECRET";
  try {
    await withDirs(async (base, workspace) => {
      const source = await prepareProbe(base, workspace);
      await writeFile(join(workspace, "probe.test.mjs"), source, "utf8");
      const unrestricted = spawnSync(process.execPath, ["--test-reporter=tap", "probe.test.mjs"], {
        cwd: workspace,
        // The outer test runner marks its children; without this the probe would speak V8 serialisation.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        encoding: "utf8",
        timeout: 20_000,
      });
      assert.notEqual(unrestricted.status, 0, "an unrestricted node must trip the probe");
      const failedNames = [...unrestricted.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
      for (const expected of [
        "the parent environment is not visible",
        "a file in the parent folder cannot be read by absolute path",
        "nothing can be written, in the workspace or outside it",
        "child processes cannot be started",
      ]) {
        assert.ok(failedNames.includes(expected), `unrestricted run should fail: ${expected}; failed: ${JSON.stringify(failedNames)}`);
      }
      await rm(join(workspace, "written.txt"), { force: true });
      await rm(join(base, "written.txt"), { force: true });
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
    await withDirs(async (_base, workspace) => {
      const source = `
import test from "node:test";
import assert from "node:assert/strict";
test("a local HTTP request succeeds from inside the sandbox", async () => {
  const response = await fetch("http://127.0.0.1:${port}/");
  assert.equal(await response.text(), "reachable");
});
`;
      const result = await runSandboxedTests(workspace, source);
      assert.equal(result.passed, true, result.output);
    });
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("the hidden test file exists only while the tests run, and the workspace path is masked in output", async () => {
  await withDirs(async (_base, workspace) => {
    const source = `
import test from "node:test";
test("fails with a stack", () => { throw new Error("boom " + process.cwd()); });
`;
    const result = await runSandboxedTests(workspace, source);
    assert.equal(result.passed, false);
    assert.ok(!existsSync(join(workspace, CODING_EVAL_HIDDEN_TEST_FILE)));
    assert.ok(!result.output.includes(workspace), "the real temp path leaked into the output the model sees");
    assert.match(result.output, /<workspace>/);
  });
});

test("a hanging test is killed at the timeout", async () => {
  await withDirs(async (_base, workspace) => {
    const source = `
import test from "node:test";
test("never ends", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`;
    const started = Date.now();
    const result = await runSandboxedTests(workspace, source, { testTimeoutMs: 700, testOutputMaxChars: 4000 });
    assert.equal(result.timedOut, true);
    assert.equal(result.passed, false);
    assert.ok(Date.now() - started < 8000, "the kill must not wait for the child");
  });
});

test("a busy loop is killed at the timeout", async () => {
  await withDirs(async (_base, workspace) => {
    const source = `
import test from "node:test";
test("spins", () => { while (true) {} });
`;
    const result = await runSandboxedTests(workspace, source, { testTimeoutMs: 700, testOutputMaxChars: 4000 });
    assert.equal(result.timedOut, true);
    assert.equal(result.passed, false);
  });
});

test("an abort signal kills a running test run", async () => {
  await withDirs(async (_base, workspace) => {
    const source = `
import test from "node:test";
test("spins", () => { while (true) {} });
`;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    const result = await runSandboxedTests(workspace, source, CODING_EVAL_LIMITS, controller.signal);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 8000);
  });
});

test("a file without any test is not a pass", async () => {
  await withDirs(async (_base, workspace) => {
    assert.equal((await runSandboxedTests(workspace, "// nothing here\n")).passed, false);
    assert.equal(
      (await runSandboxedTests(workspace, 'import test from "node:test";\ntest.skip("x", () => {});\n')).passed,
      false,
    );
    assert.equal(
      (await runSandboxedTests(workspace, 'import test from "node:test";\ntest("ok", () => {});\n')).passed,
      true,
    );
  });
});

test("test output is cut to its tail", async () => {
  await withDirs(async (_base, workspace) => {
    const source = `
import test from "node:test";
for (let i = 0; i < 3000; i++) console.log("noise line " + i);
test("failure after a lot of output", () => { throw new Error("the-reason"); });
`;
    const result = await runSandboxedTests(workspace, source, { testTimeoutMs: 15000, testOutputMaxChars: 1000 });
    assert.equal(result.passed, false);
    assert.ok(result.output.length <= 1000);
    assert.ok(result.output.startsWith("[...output truncated...]"));
    assert.match(result.output, /^# fail 1$/m, "the summary at the end of the output must survive");
    assert.ok(!result.output.includes("noise line 5 "), "early output must be dropped");
    assert.ok(!/noise line 5\s/.test(result.output), "early output must be dropped");
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const callTool = (tools, name, input) => tools[name].execute(input, { toolCallId: "t", messages: [] });

test("tools refuse paths that leave the workspace and never write outside it", async () => {
  await withDirs(async (base, workspace) => {
    const tools = createCodingEvalTools(workspace, task.tests);
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
      CODING_EVAL_HIDDEN_TEST_FILE,
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
    assert.deepEqual(readdirSync(workspace), []);
  });
});

test("tools read, write, list and cap the workspace", async () => {
  await withDirs(async (_base, workspace) => {
    const limits = { ...CODING_EVAL_LIMITS, maxFiles: 3, maxFileBytes: 100, maxTestRunsPerTask: 1 };
    const tools = createCodingEvalTools(workspace, 'import test from "node:test";\ntest("ok", () => {});\n', limits);
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
    const listed = await callTool(tools, "list_files", {});
    assert.deepEqual(listed.files.map((file) => file.path), ["b.txt", "c.txt", "src/a.mjs"]);
    assert.equal((await callTool(tools, "run_tests", {})).passed, true);
    assert.match((await callTool(tools, "run_tests", {})).error, /limited/);
    assert.ok(!(await callTool(tools, "list_files", {})).files.some((file) => file.path === CODING_EVAL_HIDDEN_TEST_FILE));
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
    },
  );
  assert.ok(result.durationMs >= 0);
  assert.equal(model.doGenerateCalls.length, 4);
  const first = model.doGenerateCalls[0];
  assert.deepEqual(first.tools.map((entry) => entry.name).sort(), ["list_files", "read_file", "run_tests", "write_file"]);
  assert.equal(first.maxOutputTokens, CODING_EVAL_LIMITS.maxOutputTokensPerStep);
  // The model saw the task and the failing starting code, never the hidden test source.
  const everything = JSON.stringify(model.doGenerateCalls.map((call) => call.prompt));
  assert.match(everything, /sumRange/);
  assert.ok(!everything.includes("assert.equal(sumRange(1, 5), 15)"));
  assert.deepEqual(harnessDirs().filter((name) => !before.includes(name)), [], "the temp workspace must be removed");
});

test("the verdict comes from the final files, not from what the model claims", async () => {
  const model = scripted([finalText("I fixed it, trust me.")]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  assert.equal(result.passed, false);
  assert.equal(result.failure, "no_change");
  assert.equal(result.steps, 1);
});

test("a change that still fails the tests is tests_failed", async () => {
  const wrong = SOLUTION.replace("n <= 0 ? [] : items.slice(-n)", "items.slice(-n)");
  const model = scripted([
    toolCalls([["write_file", { path: "src/index.mjs", content: wrong }]]),
    finalText("done"),
  ]);
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  assert.equal(result.passed, false);
  assert.equal(result.failure, "tests_failed");
});

test("a model that keeps calling tools stops at the step limit", async () => {
  const forever = new MockLanguageModelV4({ doGenerate: async () => toolCalls([["list_files", {}]], 10, 1) });
  const result = await runCodingEvalTask({
    task,
    model: fakeAiModel(),
    callModel: () => forever,
    limits: { maxSteps: 3 },
  });
  assert.equal(forever.doGenerateCalls.length, 3);
  assert.equal(result.steps, 3);
  assert.equal(result.passed, false);
  assert.equal(result.failure, "step_limit");
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 3);
});

test("the default step limit is 10", async () => {
  const forever = new MockLanguageModelV4({ doGenerate: async () => toolCalls([["list_files", {}]]) });
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => forever });
  assert.equal(CODING_EVAL_LIMITS.maxSteps, 10);
  assert.equal(result.steps, 10);
  assert.equal(result.failure, "step_limit");
});

test("a model that solves the task on its last allowed step is a pass, not a step limit", async () => {
  const model = scripted([
    toolCalls([["write_file", { path: "src/index.mjs", content: SOLUTION }]]),
    finalText("done"),
  ]);
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

test("a provider error is reported as error, not thrown", async () => {
  const broken = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("provider exploded");
    },
  });
  const result = await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => broken });
  assert.equal(result.passed, false);
  assert.equal(result.failure, "error");
  assert.equal(result.steps, 0);
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
});

test("the task timeout stops a stuck model and is reported as timeout", async () => {
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

test("the task files are unchanged after a run (the harness copies them)", async () => {
  const snapshot = JSON.stringify(CODING_EVAL_TASKS);
  const model = scripted([
    toolCalls([["write_file", { path: "src/index.mjs", content: SOLUTION }]]),
    finalText(),
  ]);
  await runCodingEvalTask({ task, model: fakeAiModel(), callModel: () => model });
  assert.equal(JSON.stringify(CODING_EVAL_TASKS), snapshot);
});
