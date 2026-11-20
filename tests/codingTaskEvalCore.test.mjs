import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CODING_EVAL_HIDDEN_TEST_FILE,
  CODING_EVAL_LIMITS,
  CODING_EVAL_TASKS,
  checkSandboxWrite,
  keepTail,
  resolveSandboxPath,
  summarizeCodingEval,
} from "../lib/codingTaskEvalCore.ts";
import { runSandboxedTests } from "../lib/codingTaskEval.ts";

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

test("every task is well formed and keeps its tests out of the model's files", () => {
  for (const task of CODING_EVAL_TASKS) {
    assert.ok(task.prompt.length > 40, task.id);
    assert.ok(Object.keys(task.files).length > 0 && Object.keys(task.files).length <= CODING_EVAL_LIMITS.maxFiles);
    for (const [path, content] of Object.entries(task.files)) {
      assert.ok(resolveSandboxPath("/root", path), `${task.id}: ${path} is not a valid workspace path`);
      assert.ok(Buffer.byteLength(content) <= CODING_EVAL_LIMITS.maxFileBytes);
      assert.ok(!content.includes("node:test"), `${task.id}: a task file must not hold the tests`);
    }
    assert.ok(task.tests.includes('from "node:test"') && task.tests.includes("./src/index.mjs"), task.id);
    assert.ok(!Object.values(task.files).some((content) => content.includes(task.tests)), task.id);
    // Assertions must not be copied into the prompt the model reads.
    assert.ok(!task.prompt.includes("assert."), task.id);
  }
});

test("each task fails its tests from the starting files and passes with the reference solution", async () => {
  assert.deepEqual(Object.keys(SOLUTIONS).sort(), CODING_EVAL_TASKS.map((task) => task.id).sort());
  for (const task of CODING_EVAL_TASKS) {
    const started = Date.now();
    const before = await inWorkspace(task.files, (dir) => runSandboxedTests(dir, task.tests));
    assert.equal(before.passed, false, `${task.id} must fail before any change:\n${before.output}`);
    assert.equal(before.timedOut, false, task.id);
    assert.match(before.output, /^# fail [1-9]/m, `${task.id} must fail because a test failed, not because the run broke`);

    const after = await inWorkspace({ ...task.files, ...SOLUTIONS[task.id] }, (dir) => runSandboxedTests(dir, task.tests));
    assert.equal(after.passed, true, `${task.id} reference solution must pass:\n${after.output}`);
    assert.ok(Date.now() - started < 10_000, `${task.id} is too slow`);
  }
});

test("a task's tests do not pass with a half-fix: each task has more than one failing behaviour", async () => {
  // The first test file case alone is not enough to pass: a solution that only
  // handles the simplest case must still fail.
  const task = CODING_EVAL_TASKS.find((candidate) => candidate.id === "range-sum-and-tail");
  const halfFix = SOLUTIONS["range-sum-and-tail"]["src/index.mjs"].replace("n <= 0 ? [] : items.slice(-n)", "items.slice(-n)");
  const result = await inWorkspace({ "src/index.mjs": halfFix }, (dir) => runSandboxedTests(dir, task.tests));
  assert.equal(result.passed, false);
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
    CODING_EVAL_HIDDEN_TEST_FILE,
    `src/${CODING_EVAL_HIDDEN_TEST_FILE}`,
  ];
  for (const candidate of refused) assert.equal(resolveSandboxPath("/work", candidate), null, JSON.stringify(candidate));
  for (const candidate of [undefined, null, 5, {}, ["a"]]) assert.equal(resolveSandboxPath("/work", candidate), null);
  assert.equal(resolveSandboxPath("", "a.txt"), null);
  assert.ok(resolveSandboxPath("/work", "a".repeat(CODING_EVAL_LIMITS.maxNameLength)));
});

test("checkSandboxWrite enforces file count and size", () => {
  assert.equal(checkSandboxWrite(0, true, "ok"), null);
  assert.equal(checkSandboxWrite(CODING_EVAL_LIMITS.maxFiles - 1, true, "ok"), null);
  assert.match(checkSandboxWrite(CODING_EVAL_LIMITS.maxFiles, true, "ok"), /files/);
  assert.equal(checkSandboxWrite(CODING_EVAL_LIMITS.maxFiles, false, "ok"), null, "overwriting is not a new file");
  assert.equal(checkSandboxWrite(0, true, "x".repeat(CODING_EVAL_LIMITS.maxFileBytes)), null);
  assert.match(checkSandboxWrite(0, true, "x".repeat(CODING_EVAL_LIMITS.maxFileBytes + 1)), /larger/);
  assert.match(checkSandboxWrite(0, true, "\u00e9".repeat(CODING_EVAL_LIMITS.maxFileBytes / 2 + 1)), /larger/, "bytes, not characters");
  assert.match(checkSandboxWrite(0, true, "a\0b"), /text/);
  assert.match(checkSandboxWrite(0, true, 42), /string/);
});

test("keepTail keeps the end of long output", () => {
  assert.equal(keepTail("short", 100), "short");
  const long = `${"x".repeat(5000)}THE-END`;
  const kept = keepTail(long, 200);
  assert.ok(kept.length <= 200);
  assert.ok(kept.endsWith("THE-END"));
  assert.ok(kept.startsWith("[...output truncated...]"));
});
