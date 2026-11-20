import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CODING_EVAL_FRAME_PREFIX,
  CODING_EVAL_LIMITS,
  CODING_EVAL_RUNNER_FILE,
  CODING_EVAL_RUNNER_SOURCE,
  CODING_EVAL_TASKS,
  buildRunnerCases,
  canonicalJson,
  checkSandboxWrite,
  codingEvalSystemPrompt,
  codingEvalWorstCaseTokens,
  formatCodingEvalReport,
  judgeCodingEvalCases,
  keepTail,
  parseRunnerOutput,
  resolveSandboxPath,
  summarizeCodingEval,
} from "../lib/codingTaskEvalCore.ts";
import { runSandboxedCases } from "../lib/codingTaskEval.ts";

// Reference solutions live only here. The shipped tasks never contain them.
const SOLUTIONS = {
  "range-sum-and-tail": {
    "src/index.mjs": `
export function sumRange(start, end) {
  let total = 0;
  for (let i = start; i <= end; i++) total += i;
  return total;
}
export function lastN(items, n) {
  return n <= 0 ? [] : items.slice(-n);
}
`,
  },
  "query-string-parser": {
    "src/index.mjs": `
const decode = (text) => decodeURIComponent(text.replace(/\\+/g, " "));
export function parseQuery(input) {
  const result = {};
  const text = input.startsWith("?") ? input.slice(1) : input;
  for (const pair of text.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = decode(eq === -1 ? pair : pair.slice(0, eq));
    const value = decode(eq === -1 ? "" : pair.slice(eq + 1));
    if (Object.hasOwn(result, key)) result[key] = [].concat(result[key], value);
    else result[key] = value;
  }
  return result;
}
`,
  },
  "lru-cache": {
    "src/index.mjs": `
export class LRUCache {
  #capacity;
  #map = new Map();
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.#capacity = capacity;
  }
  get(key) {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key);
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }
  set(key, value) {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#capacity) this.#map.delete(this.#map.keys().next().value);
    return this;
  }
  has(key) {
    return this.#map.has(key);
  }
  get size() {
    return this.#map.size;
  }
  keys() {
    return [...this.#map.keys()];
  }
}
`,
  },
  "merge-intervals": {
    "src/index.mjs": `
export function mergeIntervals(intervals) {
  const sorted = intervals
    .map(([start, end]) => {
      if (start > end) throw new RangeError("inverted interval");
      return [start, end];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
`,
  },
  "expression-parser": {
    "src/index.mjs": `
function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\\s/.test(ch)) { i++; continue; }
    const number = /^(?:\\d+(?:\\.\\d+)?|\\.\\d+)/.exec(source.slice(i));
    if (number) { tokens.push(Number(number[0])); i += number[0].length; continue; }
    if ("+-*/^()".includes(ch)) { tokens.push(ch); i++; continue; }
    throw new SyntaxError("Unexpected character " + ch);
  }
  return tokens;
}
export function evaluate(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function expression() {
    let value = term();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const right = term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }
  function term() {
    let value = unary();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const right = unary();
      if (op === "/") {
        if (right === 0) throw new RangeError("Division by zero");
        value /= right;
      } else value *= right;
    }
    return value;
  }
  function unary() {
    if (peek() === "-") { next(); return -unary(); }
    if (peek() === "+") { next(); return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() === "^") { next(); return base ** unary(); }
    return base;
  }
  function primary() {
    const token = next();
    if (typeof token === "number") return token;
    if (token === "(") {
      const value = expression();
      if (next() !== ")") throw new SyntaxError("Expected )");
      return value;
    }
    throw new SyntaxError("Unexpected token");
  }
  const value = expression();
  if (pos !== tokens.length) throw new SyntaxError("Unexpected trailing input");
  return value;
}
`,
  },
  "dependency-order": {
    "src/index.mjs": `
export class CycleError extends Error {
  constructor(cycle) {
    super("dependency cycle");
    this.cycle = cycle;
  }
}
export function topoSort(graph) {
  const deps = new Map();
  const ensure = (node) => { if (!deps.has(node)) deps.set(node, new Set()); return deps.get(node); };
  for (const node of Object.keys(graph)) {
    ensure(node);
    for (const dep of graph[node]) { ensure(node).add(dep); ensure(dep); }
  }
  const dependents = new Map([...deps.keys()].map((node) => [node, []]));
  const remaining = new Map();
  for (const [node, set] of deps) {
    remaining.set(node, set.size);
    for (const dep of set) dependents.get(dep).push(node);
  }
  const ready = [...deps.keys()].filter((node) => remaining.get(node) === 0);
  const order = [];
  while (ready.length > 0) {
    ready.sort();
    const node = ready.shift();
    order.push(node);
    for (const dependent of dependents.get(node)) {
      remaining.set(dependent, remaining.get(dependent) - 1);
      if (remaining.get(dependent) === 0) ready.push(dependent);
    }
  }
  if (order.length < deps.size) {
    const unresolved = new Set([...deps.keys()].filter((node) => remaining.get(node) > 0));
    const path = [];
    let node = [...unresolved].sort()[0];
    while (!path.includes(node)) {
      path.push(node);
      node = [...deps.get(node)].filter((dep) => unresolved.has(dep)).sort()[0];
    }
    throw new CycleError([...path.slice(path.indexOf(node)), node]);
  }
  return order;
}
`,
  },
};

async function inWorkspace(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), "ceval-test-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const path = join(dir, ...relative.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the task set is six distinct tasks, two per difficulty", () => {
  assert.equal(CODING_EVAL_TASKS.length, 6);
  assert.equal(new Set(CODING_EVAL_TASKS.map((task) => task.id)).size, 6);
  for (const difficulty of ["easy", "medium", "hard"]) {
    assert.equal(CODING_EVAL_TASKS.filter((task) => task.difficulty === difficulty).length, 2, difficulty);
  }
});

test("every task is well formed: wire-clean cases, examples inside hidden, no test file", () => {
  const wire = (value) => JSON.parse(JSON.stringify(value));
  for (const task of CODING_EVAL_TASKS) {
    assert.ok(task.prompt.length > 40, task.id);
    assert.equal("tests" in task, false, `${task.id}: tasks no longer ship a test file`);
    assert.ok(Object.keys(task.files).length > 0 && Object.keys(task.files).length <= CODING_EVAL_LIMITS.maxFiles);
    for (const [path, content] of Object.entries(task.files)) {
      assert.ok(resolveSandboxPath("/root", path), `${task.id}: ${path} is not a valid workspace path`);
      assert.ok(Buffer.byteLength(content) <= CODING_EVAL_LIMITS.maxFileBytes);
      assert.ok(!content.includes("node:test"), `${task.id}: a task file must not hold tests`);
    }
    assert.ok(task.examples.length >= 2 && task.examples.length < task.hidden.length, task.id);
    assert.ok(!task.prompt.includes("assert."), task.id);
    const hiddenKeys = new Set(task.hidden.map((entry) => canonicalJson(buildRunnerCases([entry])[0])));
    for (const entry of [...task.examples, ...task.hidden]) {
      const hasExpectation = "call" in entry ? "expect" in entry || entry.expectThrows !== undefined : true;
      assert.ok(hasExpectation, `${task.id}: a call case needs expect or expectThrows`);
      const data = { ...entry };
      delete data.check;
      assert.equal(canonicalJson(wire(data)), canonicalJson(data), `${task.id}: case data must survive JSON`);
    }
    for (const entry of task.examples) {
      assert.ok(hiddenKeys.has(canonicalJson(buildRunnerCases([entry])[0])), `${task.id}: every example is also graded`);
    }
  }
});

test("the child is never given an expected value", () => {
  for (const task of CODING_EVAL_TASKS) {
    const sent = JSON.stringify(buildRunnerCases(task.hidden));
    assert.ok(!/expect|check/.test(sent), `${task.id}: the runner input must carry calls and arguments only`);
  }
  const sample = buildRunnerCases([
    { call: "f", args: [1], expect: 2 },
    { construct: "C", args: [3], steps: [{ method: "m", args: [4], expect: 5 }, { get: "g", expect: 6 }] },
  ]);
  assert.deepEqual(sample, [
    { call: "f", args: [1] },
    { construct: "C", args: [3], steps: [{ method: "m", args: [4] }, { get: "g" }] },
  ]);
  assert.ok(!/expect|check|\bexpected\b/.test(CODING_EVAL_RUNNER_SOURCE), "the runner source knows no expectations");
});

test("each task fails its hidden cases from the starting files and passes with the reference solution", async () => {
  assert.deepEqual(Object.keys(SOLUTIONS).sort(), CODING_EVAL_TASKS.map((task) => task.id).sort());
  for (const task of CODING_EVAL_TASKS) {
    const started = Date.now();
    const before = await inWorkspace(task.files, (dir) => runSandboxedCases(dir, task.hidden));
    assert.equal(before.passed, false, `${task.id} must fail before any change`);
    assert.equal(before.problem, null, `${task.id}: the run itself must work, only the cases fail`);
    assert.ok(before.verdicts.some((verdict) => !verdict.passed), task.id);

    const solved = { ...task.files, ...SOLUTIONS[task.id] };
    const after = await inWorkspace(solved, (dir) => runSandboxedCases(dir, task.hidden));
    assert.equal(after.problem, null, task.id);
    assert.deepEqual(
      after.verdicts.filter((verdict) => !verdict.passed),
      [],
      `${task.id}: the reference solution must pass every hidden case`,
    );
    assert.equal(after.passed, true, task.id);

    const examples = await inWorkspace(solved, (dir) => runSandboxedCases(dir, task.examples));
    assert.equal(examples.passed, true, `${task.id}: the reference solution must pass the examples`);
    assert.ok(Date.now() - started < 15_000, `${task.id} is too slow`);
  }
});

test("each task's examples fail from the starting files, so run_tests has something to show", async () => {
  for (const task of CODING_EVAL_TASKS) {
    const result = await inWorkspace(task.files, (dir) => runSandboxedCases(dir, task.examples));
    assert.equal(result.passed, false, `${task.id}: at least one example must fail on the starting code`);
    assert.match(formatCodingEvalReport(task.examples, result), /expected: /, task.id);
  }
});

test("a half-fix does not pass: the hidden cases cover more than the first bug", async () => {
  const task = CODING_EVAL_TASKS.find((candidate) => candidate.id === "range-sum-and-tail");
  const halfFix = SOLUTIONS["range-sum-and-tail"]["src/index.mjs"].replace("n <= 0 ? [] : items.slice(-n)", "items.slice(-n)");
  const result = await inWorkspace({ "src/index.mjs": halfFix }, (dir) => runSandboxedCases(dir, task.hidden));
  assert.equal(result.passed, false);
});

test("a solution that mutates its input or returns a shared array is rejected", async () => {
  const task = CODING_EVAL_TASKS.find((candidate) => candidate.id === "merge-intervals");
  const mutating = SOLUTIONS["merge-intervals"]["src/index.mjs"].replace(
    "const sorted = intervals\n    .map(",
    "intervals.sort((a, b) => a[0] - b[0]);\n  const sorted = intervals\n    .map(",
  );
  assert.notEqual(mutating, SOLUTIONS["merge-intervals"]["src/index.mjs"]);
  const mutated = await inWorkspace({ "src/index.mjs": mutating }, (dir) => runSandboxedCases(dir, task.hidden));
  assert.equal(mutated.passed, false);
  assert.ok(mutated.verdicts.some((verdict) => /modified its arguments/.test(verdict.reason)));

  const lastNTask = CODING_EVAL_TASKS.find((candidate) => candidate.id === "range-sum-and-tail");
  const returnsInput = `
export function sumRange(start, end) { let t = 0; for (let i = start; i <= end; i++) t += i; return t; }
export function lastN(items, n) { return n <= 0 ? [] : n >= items.length ? items : items.slice(-n); }
`;
  const shared = await inWorkspace({ "src/index.mjs": returnsInput }, (dir) => runSandboxedCases(dir, lastNTask.hidden));
  assert.equal(shared.passed, false);
  assert.ok(shared.verdicts.some((verdict) => /shares an object/.test(verdict.reason)));
});

test("the judge compares only the parent's expectations: correct values pass, any deviation fails", () => {
  const task = CODING_EVAL_TASKS.find((candidate) => candidate.id === "range-sum-and-tail");
  const frameFor = (valueFor) => ({
    importError: null,
    results: task.hidden.map((entry, index) => ({
      ok: true,
      value: valueFor(entry, index),
      argsAfter: entry.args,
      aliased: false,
    })),
  });
  const correct = frameFor((entry) => entry.expect);
  assert.equal(judgeCodingEvalCases(task.hidden, correct).passed, true);
  const oneWrong = frameFor((entry, index) => (index === 4 ? "wrong" : entry.expect));
  const verdict = judgeCodingEvalCases(task.hidden, oneWrong);
  assert.equal(verdict.passed, false);
  assert.deepEqual(verdict.verdicts.map((entry) => entry.passed).filter((flag) => !flag).length, 1);
  assert.equal(judgeCodingEvalCases(task.hidden, frameFor(() => 0)).passed, false);

  for (const broken of [
    undefined,
    null,
    "pass",
    [],
    {},
    { importError: null },
    { importError: null, results: "ok" },
    { importError: null, results: correct.results.slice(1) },
    { importError: null, results: [...correct.results, correct.results[0]] },
    { importError: "SyntaxError: nope", results: correct.results },
    { importError: null, results: task.hidden.map(() => "pass") },
    { importError: null, results: task.hidden.map(() => null) },
    { importError: null, results: task.hidden.map((entry) => ({ ok: true, value: entry.expect })) },
    { importError: null, results: task.hidden.map((entry) => ({ ok: true, value: entry.expect, argsAfter: entry.args, aliased: true })) },
  ]) {
    assert.equal(judgeCodingEvalCases(task.hidden, broken).passed, false, JSON.stringify(broken));
  }
});

test("the judge handles constructor cases and exceptions", () => {
  const cases = [
    { construct: "C", args: [1], steps: [{ method: "m", args: [], expect: 7 }, { get: "g", expect: { $: "self" } }] },
    { construct: "C", args: [0], expectThrows: "RangeError" },
    { call: "f", args: [], expectThrows: "SyntaxError" },
  ];
  const good = [
    { ctor: { ok: true }, steps: [{ ok: true, value: 7 }, { ok: true, value: { $: "self" } }] },
    { ctor: { ok: false, error: "RangeError" }, steps: [] },
    { ok: false, error: "SyntaxError", props: {}, argsAfter: [], aliased: false },
  ];
  assert.equal(judgeCodingEvalCases(cases, { importError: null, results: good }).passed, true);
  const wrongType = structuredClone(good);
  wrongType[2].error = "RangeError";
  assert.equal(judgeCodingEvalCases(cases, { importError: null, results: wrongType }).passed, false);
  const noThrow = structuredClone(good);
  noThrow[1] = { ctor: { ok: true }, steps: [] };
  assert.equal(judgeCodingEvalCases(cases, { importError: null, results: noThrow }).passed, false);
  const shortSteps = structuredClone(good);
  shortSteps[0].steps.pop();
  assert.equal(judgeCodingEvalCases(cases, { importError: null, results: shortSteps }).passed, false);
});

test("parseRunnerOutput accepts one token-marked frame and nothing else", () => {
  const frame = (token, body = '{"importError":null,"results":[]}') => `${CODING_EVAL_FRAME_PREFIX} ${token} ${body}`;
  assert.deepEqual(parseRunnerOutput(`noise\n${frame("t1")}\n`, "t1"), { frame: { importError: null, results: [] } });
  assert.ok("problem" in parseRunnerOutput("", "t1"));
  assert.ok("problem" in parseRunnerOutput(`${frame("other")}\n`, "t1"), "a frame with another token is ignored");
  assert.ok("problem" in parseRunnerOutput(`# pass 1\n# fail 0\n`, "t1"), "TAP is not a frame");
  assert.match(parseRunnerOutput(`${frame("t1")}\n${frame("t1")}\n`, "t1").problem, /more than one/);
  assert.match(parseRunnerOutput(`${frame("t1", "{broken")}\n`, "t1").problem, /JSON/);
  assert.ok("problem" in parseRunnerOutput(`x ${frame("t1")}\n`, "t1"), "the frame must start its line");
});

test("summarizeCodingEval aggregates per model and ignores result order", () => {
  const row = (modelId, difficulty, passed, steps) => ({
    taskId: `${difficulty}-${steps}`,
    difficulty,
    modelId,
    passed,
    steps,
    durationMs: 10,
    inputTokens: 1,
    outputTokens: 1,
    failure: passed ? null : "tests_failed",
    usageUnknown: false,
  });
  const results = [
    row("beta", "easy", true, 2),
    row("alpha", "easy", true, 3),
    row("alpha", "hard", false, 10),
    row("beta", "medium", false, 6),
    row("alpha", "medium", true, 5),
    row("beta", "hard", true, 4),
  ];
  const expected = [
    {
      modelId: "alpha",
      tasks: 3,
      passed: 2,
      passRate: 2 / 3,
      byDifficulty: { easy: { tasks: 1, passed: 1 }, medium: { tasks: 1, passed: 1 }, hard: { tasks: 1, passed: 0 } },
      meanSteps: 6,
    },
    {
      modelId: "beta",
      tasks: 3,
      passed: 2,
      passRate: 2 / 3,
      byDifficulty: { easy: { tasks: 1, passed: 1 }, medium: { tasks: 1, passed: 0 }, hard: { tasks: 1, passed: 1 } },
      meanSteps: 4,
    },
  ];
  assert.deepEqual(summarizeCodingEval(results), expected);
  assert.deepEqual(summarizeCodingEval([...results].reverse()), expected);
  assert.deepEqual(summarizeCodingEval([results[3], results[0], results[5], results[1], results[4], results[2]]), expected);
  assert.deepEqual(summarizeCodingEval([]), []);
});

test("resolveSandboxPath accepts plain relative paths", () => {
  assert.equal(resolveSandboxPath("/work", "src/index.mjs"), "/work/src/index.mjs");
  assert.equal(resolveSandboxPath("/work/", "./src/index.mjs"), "/work/src/index.mjs");
  assert.equal(resolveSandboxPath("/work", "a-b_c.1/d.txt"), "/work/a-b_c.1/d.txt");
  assert.equal(resolveSandboxPath("C:\\work", "src/a.mjs"), "C:\\work\\src\\a.mjs");
});

test("resolveSandboxPath refuses everything that points outside the root or is not plain", () => {
  const refused = [
    "../secret",
    "src/../../secret",
    "src/..",
    "..",
    ".",
    "./",
    "",
    "/etc/passwd",
    "//server/share/x",
    "C:\\Windows\\win.ini",
    "C:/Windows/win.ini",
    "c:relative",
    "src\\index.mjs",
    "..\\secret",
    "src/index.mjs\0.txt",
    "\0",
    "src//index.mjs",
    "src/./index.mjs",
    "src/index.mjs/",
    "src/name with space.mjs",
    "src/na:me.mjs",
    "src/index.mjs.",
    "con",
    "src/NUL.txt",
    "src/com1",
    "src/lpt9.log",
    "a".repeat(CODING_EVAL_LIMITS.maxNameLength + 1),
    `${"a/".repeat(CODING_EVAL_LIMITS.maxDepth)}b.txt`,
    "a".repeat(CODING_EVAL_LIMITS.maxPathLength + 1),
    CODING_EVAL_RUNNER_FILE,
    `src/${CODING_EVAL_RUNNER_FILE}`,
  ];
  for (const candidate of refused) assert.equal(resolveSandboxPath("/work", candidate), null, JSON.stringify(candidate));
  for (const candidate of [undefined, null, 5, {}, ["a"]]) assert.equal(resolveSandboxPath("/work", candidate), null);
  assert.equal(resolveSandboxPath("", "a.txt"), null);
  assert.ok(resolveSandboxPath("/work", "a".repeat(CODING_EVAL_LIMITS.maxNameLength)));
});

test("checkSandboxWrite enforces file count, file size and total workspace size", () => {
  const write = (overrides) => ({ fileCount: 0, isNewFile: true, otherBytes: 0, content: "ok", ...overrides });
  assert.equal(checkSandboxWrite(write({})), null);
  assert.equal(checkSandboxWrite(write({ fileCount: CODING_EVAL_LIMITS.maxFiles - 1 })), null);
  assert.match(checkSandboxWrite(write({ fileCount: CODING_EVAL_LIMITS.maxFiles })), /files/);
  assert.equal(checkSandboxWrite(write({ fileCount: CODING_EVAL_LIMITS.maxFiles, isNewFile: false })), null, "overwriting is not a new file");
  assert.equal(checkSandboxWrite(write({ content: "x".repeat(CODING_EVAL_LIMITS.maxFileBytes) })), null);
  assert.match(checkSandboxWrite(write({ content: "x".repeat(CODING_EVAL_LIMITS.maxFileBytes + 1) })), /larger/);
  assert.match(checkSandboxWrite(write({ content: "\u00e9".repeat(CODING_EVAL_LIMITS.maxFileBytes / 2 + 1) })), /larger/, "bytes, not characters");
  assert.match(checkSandboxWrite(write({ content: "a\0b" })), /text/);
  assert.match(checkSandboxWrite(write({ content: 42 })), /string/);
  const room = CODING_EVAL_LIMITS.maxWorkspaceBytes;
  assert.equal(checkSandboxWrite(write({ otherBytes: room - 2 })), null);
  assert.match(checkSandboxWrite(write({ otherBytes: room - 1 })), /in total/);
  assert.ok(CODING_EVAL_LIMITS.maxWorkspaceBytes <= 256 * 1024);
});

test("keepTail keeps the end of long output", () => {
  assert.equal(keepTail("short", 100), "short");
  const long = `${"x".repeat(5000)}THE-END`;
  const kept = keepTail(long, 200);
  assert.ok(kept.length <= 200);
  assert.ok(kept.endsWith("THE-END"));
  assert.ok(kept.startsWith("[...output truncated...]"));
});

test("codingEvalWorstCaseTokens follows its stated basis", () => {
  const bytes = (text) => Buffer.byteLength(text);
  const limits = { maxSteps: 3, maxOutputTokensPerStep: 100, maxWorkspaceBytes: 1000, maxToolOutputBytes: 500 };
  const longestPrompt = Math.max(...CODING_EVAL_TASKS.map((task) => bytes(task.prompt)));
  const base = bytes(codingEvalSystemPrompt(3)) + 4096 + longestPrompt + 1000 + 500;
  assert.deepEqual(codingEvalWorstCaseTokens(limits), {
    // step 0: base, step 1: base + 200, step 2: base + 400
    inputTokens: 3 * base + 200 * (0 + 1 + 2),
    outputTokens: 300,
  });

  const defaults = codingEvalWorstCaseTokens();
  const defaultBase =
    bytes(codingEvalSystemPrompt(CODING_EVAL_LIMITS.maxSteps)) + 4096 + longestPrompt + 256 * 1024 + 256 * 1024;
  assert.equal(defaults.inputTokens, 10 * defaultBase + 2 * 8192 * 45);
  assert.equal(defaults.outputTokens, 10 * 8192);
  assert.ok(codingEvalWorstCaseTokens({ ...limits, maxSteps: 4 }).inputTokens > codingEvalWorstCaseTokens(limits).inputTokens);
});
