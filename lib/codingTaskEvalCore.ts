/**
 * Pure pieces of the coding-task evaluation harness: the fixed task set, the
 * result shape, the per-model summary and the workspace path guard.
 *
 * No server-only import and no SDK import, so a test (or a report page) can use
 * it anywhere. The module that runs a model against a task is
 * lib/codingTaskEval.ts.
 *
 * Every task is a tiny Node-built-ins-only ES module project. `files` is what
 * the model starts with; `tests` is a hidden `node:test` file the model never
 * sees. The tests import `./src/index.mjs` and must finish well under a second.
 */

export type CodingEvalDifficulty = "easy" | "medium" | "hard";

export type CodingEvalTask = {
  id: string;
  difficulty: CodingEvalDifficulty;
  /** What the model is asked to do. Describes behaviour, never the test file. */
  prompt: string;
  /** Starting workspace: relative path -> file content. */
  files: Record<string, string>;
  /** Hidden `node:test` file, written next to `src/` only while tests run. */
  tests: string;
};

export type CodingEvalFailure = null | "tests_failed" | "no_change" | "step_limit" | "timeout" | "error";

export type CodingEvalResult = {
  taskId: string;
  difficulty: CodingEvalDifficulty;
  modelId: string;
  passed: boolean;
  /** Model calls (agent steps) used, including the one that ended the run. */
  steps: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  failure: CodingEvalFailure;
};

export type CodingEvalLimits = {
  /** Agent step cap (one step = one model call plus its tool executions). */
  maxSteps: number;
  /** Wall clock for one sandboxed `node` test run. */
  testTimeoutMs: number;
  /** Characters of test output kept; the tail is kept because failures print last. */
  testOutputMaxChars: number;
  /** Wall clock for a whole task: model calls, tools and the final judging run. */
  taskTimeoutMs: number;
  /** How many times the model may call run_tests in one task. */
  maxTestRunsPerTask: number;
  maxFiles: number;
  maxFileBytes: number;
  maxPathLength: number;
  maxNameLength: number;
  maxDepth: number;
  maxOutputTokensPerStep: number;
};

export const CODING_EVAL_LIMITS: Readonly<CodingEvalLimits> = Object.freeze({
  maxSteps: 10,
  testTimeoutMs: 15_000,
  testOutputMaxChars: 4_000,
  taskTimeoutMs: 180_000,
  maxTestRunsPerTask: 8,
  maxFiles: 20,
  maxFileBytes: 64 * 1024,
  maxPathLength: 120,
  maxNameLength: 64,
  maxDepth: 5,
  maxOutputTokensPerStep: 8_192,
});

/** The hidden test file's name. It exists in the workspace only during a test run. */
export const CODING_EVAL_HIDDEN_TEST_FILE = "zz_hidden_acceptance.test.mjs";

const DIFFICULTIES: readonly CodingEvalDifficulty[] = ["easy", "medium", "hard"];

export const CODING_EVAL_TASKS: readonly CodingEvalTask[] = [
  {
    id: "range-sum-and-tail",
    difficulty: "easy",
    prompt: [
      "src/index.mjs exports two helpers and both have bugs. Fix them.",
      "",
      "sumRange(start, end): the sum of every integer from start to end, both inclusive.",
      "It returns 0 when start is greater than end.",
      "",
      "lastN(items, n): a new array holding the last n items of the array `items`.",
      "n = 0 (or negative) gives an empty array; an n larger than the length gives a full copy.",
      "The input array must not be modified.",
    ].join("\n"),
    files: {
      "src/index.mjs": [
        "// Sum of all integers from start to end, both inclusive.",
        "export function sumRange(start, end) {",
        "  let total = 0;",
        "  for (let i = start; i < end; i++) total += i;",
        "  return total;",
        "}",
        "",
        "// The last n items of an array, as a new array.",
        "export function lastN(items, n) {",
        "  return items.slice(-n);",
        "}",
        "",
      ].join("\n"),
    },
    tests: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { sumRange, lastN } from "./src/index.mjs";',
      "",
      'test("sumRange is inclusive on both ends", () => {',
      "  assert.equal(sumRange(1, 5), 15);",
      "  assert.equal(sumRange(3, 3), 3);",
      "  assert.equal(sumRange(-2, 2), 0);",
      "});",
      "",
      'test("sumRange of a reversed range is 0", () => {',
      "  assert.equal(sumRange(5, 1), 0);",
      "});",
      "",
      'test("lastN returns the tail", () => {',
      "  assert.deepEqual(lastN([1, 2, 3, 4], 2), [3, 4]);",
      "  assert.deepEqual(lastN([1, 2, 3, 4], 4), [1, 2, 3, 4]);",
      "});",
      "",
      'test("lastN with zero or negative n is empty", () => {',
      "  assert.deepEqual(lastN([1, 2, 3], 0), []);",
      "  assert.deepEqual(lastN([1, 2, 3], -1), []);",
      "});",
      "",
      'test("lastN with n larger than the array returns a copy", () => {',
      "  const items = [1, 2, 3];",
      "  const result = lastN(items, 10);",
      "  assert.deepEqual(result, [1, 2, 3]);",
      "  assert.notEqual(result, items);",
      "  assert.deepEqual(items, [1, 2, 3]);",
      "});",
      "",
    ].join("\n"),
  },
  {
    id: "query-string-parser",
    difficulty: "easy",
    prompt: [
      "src/index.mjs exports parseQuery(input), which should parse a URL query string into a plain object.",
      "The current version is wrong in several ways. Make it follow these rules:",
      "- A leading \"?\" is ignored.",
      "- Pairs are separated by \"&\"; empty pairs are skipped; an empty input gives {}.",
      "- The key is the text before the first \"=\"; the value is everything after it, including further \"=\" characters.",
      "- A pair without \"=\" has the value \"\".",
      "- Keys and values are percent-decoded, and \"+\" means a space.",
      "- A key that appears more than once collects its values, in order, in an array.",
    ].join("\n"),
    files: {
      "src/index.mjs": [
        "// Parses a URL query string into a plain object.",
        "export function parseQuery(input) {",
        "  const result = {};",
        '  for (const pair of input.split("&")) {',
        '    const [key, value] = pair.split("=");',
        "    result[key] = value;",
        "  }",
        "  return result;",
        "}",
        "",
      ].join("\n"),
    },
    tests: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { parseQuery } from "./src/index.mjs";',
      "",
      'test("parses plain pairs and ignores a leading question mark", () => {',
      '  assert.deepEqual(parseQuery("a=1&b=2"), { a: "1", b: "2" });',
      '  assert.deepEqual(parseQuery("?x=1"), { x: "1" });',
      "});",
      "",
      'test("empty input and empty pairs", () => {',
      "  assert.deepEqual(parseQuery(\"\"), {});",
      "  assert.deepEqual(parseQuery(\"?\"), {});",
      '  assert.deepEqual(parseQuery("&&a=1&"), { a: "1" });',
      "});",
      "",
      'test("the value keeps everything after the first equals sign", () => {',
      '  assert.deepEqual(parseQuery("token=abc=def=="), { token: "abc=def==" });',
      "});",
      "",
      'test("a key without a value is an empty string", () => {',
      '  assert.deepEqual(parseQuery("flag&x=1"), { flag: "", x: "1" });',
      '  assert.deepEqual(parseQuery("empty="), { empty: "" });',
      "});",
      "",
      'test("percent decoding and plus as space", () => {',
      '  assert.deepEqual(parseQuery("name=John+Doe&city=S%C3%A3o%20Paulo"), { name: "John Doe", city: "S\\u00e3o Paulo" });',
      '  assert.deepEqual(parseQuery("q=100%25"), { q: "100%" });',
      '  assert.deepEqual(parseQuery("a%20b=c%26d"), { "a b": "c&d" });',
      "});",
      "",
      'test("repeated keys collect values in order", () => {',
      '  assert.deepEqual(parseQuery("a=1&a=2&b=x&a=3"), { a: ["1", "2", "3"], b: "x" });',
      "});",
      "",
    ].join("\n"),
  },
  {
    id: "lru-cache",
    difficulty: "medium",
    prompt: [
      "Implement the LRUCache class in src/index.mjs (the file has a skeleton).",
      "",
      "- new LRUCache(capacity): capacity must be a positive integer, otherwise throw a RangeError.",
      "- get(key): the stored value, or undefined when the key is absent. A hit makes the key the most recently used.",
      "- set(key, value): stores or replaces the value and makes the key the most recently used.",
      "  When the cache then holds more than `capacity` entries, the least recently used entry is removed.",
      "  It returns the cache itself so calls can be chained.",
      "- has(key): whether the key is present. It does NOT change the recency order.",
      "- size: a getter with the current number of entries.",
      "- keys(): an array of the keys ordered from least recently used to most recently used.",
    ].join("\n"),
    files: {
      "src/index.mjs": [
        "// Least-recently-used cache. Fill in the methods.",
        "export class LRUCache {",
        "  constructor(capacity) {",
        "    this.capacity = capacity;",
        "  }",
        "",
        "  get(key) {",
        "    return undefined;",
        "  }",
        "",
        "  set(key, value) {",
        "    return this;",
        "  }",
        "",
        "  has(key) {",
        "    return false;",
        "  }",
        "",
        "  get size() {",
        "    return 0;",
        "  }",
        "",
        "  keys() {",
        "    return [];",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    tests: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { LRUCache } from "./src/index.mjs";',
      "",
      'test("stores and returns values", () => {',
      "  const cache = new LRUCache(2);",
      '  cache.set("a", 1);',
      '  cache.set("b", 2);',
      '  assert.equal(cache.get("a"), 1);',
      '  assert.equal(cache.get("b"), 2);',
      '  assert.equal(cache.get("missing"), undefined);',
      "  assert.equal(cache.size, 2);",
      "});",
      "",
      'test("evicts the least recently used entry", () => {',
      "  const cache = new LRUCache(2);",
      '  cache.set("a", 1).set("b", 2).set("c", 3);',
      '  assert.equal(cache.has("a"), false);',
      '  assert.deepEqual(cache.keys(), ["b", "c"]);',
      "  assert.equal(cache.size, 2);",
      "});",
      "",
      'test("get refreshes recency", () => {',
      "  const cache = new LRUCache(2);",
      '  cache.set("a", 1);',
      '  cache.set("b", 2);',
      '  cache.get("a");',
      '  cache.set("c", 3);',
      '  assert.equal(cache.has("b"), false);',
      '  assert.deepEqual(cache.keys(), ["a", "c"]);',
      "});",
      "",
      'test("set on an existing key replaces the value and refreshes recency without growing", () => {',
      "  const cache = new LRUCache(2);",
      '  cache.set("a", 1);',
      '  cache.set("b", 2);',
      '  cache.set("a", 10);',
      "  assert.equal(cache.size, 2);",
      '  assert.deepEqual(cache.keys(), ["b", "a"]);',
      '  cache.set("c", 3);',
      '  assert.equal(cache.has("b"), false);',
      '  assert.equal(cache.get("a"), 10);',
      "});",
      "",
      'test("has does not change recency", () => {',
      "  const cache = new LRUCache(2);",
      '  cache.set("a", 1);',
      '  cache.set("b", 2);',
      '  assert.equal(cache.has("a"), true);',
      '  cache.set("c", 3);',
      '  assert.equal(cache.has("a"), false);',
      "});",
      "",
      'test("a stored undefined value is still a present key", () => {',
      "  const cache = new LRUCache(1);",
      '  cache.set("a", undefined);',
      '  assert.equal(cache.has("a"), true);',
      "  assert.equal(cache.size, 1);",
      "});",
      "",
      'test("capacity must be a positive integer", () => {',
      "  assert.throws(() => new LRUCache(0), RangeError);",
      "  assert.throws(() => new LRUCache(-1), RangeError);",
      "  assert.throws(() => new LRUCache(1.5), RangeError);",
      "  assert.throws(() => new LRUCache(Number.NaN), RangeError);",
      "});",
      "",
    ].join("\n"),
  },
  {
    id: "merge-intervals",
    difficulty: "medium",
    prompt: [
      "src/index.mjs exports mergeIntervals(intervals). It takes an array of closed [start, end] number pairs",
      "and returns the minimal sorted list of intervals that covers exactly the same points. It has bugs.",
      "",
      "- Input may be unsorted.",
      "- Overlapping intervals merge, and so do intervals that touch at one point: [1, 3] and [3, 5] become [1, 5].",
      "  [1, 2] and [3, 4] do not touch, so they stay separate.",
      "- An interval fully inside another disappears into it.",
      "- An interval whose start is greater than its end throws a RangeError.",
      "- The input array and the pairs inside it must not be modified, and the result must be made of new arrays.",
      "- An empty input gives [].",
    ].join("\n"),
    files: {
      "src/index.mjs": [
        "// Merges closed intervals [start, end] into the minimal sorted list.",
        "export function mergeIntervals(intervals) {",
        "  intervals.sort((a, b) => a[0] - b[0]);",
        "  const merged = [];",
        "  for (const [start, end] of intervals) {",
        "    const last = merged[merged.length - 1];",
        "    if (last && start < last[1]) {",
        "      last[1] = end;",
        "    } else {",
        "      merged.push([start, end]);",
        "    }",
        "  }",
        "  return merged;",
        "}",
        "",
      ].join("\n"),
    },
    tests: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { mergeIntervals } from "./src/index.mjs";',
      "",
      'test("merges overlapping intervals out of order", () => {',
      "  assert.deepEqual(mergeIntervals([[8, 10], [1, 3], [2, 6], [15, 18]]), [[1, 6], [8, 10], [15, 18]]);",
      "});",
      "",
      'test("intervals touching at a point merge, separate ones do not", () => {',
      "  assert.deepEqual(mergeIntervals([[1, 3], [3, 5]]), [[1, 5]]);",
      "  assert.deepEqual(mergeIntervals([[1, 2], [3, 4]]), [[1, 2], [3, 4]]);",
      "});",
      "",
      'test("a contained interval does not shrink the outer one", () => {',
      "  assert.deepEqual(mergeIntervals([[1, 10], [2, 3], [4, 5]]), [[1, 10]]);",
      "  assert.deepEqual(mergeIntervals([[1, 4], [2, 3]]), [[1, 4]]);",
      "});",
      "",
      'test("negative numbers, duplicates and single points", () => {',
      "  assert.deepEqual(mergeIntervals([[-5, -1], [-3, 0], [7, 7], [7, 7]]), [[-5, 0], [7, 7]]);",
      "});",
      "",
      'test("empty input", () => {',
      "  assert.deepEqual(mergeIntervals([]), []);",
      "});",
      "",
      'test("an inverted interval is a RangeError", () => {',
      "  assert.throws(() => mergeIntervals([[1, 2], [5, 3]]), RangeError);",
      "});",
      "",
      'test("input is not mutated and the result shares no arrays with it", () => {',
      "  const input = [[8, 10], [1, 3], [2, 6]];",
      "  const before = JSON.stringify(input);",
      "  const result = mergeIntervals(input);",
      "  assert.equal(JSON.stringify(input), before);",
      "  for (const pair of result) for (const original of input) assert.notEqual(pair, original);",
      "  result[0][0] = 99;",
      "  assert.equal(JSON.stringify(input), before);",
      "});",
      "",
    ].join("\n"),
  },
  {
    id: "expression-parser",
    difficulty: "hard",
    prompt: [
      "Implement evaluate(source) in src/index.mjs: it evaluates an arithmetic expression string and returns a number.",
      "The current file only handles space-separated, left-to-right input. Do not use eval, Function or any other",
      "way of running the text as JavaScript; write a real tokenizer and parser.",
      "",
      "- Numbers: digits with an optional fractional part (\"3\", \"2.5\", \".5\").",
      "- Binary operators + - * / ^ with the usual precedence: ^ binds tightest, then * and /, then + and -.",
      "  + - * / are left associative; ^ is right associative, so 2^3^2 is 512.",
      "- Unary minus and plus are allowed (\"-3\", \"--3\", \"2*-3\"). Unary minus binds looser than ^ on its left,",
      "  so -2^2 is -4, but the exponent itself may be negative: 2^-2 is 0.25.",
      "- Parentheses group; whitespace is ignored anywhere between tokens.",
      "- Invalid input throws a SyntaxError: empty or blank input, an unknown character, a missing or extra",
      "  parenthesis, a missing operand (\"1+\"), or two numbers in a row (\"1 2\").",
      "- Dividing by zero throws a RangeError.",
    ].join("\n"),
    files: {
      "src/index.mjs": [
        "// Evaluates an arithmetic expression. Current version: space-separated, left to right only.",
        "export function evaluate(source) {",
        '  const parts = source.trim().split(/\\s+/);',
        "  let total = Number(parts[0]);",
        "  for (let i = 1; i < parts.length; i += 2) {",
        "    const operand = Number(parts[i + 1]);",
        '    if (parts[i] === "+") total += operand;',
        '    else if (parts[i] === "-") total -= operand;',
        '    else if (parts[i] === "*") total *= operand;',
        '    else if (parts[i] === "/") total /= operand;',
        "  }",
        "  return total;",
        "}",
        "",
      ].join("\n"),
    },
    tests: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { evaluate } from "./src/index.mjs";',
      "",
      'test("numbers and whitespace", () => {',
      '  assert.equal(evaluate("42"), 42);',
      '  assert.equal(evaluate("  2.5 "), 2.5);',
      '  assert.equal(evaluate(".5 + .25"), 0.75);',
      '  assert.equal(evaluate("1+2"), 3);',
      "});",
      "",
      'test("precedence", () => {',
      '  assert.equal(evaluate("2 + 3 * 4"), 14);',
      '  assert.equal(evaluate("2 * 3 + 4"), 10);',
      '  assert.equal(evaluate("2 * 3 ^ 2"), 18);',
      "});",
      "",
      'test("left associativity of the other operators", () => {',
      '  assert.equal(evaluate("1 - 2 - 3"), -4);',
      '  assert.equal(evaluate("8 / 2 / 2"), 2);',
      '  assert.equal(evaluate("10 / 4"), 2.5);',
      "});",
      "",
      'test("exponent is right associative", () => {',
      '  assert.equal(evaluate("2^3^2"), 512);',
      '  assert.equal(evaluate("2^10"), 1024);',
      "});",
      "",
      'test("unary operators", () => {',
      '  assert.equal(evaluate("-3"), -3);',
      '  assert.equal(evaluate("--3"), 3);',
      '  assert.equal(evaluate("2*-3"), -6);',
      '  assert.equal(evaluate("-2^2"), -4);',
      '  assert.equal(evaluate("2^-2"), 0.25);',
      '  assert.equal(evaluate("+4 - -1"), 5);',
      "});",
      "",
      'test("parentheses", () => {',
      '  assert.equal(evaluate("(2 + 3) * 4"), 20);',
      '  assert.equal(evaluate("((1))"), 1);',
      '  assert.equal(evaluate("2 * (3 + (4 - 1)) ^ 2"), 72);',
      '  assert.equal(evaluate("-(1 + 2)"), -3);',
      "});",
      "",
      'test("malformed input is a SyntaxError", () => {',
      '  for (const bad of ["", "   ", "2 $ 3", "abc", "(1 + 2", "1 + 2)", "()", "1 +", "* 3", "1 2", "1.2.3", "2 ** 3"]) {',
      "    assert.throws(() => evaluate(bad), SyntaxError, JSON.stringify(bad));",
      "  }",
      "});",
      "",
      'test("division by zero is a RangeError", () => {',
      '  assert.throws(() => evaluate("1 / 0"), RangeError);',
      '  assert.throws(() => evaluate("4 / (2 - 2)"), RangeError);',
      "});",
      "",
    ].join("\n"),
  },
  {
    id: "dependency-order",
    difficulty: "hard",
    prompt: [
      "Implement topoSort(graph) in src/index.mjs and make CycleError report a real cycle. The file has a skeleton.",
      "",
      "`graph` is a plain object that maps a node name to the array of node names it depends on,",
      "for example { app: [\"lib\", \"util\"], lib: [\"util\"], util: [] }.",
      "",
      "- Return an array with every node, a dependency always before the nodes that depend on it.",
      "  A node that only appears inside a dependency list is a node too.",
      "- The order must be deterministic: whenever several nodes are ready, take the one that sorts first by",
      "  plain string comparison (the < operator).",
      "- Duplicate entries in a dependency list are harmless.",
      "- If the dependencies contain a cycle (a self-dependency counts), throw a CycleError instead.",
      "  Its `cycle` property is an array of node names that starts and ends with the same node, where each",
      "  name depends on the next one: [\"a\", \"b\", \"a\"] means a depends on b and b depends on a.",
      "  A self-dependency gives [\"a\", \"a\"]. Only nodes that really are on a cycle may appear in it.",
      "- Do not modify the input object.",
    ].join("\n"),
    files: {
      "src/index.mjs": [
        "// Thrown by topoSort when the dependency graph has a cycle.",
        "export class CycleError extends Error {",
        "  constructor(cycle) {",
        '    super("dependency cycle");',
        "    this.cycle = cycle;",
        "  }",
        "}",
        "",
        "// Orders the nodes of a dependency graph, dependencies first.",
        "export function topoSort(graph) {",
        "  return Object.keys(graph);",
        "}",
        "",
      ].join("\n"),
    },
    tests: [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { topoSort, CycleError } from "./src/index.mjs";',
      "",
      "// Each name in `cycle` must depend on the next, and the list must close on its first node.",
      "const assertRealCycle = (graph, cycle) => {",
      "  assert.ok(Array.isArray(cycle) && cycle.length >= 2, \"cycle must list at least two entries\");",
      "  assert.equal(cycle[0], cycle[cycle.length - 1]);",
      "  for (let i = 0; i + 1 < cycle.length; i++) {",
      "    assert.ok((graph[cycle[i]] || []).includes(cycle[i + 1]), `${cycle[i]} does not depend on ${cycle[i + 1]}`);",
      "  }",
      "};",
      "",
      'test("dependencies come first", () => {',
      '  assert.deepEqual(topoSort({ app: ["lib", "util"], lib: ["util"], util: [] }), ["util", "lib", "app"]);',
      "});",
      "",
      'test("ties are broken by string order", () => {',
      '  assert.deepEqual(topoSort({ b: [], a: [], c: ["a", "b"] }), ["a", "b", "c"]);',
      '  assert.deepEqual(topoSort({ z: [], y: ["z"], a: ["z"], m: [] }), ["m", "z", "a", "y"]);',
      "});",
      "",
      'test("a node that only appears as a dependency is included", () => {',
      '  assert.deepEqual(topoSort({ a: ["z"] }), ["z", "a"]);',
      "});",
      "",
      'test("empty graph and duplicate dependencies", () => {',
      "  assert.deepEqual(topoSort({}), []);",
      '  assert.deepEqual(topoSort({ a: ["b", "b"], b: [] }), ["b", "a"]);',
      "});",
      "",
      'test("the input graph is not modified", () => {',
      '  const graph = { a: ["b"], b: ["c"] };',
      "  const before = JSON.stringify(graph);",
      "  topoSort(graph);",
      "  assert.equal(JSON.stringify(graph), before);",
      "});",
      "",
      'test("a cycle throws CycleError with a real cycle", () => {',
      '  const graph = { a: ["b"], b: ["c"], c: ["a"] };',
      "  assert.throws(() => topoSort(graph), (error) => {",
      "    assert.ok(error instanceof CycleError);",
      "    assertRealCycle(graph, error.cycle);",
      "    return true;",
      "  });",
      "});",
      "",
      'test("a self-dependency is a cycle", () => {',
      '  const graph = { a: ["a"] };',
      "  assert.throws(() => topoSort(graph), (error) => {",
      "    assert.ok(error instanceof CycleError);",
      '    assert.deepEqual(error.cycle, ["a", "a"]);',
      "    return true;",
      "  });",
      "});",
      "",
      'test("only nodes on the cycle are reported, not the ones that lead to it", () => {',
      '  const graph = { x: ["a"], a: ["b"], b: ["a"], y: [] };',
      "  assert.throws(() => topoSort(graph), (error) => {",
      "    assert.ok(error instanceof CycleError);",
      "    assertRealCycle(graph, error.cycle);",
      '    assert.ok(!error.cycle.includes("x") && !error.cycle.includes("y"));',
      "    return true;",
      "  });",
      "});",
      "",
    ].join("\n"),
  },
];

export function getCodingEvalTask(id: string): CodingEvalTask | undefined {
  return CODING_EVAL_TASKS.find((task) => task.id === id);
}

export type CodingEvalDifficultyCount = { tasks: number; passed: number };

export type CodingEvalModelSummary = {
  modelId: string;
  tasks: number;
  passed: number;
  /** passed / tasks, 0 when the model has no results. */
  passRate: number;
  byDifficulty: Record<CodingEvalDifficulty, CodingEvalDifficultyCount>;
  meanSteps: number;
};

/**
 * One row per model, ordered by model id. The output depends only on the
 * multiset of results, never on their order.
 */
export function summarizeCodingEval(results: readonly CodingEvalResult[]): CodingEvalModelSummary[] {
  const byModel = new Map<string, CodingEvalModelSummary & { stepTotal: number }>();
  for (const result of results) {
    let row = byModel.get(result.modelId);
    if (!row) {
      row = {
        modelId: result.modelId,
        tasks: 0,
        passed: 0,
        passRate: 0,
        byDifficulty: Object.fromEntries(DIFFICULTIES.map((d) => [d, { tasks: 0, passed: 0 }])) as Record<
          CodingEvalDifficulty,
          CodingEvalDifficultyCount
        >,
        meanSteps: 0,
        stepTotal: 0,
      };
      byModel.set(result.modelId, row);
    }
    row.tasks += 1;
    row.stepTotal += result.steps;
    row.byDifficulty[result.difficulty].tasks += 1;
    if (result.passed) {
      row.passed += 1;
      row.byDifficulty[result.difficulty].passed += 1;
    }
  }
  return [...byModel.values()]
    .sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0))
    .map(({ stepTotal, ...row }) => ({
      ...row,
      passRate: row.tasks === 0 ? 0 : row.passed / row.tasks,
      meanSteps: row.tasks === 0 ? 0 : stepTotal / row.tasks,
    }));
}

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Resolves a model-supplied relative path to a file path under `root`, or null
 * when it is not a plain, short, forward-slash relative path.
 *
 * Refused: non-strings, empty text, NUL, backslashes, absolute paths, drive
 * letters (`C:x` included), any `.` / `..` / empty segment (a leading `./` is
 * tolerated), characters outside letters, digits and `._-`, Windows device
 * names, trailing dots, names or paths over the limits, and the hidden test
 * file's name. It is lexical on purpose: the workspace holds only files this
 * harness wrote, and the model cannot create links.
 */
export function resolveSandboxPath(
  root: string,
  relative: unknown,
  limits: Pick<CodingEvalLimits, "maxPathLength" | "maxNameLength" | "maxDepth"> = CODING_EVAL_LIMITS,
): string | null {
  if (typeof root !== "string" || root === "" || typeof relative !== "string") return null;
  let text = relative;
  while (text.startsWith("./")) text = text.slice(2);
  if (text === "" || text.length > limits.maxPathLength) return null;
  if (text.includes("\0") || text.includes("\\") || text.startsWith("/") || /^[A-Za-z]:/.test(text)) return null;
  const segments = text.split("/");
  if (segments.length > limits.maxDepth) return null;
  for (const segment of segments) {
    if (segment === "" || segment.length > limits.maxNameLength) return null;
    if (!SEGMENT_PATTERN.test(segment) || /^\.+$/.test(segment) || segment.endsWith(".")) return null;
    if (WINDOWS_DEVICE_NAME.test(segment)) return null;
  }
  if (segments[segments.length - 1] === CODING_EVAL_HIDDEN_TEST_FILE) return null;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root;
  return `${base}${separator}${segments.join(separator)}`;
}

/** Why a write would break the workspace limits, or null when it is fine. */
export function checkSandboxWrite(
  existingFileCount: number,
  isNewFile: boolean,
  content: unknown,
  limits: Pick<CodingEvalLimits, "maxFiles" | "maxFileBytes"> = CODING_EVAL_LIMITS,
): string | null {
  if (typeof content !== "string") return "content must be a string";
  if (content.includes("\0")) return "content must be text";
  if (new TextEncoder().encode(content).length > limits.maxFileBytes) {
    return `file is larger than ${limits.maxFileBytes} bytes`;
  }
  if (isNewFile && existingFileCount >= limits.maxFiles) return `workspace already has ${limits.maxFiles} files`;
  return null;
}

/** Keeps the end of `text` (where a failing test prints its reason) within `maxChars`. */
export function keepTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "[...output truncated...]\n";
  return marker + text.slice(text.length - Math.max(0, maxChars - marker.length));
}
