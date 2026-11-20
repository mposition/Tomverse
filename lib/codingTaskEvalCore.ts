/**
 * Pure pieces of the coding-task evaluation harness: the fixed task set, the
 * result shape, the per-model summary, the workspace path guard, the verdict
 * logic and the worst-case cost bound.
 *
 * No server-only import and no SDK import, so a test (or a report page) can use
 * it anywhere. The module that runs a model against a task is
 * lib/codingTaskEval.ts.
 *
 * How a verdict cannot be forged. A task has no test file. It has `cases`:
 * a call (or a constructor plus method steps) and the value it must return.
 * The model's module runs in a child process next to a runner this harness
 * wrote. The child receives the calls with their arguments only. It sends the
 * values it computed back, inside a frame marked with a one-time token. The
 * expected values exist only in the parent process, which compares them. Model
 * code can print anything, call process.exit, or even learn the token: it still
 * cannot produce a passing frame, because it never sees what a pass looks like.
 *
 * Wire format for values in cases (plain JSON): `undefined`, `NaN`, `Infinity`
 * and `-Infinity` are written as {"$":"undefined"} and so on; {"$":"self"} is
 * a method returning the object it was called on.
 */

export type CodingEvalDifficulty = "easy" | "medium" | "hard";

/** A value in the case wire format. Must survive JSON.parse(JSON.stringify(x)). */
export type CodingEvalValue = unknown;

/** What one call produced, as the runner reports it (values already in wire format). */
export type CodingEvalOutcome = {
  ok: boolean;
  value?: CodingEvalValue;
  /** Constructor name of the thrown value when `ok` is false. */
  error?: string;
  /** Own enumerable properties of the thrown value, in wire format. */
  props?: Record<string, CodingEvalValue>;
};

export type CodingEvalStep =
  | { method: string; args?: CodingEvalValue[]; expect: CodingEvalValue }
  | { method: string; args?: CodingEvalValue[]; expectThrows: string }
  | { get: string; expect: CodingEvalValue };

export type CodingEvalCase =
  | {
      /** Name of an export of src/index.mjs. */
      call: string;
      args: CodingEvalValue[];
      expect?: CodingEvalValue;
      /** Constructor name of the error the call must throw (for example "RangeError"). */
      expectThrows?: string;
      /** Extra parent-side check of the outcome (never sent to the child). */
      check?: (outcome: CodingEvalOutcome) => boolean;
    }
  | {
      /** Name of a class exported by src/index.mjs. */
      construct: string;
      args: CodingEvalValue[];
      steps?: CodingEvalStep[];
      expectThrows?: string;
    };

export type CodingEvalTask = {
  id: string;
  difficulty: CodingEvalDifficulty;
  /** What the model is asked to do. Describes behaviour, never the cases. */
  prompt: string;
  /** Starting workspace: relative path -> file content. */
  files: Record<string, string>;
  /** A few cases the model can run (run_tests) and sees the failures of. */
  examples: readonly CodingEvalCase[];
  /** The final grade: every one of these must pass. Includes the examples. */
  hidden: readonly CodingEvalCase[];
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
  /**
   * True when the token counts may be too low: a step reported no usage, or the
   * task ended in `error` or `timeout` (a call in flight reports nothing).
   * Charge the worst case (codingEvalWorstCaseTokens) for such a result.
   */
  usageUnknown: boolean;
};

export type CodingEvalLimits = {
  /** Agent step cap (one step = one model call plus its tool executions). */
  maxSteps: number;
  /** Wall clock for one sandboxed `node` run of a case list. */
  testTimeoutMs: number;
  /** Characters of run_tests output kept; the tail is kept because failures print last. */
  testOutputMaxChars: number;
  /** Wall clock for a whole task: model calls, tools and the final judging run. */
  taskTimeoutMs: number;
  /** How many times the model may call run_tests in one task. */
  maxTestRunsPerTask: number;
  maxFiles: number;
  maxFileBytes: number;
  /** Total bytes of all files in the workspace. */
  maxWorkspaceBytes: number;
  /** Total bytes of tool results returned to the model in one task. */
  maxToolOutputBytes: number;
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
  maxWorkspaceBytes: 256 * 1024,
  maxToolOutputBytes: 256 * 1024,
  maxPathLength: 120,
  maxNameLength: 64,
  maxDepth: 5,
  maxOutputTokensPerStep: 8_192,
});

/** The module under test. Every task's runner imports exactly this file. */
export const CODING_EVAL_ENTRY_FILE = "src/index.mjs";

/** The trusted runner's name. It exists in the workspace only while cases run. */
export const CODING_EVAL_RUNNER_FILE = "zz_eval_runner.mjs";

const RESERVED_FILES: readonly string[] = [CODING_EVAL_RUNNER_FILE];

const DIFFICULTIES: readonly CodingEvalDifficulty[] = ["easy", "medium", "hard"];

export const CODING_EVAL_UNDEFINED = Object.freeze({ $: "undefined" });
export const CODING_EVAL_SELF = Object.freeze({ $: "self" });
export const CODING_EVAL_NAN = Object.freeze({ $: "NaN" });

// ---------------------------------------------------------------------------
// Case builders (task data below)
// ---------------------------------------------------------------------------

const U = CODING_EVAL_UNDEFINED;
const SELF = CODING_EVAL_SELF;

const fn = (call: string, args: CodingEvalValue[], expect: CodingEvalValue): CodingEvalCase => ({ call, args, expect });
const fnThrows = (
  call: string,
  args: CodingEvalValue[],
  expectThrows: string,
  check?: (outcome: CodingEvalOutcome) => boolean,
): CodingEvalCase => ({ call, args, expectThrows, ...(check ? { check } : {}) });
const method = (name: string, args: CodingEvalValue[], expect: CodingEvalValue): CodingEvalStep => ({
  method: name,
  args,
  expect,
});
const getter = (name: string, expect: CodingEvalValue): CodingEvalStep => ({ get: name, expect });

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const RANGE_EXAMPLES: CodingEvalCase[] = [
  fn("sumRange", [1, 5], 15),
  fn("lastN", [[1, 2, 3, 4], 2], [3, 4]),
  fn("lastN", [[1, 2, 3], 0], []),
];
const RANGE_HIDDEN: CodingEvalCase[] = [
  ...RANGE_EXAMPLES,
  fn("sumRange", [3, 3], 3),
  fn("sumRange", [-2, 2], 0),
  fn("sumRange", [5, 1], 0),
  fn("lastN", [[1, 2, 3, 4], 4], [1, 2, 3, 4]),
  fn("lastN", [[1, 2, 3], -1], []),
  fn("lastN", [[1, 2, 3], 10], [1, 2, 3]),
];

const QUERY_EXAMPLES: CodingEvalCase[] = [
  fn("parseQuery", ["a=1&b=2"], { a: "1", b: "2" }),
  fn("parseQuery", ["token=abc=def=="], { token: "abc=def==" }),
  fn("parseQuery", ["a=1&a=2"], { a: ["1", "2"] }),
];
const QUERY_HIDDEN: CodingEvalCase[] = [
  ...QUERY_EXAMPLES,
  fn("parseQuery", ["?x=1"], { x: "1" }),
  fn("parseQuery", [""], {}),
  fn("parseQuery", ["?"], {}),
  fn("parseQuery", ["&&a=1&"], { a: "1" }),
  fn("parseQuery", ["flag&x=1"], { flag: "", x: "1" }),
  fn("parseQuery", ["empty="], { empty: "" }),
  fn("parseQuery", ["name=John+Doe&city=S%C3%A3o%20Paulo"], { name: "John Doe", city: "São Paulo" }),
  fn("parseQuery", ["q=100%25"], { q: "100%" }),
  fn("parseQuery", ["a%20b=c%26d"], { "a b": "c&d" }),
  fn("parseQuery", ["a=1&a=2&b=x&a=3"], { a: ["1", "2", "3"], b: "x" }),
];

const LRU_EXAMPLES: CodingEvalCase[] = [
  {
    construct: "LRUCache",
    args: [2],
    steps: [
      method("set", ["a", 1], SELF),
      method("set", ["b", 2], SELF),
      method("get", ["a"], 1),
      method("get", ["missing"], U),
      getter("size", 2),
    ],
  },
  {
    construct: "LRUCache",
    args: [2],
    steps: [
      method("set", ["a", 1], SELF),
      method("set", ["b", 2], SELF),
      method("set", ["c", 3], SELF),
      method("has", ["a"], false),
      method("keys", [], ["b", "c"]),
    ],
  },
];
const LRU_HIDDEN: CodingEvalCase[] = [
  ...LRU_EXAMPLES,
  {
    construct: "LRUCache",
    args: [2],
    steps: [
      method("set", ["a", 1], SELF),
      method("set", ["b", 2], SELF),
      method("get", ["a"], 1),
      method("set", ["c", 3], SELF),
      method("has", ["b"], false),
      method("keys", [], ["a", "c"]),
    ],
  },
  {
    construct: "LRUCache",
    args: [2],
    steps: [
      method("set", ["a", 1], SELF),
      method("set", ["b", 2], SELF),
      method("set", ["a", 10], SELF),
      getter("size", 2),
      method("keys", [], ["b", "a"]),
      method("set", ["c", 3], SELF),
      method("has", ["b"], false),
      method("get", ["a"], 10),
    ],
  },
  {
    construct: "LRUCache",
    args: [2],
    steps: [
      method("set", ["a", 1], SELF),
      method("set", ["b", 2], SELF),
      method("has", ["a"], true),
      method("set", ["c", 3], SELF),
      method("has", ["a"], false),
    ],
  },
  {
    construct: "LRUCache",
    args: [1],
    steps: [method("set", ["a", U], SELF), method("has", ["a"], true), getter("size", 1)],
  },
  {
    construct: "LRUCache",
    args: [1],
    steps: [
      method("set", ["a", 1], SELF),
      method("set", ["b", 2], SELF),
      method("has", ["a"], false),
      method("get", ["b"], 2),
      getter("size", 1),
    ],
  },
  { construct: "LRUCache", args: [0], expectThrows: "RangeError" },
  { construct: "LRUCache", args: [-1], expectThrows: "RangeError" },
  { construct: "LRUCache", args: [1.5], expectThrows: "RangeError" },
  { construct: "LRUCache", args: [CODING_EVAL_NAN], expectThrows: "RangeError" },
];

const MERGE_EXAMPLES: CodingEvalCase[] = [
  fn("mergeIntervals", [[[8, 10], [1, 3], [2, 6], [15, 18]]], [[1, 6], [8, 10], [15, 18]]),
  fn("mergeIntervals", [[[1, 3], [3, 5]]], [[1, 5]]),
];
const MERGE_HIDDEN: CodingEvalCase[] = [
  ...MERGE_EXAMPLES,
  fn("mergeIntervals", [[[1, 2], [3, 4]]], [[1, 2], [3, 4]]),
  fn("mergeIntervals", [[[1, 10], [2, 3], [4, 5]]], [[1, 10]]),
  fn("mergeIntervals", [[[1, 4], [2, 3]]], [[1, 4]]),
  fn("mergeIntervals", [[[-5, -1], [-3, 0], [7, 7], [7, 7]]], [[-5, 0], [7, 7]]),
  fn("mergeIntervals", [[]], []),
  fnThrows("mergeIntervals", [[[1, 2], [5, 3]]], "RangeError"),
];

const BAD_EXPRESSIONS = ["", "   ", "2 $ 3", "abc", "(1 + 2", "1 + 2)", "()", "1 +", "* 3", "1 2", "1.2.3", "2 ** 3"];
const EXPRESSION_EXAMPLES: CodingEvalCase[] = [
  fn("evaluate", ["2 + 3 * 4"], 14),
  fn("evaluate", ["2^3^2"], 512),
  fn("evaluate", ["-2^2"], -4),
  fnThrows("evaluate", ["1 +"], "SyntaxError"),
];
const EXPRESSION_HIDDEN: CodingEvalCase[] = [
  ...EXPRESSION_EXAMPLES,
  fn("evaluate", ["42"], 42),
  fn("evaluate", ["  2.5 "], 2.5),
  fn("evaluate", [".5 + .25"], 0.75),
  fn("evaluate", ["1+2"], 3),
  fn("evaluate", ["2 * 3 + 4"], 10),
  fn("evaluate", ["2 * 3 ^ 2"], 18),
  fn("evaluate", ["1 - 2 - 3"], -4),
  fn("evaluate", ["8 / 2 / 2"], 2),
  fn("evaluate", ["10 / 4"], 2.5),
  fn("evaluate", ["2^10"], 1024),
  fn("evaluate", ["-3"], -3),
  fn("evaluate", ["--3"], 3),
  fn("evaluate", ["2*-3"], -6),
  fn("evaluate", ["2^-2"], 0.25),
  fn("evaluate", ["+4 - -1"], 5),
  fn("evaluate", ["(2 + 3) * 4"], 20),
  fn("evaluate", ["((1))"], 1),
  fn("evaluate", ["2 * (3 + (4 - 1)) ^ 2"], 72),
  fn("evaluate", ["-(1 + 2)"], -3),
  ...BAD_EXPRESSIONS.map((source) => fnThrows("evaluate", [source], "SyntaxError")),
  fnThrows("evaluate", ["1 / 0"], "RangeError"),
  fnThrows("evaluate", ["4 / (2 - 2)"], "RangeError"),
];

type Graph = Record<string, string[]>;

/** Parent-side check: the thrown CycleError lists a real cycle (each name depends on the next). */
const realCycle =
  (graph: Graph, options: { exclude?: string[]; exact?: string[] } = {}) =>
  (outcome: CodingEvalOutcome): boolean => {
    const cycle = outcome.props ? outcome.props.cycle : undefined;
    if (outcome.ok || !Array.isArray(cycle) || cycle.length < 2) return false;
    if (!cycle.every((name) => typeof name === "string") || cycle[0] !== cycle[cycle.length - 1]) return false;
    for (let i = 0; i + 1 < cycle.length; i++) {
      const dependencies = Object.prototype.hasOwnProperty.call(graph, cycle[i]) ? graph[cycle[i]] : [];
      if (!dependencies.includes(cycle[i + 1])) return false;
    }
    if (options.exclude && cycle.some((name) => options.exclude?.includes(name))) return false;
    if (options.exact && JSON.stringify(cycle) !== JSON.stringify(options.exact)) return false;
    return true;
  };

const THREE_CYCLE: Graph = { a: ["b"], b: ["c"], c: ["a"] };
const SELF_CYCLE: Graph = { a: ["a"] };
const TAIL_CYCLE: Graph = { x: ["a"], a: ["b"], b: ["a"], y: [] };
const TOPO_EXAMPLES: CodingEvalCase[] = [
  fn("topoSort", [{ app: ["lib", "util"], lib: ["util"], util: [] }], ["util", "lib", "app"]),
  fn("topoSort", [{ b: [], a: [], c: ["a", "b"] }], ["a", "b", "c"]),
  fnThrows("topoSort", [THREE_CYCLE], "CycleError", realCycle(THREE_CYCLE)),
];
const TOPO_HIDDEN: CodingEvalCase[] = [
  ...TOPO_EXAMPLES,
  fn("topoSort", [{ z: [], y: ["z"], a: ["z"], m: [] }], ["m", "z", "a", "y"]),
  fn("topoSort", [{ a: ["z"] }], ["z", "a"]),
  fn("topoSort", [{}], []),
  fn("topoSort", [{ a: ["b", "b"], b: [] }], ["b", "a"]),
  fn("topoSort", [{ a: ["b"], b: ["c"] }], ["c", "b", "a"]),
  fnThrows("topoSort", [SELF_CYCLE], "CycleError", realCycle(SELF_CYCLE, { exact: ["a", "a"] })),
  fnThrows("topoSort", [TAIL_CYCLE], "CycleError", realCycle(TAIL_CYCLE, { exclude: ["x", "y"] })),
];

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
      "The input array must not be modified, and the result must be a new array.",
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
    examples: RANGE_EXAMPLES,
    hidden: RANGE_HIDDEN,
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
    examples: QUERY_EXAMPLES,
    hidden: QUERY_HIDDEN,
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
    examples: LRU_EXAMPLES,
    hidden: LRU_HIDDEN,
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
    examples: MERGE_EXAMPLES,
    hidden: MERGE_HIDDEN,
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
    examples: EXPRESSION_EXAMPLES,
    hidden: EXPRESSION_HIDDEN,
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
      "- Do not modify the input object, and return a new array.",
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
    examples: TOPO_EXAMPLES,
    hidden: TOPO_HIDDEN,
  },
];

export function getCodingEvalTask(id: string): CodingEvalTask | undefined {
  return CODING_EVAL_TASKS.find((task) => task.id === id);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Workspace guard
// ---------------------------------------------------------------------------

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Resolves a model-supplied relative path to a file path under `root`, or null
 * when it is not a plain, short, forward-slash relative path.
 *
 * Refused: non-strings, empty text, NUL, backslashes, absolute paths, drive
 * letters (`C:x` included), any `.` / `..` / empty segment (a leading `./` is
 * tolerated), characters outside letters, digits and `._-`, Windows device
 * names, trailing dots, names or paths over the limits, and the runner's name.
 * It is lexical on purpose: the workspace holds only files this harness wrote,
 * and the model cannot create links.
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
  if (RESERVED_FILES.includes(segments[segments.length - 1])) return null;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.endsWith("/") || root.endsWith("\\") ? root.slice(0, -1) : root;
  return `${base}${separator}${segments.join(separator)}`;
}

/** Why a write would break the workspace limits, or null when it is fine. */
export function checkSandboxWrite(
  write: {
    /** Files in the workspace before this write. */
    fileCount: number;
    isNewFile: boolean;
    /** Bytes of every other file (the file being replaced is not counted). */
    otherBytes: number;
    content: unknown;
  },
  limits: Pick<CodingEvalLimits, "maxFiles" | "maxFileBytes" | "maxWorkspaceBytes"> = CODING_EVAL_LIMITS,
): string | null {
  const { content } = write;
  if (typeof content !== "string") return "content must be a string";
  if (content.includes("\0")) return "content must be text";
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > limits.maxFileBytes) return `file is larger than ${limits.maxFileBytes} bytes`;
  if (write.isNewFile && write.fileCount >= limits.maxFiles) return `workspace already has ${limits.maxFiles} files`;
  if (write.otherBytes + bytes > limits.maxWorkspaceBytes) {
    return `workspace would be larger than ${limits.maxWorkspaceBytes} bytes in total`;
  }
  return null;
}

/** Keeps the end of `text` (where a failure is reported) within `maxChars`. */
export function keepTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "[...output truncated...]\n";
  return marker + text.slice(text.length - Math.max(0, maxChars - marker.length));
}

// ---------------------------------------------------------------------------
// Verdicts: the parent's side of the protocol
// ---------------------------------------------------------------------------

/** Prefix of the one line the runner writes. A token follows, then the JSON. */
export const CODING_EVAL_FRAME_PREFIX = "@@CODING-EVAL-FRAME@@";

/** JSON with sorted keys, so equal values compare equal as strings. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const clip = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}...` : text);

/** What the runner is given: calls and arguments, never an expected value. */
export function buildRunnerCases(cases: readonly CodingEvalCase[]): unknown[] {
  return cases.map((entry) => {
    if ("call" in entry) return { call: entry.call, args: entry.args };
    return {
      construct: entry.construct,
      args: entry.args,
      steps: (entry.steps || []).map((step) =>
        "get" in step ? { get: step.get } : { method: step.method, args: step.args || [] },
      ),
    };
  });
}

/**
 * Finds the runner's frame in the child's stdout. Lines without the exact
 * `PREFIX token ` start are ignored, so model output cannot be mistaken for it.
 * Exactly one frame is accepted: a second one means something else wrote one.
 */
export function parseRunnerOutput(stdout: string, token: string): { frame: unknown } | { problem: string } {
  const start = `${CODING_EVAL_FRAME_PREFIX} ${token} `;
  const frames = stdout.split(/\r?\n/).filter((line) => line.startsWith(start));
  if (frames.length === 0) return { problem: "no result frame (the module exited early, crashed or hung)" };
  if (frames.length > 1) return { problem: "more than one result frame (output was tampered with)" };
  try {
    return { frame: JSON.parse(frames[0].slice(start.length)) };
  } catch {
    return { problem: "the result frame is not valid JSON" };
  }
}

export type CodingEvalCaseVerdict = {
  passed: boolean;
  reason: string;
  expected?: string;
  actual?: string;
};

export type CodingEvalJudgement = {
  passed: boolean;
  /** Why no verdicts exist (import failure, malformed frame), or null. */
  problem: string | null;
  verdicts: CodingEvalCaseVerdict[];
};

const ok = (): CodingEvalCaseVerdict => ({ passed: true, reason: "ok" });
const notOk = (reason: string, expected?: unknown, actual?: unknown): CodingEvalCaseVerdict => ({
  passed: false,
  reason,
  ...(expected !== undefined ? { expected: clip(typeof expected === "string" ? expected : canonicalJson(expected)) } : {}),
  ...(actual !== undefined ? { actual: clip(typeof actual === "string" ? actual : canonicalJson(actual)) } : {}),
});

function judgeOutcome(
  reported: unknown,
  expectation: { expect?: unknown; hasExpect: boolean; expectThrows?: string },
): CodingEvalCaseVerdict {
  if (!isRecord(reported) || typeof reported.ok !== "boolean") return notOk("malformed outcome");
  if (expectation.expectThrows !== undefined) {
    if (reported.ok) return notOk("expected an exception", `throws ${expectation.expectThrows}`, reported.value);
    if (reported.error !== expectation.expectThrows) {
      return notOk("wrong exception type", `throws ${expectation.expectThrows}`, `threw ${String(reported.error)}`);
    }
    return ok();
  }
  if (!expectation.hasExpect) return notOk("the case has no expectation");
  if (!reported.ok) return notOk("threw an exception", expectation.expect, `threw ${String(reported.error)}`);
  if (canonicalJson(reported.value) !== canonicalJson(expectation.expect)) {
    return notOk("wrong result", expectation.expect, reported.value);
  }
  return ok();
}

function judgeCase(entry: CodingEvalCase, reported: unknown): CodingEvalCaseVerdict {
  if (!isRecord(reported)) return notOk("malformed outcome");
  if ("call" in entry) {
    if (canonicalJson(reported.argsAfter) !== canonicalJson(entry.args)) {
      return notOk("the function modified its arguments", entry.args, reported.argsAfter);
    }
    if (reported.aliased !== false) return notOk("the result shares an object with the arguments (return a copy)");
    const verdict = judgeOutcome(reported, {
      expect: entry.expect,
      hasExpect: "expect" in entry,
      expectThrows: entry.expectThrows,
    });
    if (!verdict.passed || !entry.check) return verdict;
    let accepted = false;
    try {
      accepted = entry.check(reported as unknown as CodingEvalOutcome) === true;
    } catch {
      accepted = false;
    }
    return accepted ? verdict : notOk("the reported cycle is not a real cycle of the input", undefined, reported.props);
  }
  const constructed = reported.ctor;
  if (entry.expectThrows !== undefined) {
    return judgeOutcome(isRecord(constructed) ? { ok: constructed.ok, error: constructed.error } : undefined, {
      hasExpect: false,
      expectThrows: entry.expectThrows,
    });
  }
  if (!isRecord(constructed) || constructed.ok !== true) {
    return notOk("the constructor threw", undefined, isRecord(constructed) ? String(constructed.error) : undefined);
  }
  const steps = entry.steps || [];
  const reportedSteps = reported.steps;
  if (!Array.isArray(reportedSteps) || reportedSteps.length !== steps.length) return notOk("missing step results");
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const label = "get" in step ? `.${step.get}` : `.${step.method}(${stepArguments(step.args)})`;
    const verdict = judgeOutcome(reportedSteps[index], {
      expect: "expect" in step ? step.expect : undefined,
      hasExpect: "expect" in step,
      expectThrows: "expectThrows" in step ? step.expectThrows : undefined,
    });
    if (!verdict.passed) return { ...verdict, reason: `step ${index + 1} ${label}: ${verdict.reason}` };
  }
  return ok();
}

function stepArguments(args: readonly unknown[] | undefined): string {
  return canonicalJson(args || []).slice(1, -1);
}

/** Compares the runner's frame with the cases. Never throws; anything unreadable fails. */
export function judgeCodingEvalCases(cases: readonly CodingEvalCase[], frame: unknown): CodingEvalJudgement {
  const failed = (problem: string): CodingEvalJudgement => ({ passed: false, problem, verdicts: [] });
  try {
    if (!isRecord(frame)) return failed("malformed result frame");
    if (typeof frame.importError === "string") return failed(`the module failed to load: ${clip(frame.importError)}`);
    if (!Array.isArray(frame.results) || frame.results.length !== cases.length) {
      return failed("the result frame does not match the case list");
    }
    const verdicts = cases.map((entry, index) => judgeCase(entry, (frame.results as unknown[])[index]));
    return { passed: verdicts.every((verdict) => verdict.passed), problem: null, verdicts };
  } catch {
    return failed("the result frame could not be read");
  }
}

/** One line naming a case, for failure reports. */
export function describeCodingEvalCase(entry: CodingEvalCase): string {
  if ("call" in entry) return clip(`${entry.call}(${stepArguments(entry.args)})`, 200);
  const steps = (entry.steps || []).map((step) => ("get" in step ? `.${step.get}` : `.${step.method}(${stepArguments(step.args)})`));
  return clip(`new ${entry.construct}(${stepArguments(entry.args)})${steps.join("")}`, 200);
}

/** The failing cases of a judgement as text for the model: input, expected, actual. */
export function formatCodingEvalReport(
  cases: readonly CodingEvalCase[],
  judgement: CodingEvalJudgement,
  maxShown = 5,
): string {
  if (judgement.problem) return judgement.problem;
  const failing = judgement.verdicts
    .map((verdict, index) => ({ verdict, index }))
    .filter(({ verdict }) => !verdict.passed);
  if (failing.length === 0) return `all ${cases.length} checks passed`;
  const lines = [`${failing.length} of ${cases.length} checks failed`];
  for (const { verdict, index } of failing.slice(0, maxShown)) {
    lines.push(`- ${describeCodingEvalCase(cases[index])}`);
    lines.push(`  ${verdict.reason}`);
    if (verdict.expected !== undefined) lines.push(`  expected: ${verdict.expected}`);
    if (verdict.actual !== undefined) lines.push(`  actual:   ${verdict.actual}`);
  }
  if (failing.length > maxShown) lines.push(`... and ${failing.length - maxShown} more failing checks`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The trusted runner
// ---------------------------------------------------------------------------

/**
 * Source of the runner the harness writes into the workspace and runs inside
 * the permission sandbox. It reads the token and the calls from stdin BEFORE it
 * imports the model's module, and keeps its own references to the output and
 * exit functions, so module code cannot read the token from stdin or hijack the
 * write. It reports values only; it has no idea what the right ones are.
 */
export const CODING_EVAL_RUNNER_SOURCE = String.raw`import { pathToFileURL } from "node:url";
import { join } from "node:path";

const writeOut = process.stdout.write.bind(process.stdout);
const exitNow = process.exit.bind(process);
const stringify = JSON.stringify;
const parse = JSON.parse;
const isArray = Array.isArray;
const keysOf = Object.keys;
const getProto = Object.getPrototypeOf;
const createObject = Object.create;
const objectProto = Object.prototype;
const hasOwn = Object.prototype.hasOwnProperty;
const FRAME = "@@CODING-EVAL-FRAME@@";
const MAX_NODES = 20000;
const MAX_DEPTH = 24;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString("utf8");
const newline = input.indexOf("\n");
const token = input.slice(0, newline);
const payload = parse(input.slice(newline + 1));

function decode(value) {
  if (isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    if (hasOwn.call(value, "$")) {
      const tag = value["$"];
      if (tag === "undefined") return undefined;
      if (tag === "NaN") return NaN;
      if (tag === "Infinity") return Infinity;
      if (tag === "-Infinity") return -Infinity;
    }
    const out = {};
    for (const key of keysOf(value)) out[key] = decode(value[key]);
    return out;
  }
  return value;
}

function collectObjects(root) {
  const seen = new Set();
  const stack = [root];
  let count = 0;
  while (stack.length > 0 && count < MAX_NODES) {
    const value = stack.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    count += 1;
    for (const key of keysOf(value)) stack.push(value[key]);
  }
  return seen;
}

function sharesObject(result, inputObjects) {
  for (const value of collectObjects(result)) if (inputObjects.has(value)) return true;
  return false;
}

function makeEncoder(self) {
  let nodes = 0;
  function encode(value, depth) {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return { "$": "toolarge" };
    if (value === undefined) return { "$": "undefined" };
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value !== value) return { "$": "NaN" };
      if (value === Infinity) return { "$": "Infinity" };
      if (value === -Infinity) return { "$": "-Infinity" };
      return value;
    }
    if (typeof value === "string") {
      return value.length > 4000 ? { "$": "longstring", length: value.length, head: value.slice(0, 80) } : value;
    }
    if (typeof value !== "object") return { "$": "unserializable", type: typeof value };
    if (self !== undefined && value === self) return { "$": "self" };
    if (isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length && i < MAX_NODES; i++) out.push(encode(value[i], depth + 1));
      return out;
    }
    const proto = getProto(value);
    const out = createObject(null);
    for (const key of keysOf(value)) out[key] = encode(value[key], depth + 1);
    if (proto !== objectProto && proto !== null) {
      const name = proto.constructor && typeof proto.constructor.name === "string" ? proto.constructor.name : "unknown";
      return { "$": "instance", class: name, value: out };
    }
    if (hasOwn.call(out, "$")) return { "$": "object", value: out };
    return out;
  }
  return (value) => encode(value, 0);
}

function errorName(error) {
  try {
    const name = error && error.constructor && error.constructor.name;
    return typeof name === "string" && name !== "" ? name : typeof error;
  } catch {
    return "unknown";
  }
}

function errorProps(error) {
  const props = createObject(null);
  try {
    if (error !== null && typeof error === "object") {
      const encode = makeEncoder(undefined);
      for (const key of keysOf(error)) props[key] = encode(error[key]);
    }
  } catch {
    return props;
  }
  return props;
}

function attempt(thunk, self) {
  try {
    const raw = thunk();
    return { outcome: { ok: true, value: makeEncoder(self)(raw) }, raw };
  } catch (error) {
    return { outcome: { ok: false, error: errorName(error), props: errorProps(error) }, raw: undefined };
  }
}

const prepared = payload.cases.map((entry) => {
  if (entry.call !== undefined) {
    const args = decode(entry.args);
    return { kind: "call", name: entry.call, args, objects: collectObjects(args) };
  }
  const steps = (entry.steps || []).map((step) =>
    step.get !== undefined ? { get: step.get } : { method: step.method, args: decode(step.args || []) },
  );
  return { kind: "construct", name: entry.construct, args: decode(entry.args), steps };
});

let moduleExports = null;
let importError = null;
try {
  moduleExports = await import(pathToFileURL(join(process.cwd(), "src", "index.mjs")).href);
} catch (error) {
  importError = (errorName(error) + ": " + String(error && error.message)).slice(0, 300);
}

const results = [];
if (importError === null) {
  for (const entry of prepared) {
    const target = moduleExports[entry.name];
    if (entry.kind === "call") {
      if (typeof target !== "function") {
        results.push({ ok: false, error: "NotAFunction", props: {}, argsAfter: [], aliased: false });
        continue;
      }
      const { outcome, raw } = attempt(() => target(...entry.args), undefined);
      outcome.argsAfter = makeEncoder(undefined)(entry.args);
      outcome.aliased = outcome.ok ? sharesObject(raw, entry.objects) : false;
      results.push(outcome);
      continue;
    }
    let instance;
    let constructed;
    if (typeof target !== "function") {
      constructed = { ok: false, error: "NotAFunction" };
    } else {
      const made = attempt(() => new target(...entry.args), undefined);
      instance = made.raw;
      constructed = made.outcome.ok ? { ok: true } : { ok: false, error: made.outcome.error };
    }
    const stepResults = [];
    if (constructed.ok) {
      for (const step of entry.steps) {
        const run = step.get !== undefined ? () => instance[step.get] : () => instance[step.method](...step.args);
        stepResults.push(attempt(run, instance).outcome);
      }
    }
    results.push({ ctor: constructed, steps: stepResults });
  }
}

writeOut("\n" + FRAME + " " + token + " " + stringify({ importError, results }) + "\n", () => exitNow(0));
`;

// ---------------------------------------------------------------------------
// Prompt and cost bound
// ---------------------------------------------------------------------------

/** The system prompt the agent gets. Exported because the worst-case input bound counts its size. */
export function codingEvalSystemPrompt(maxSteps: number): string {
  return [
    "You are an autonomous coding agent fixing or finishing a small JavaScript project (ES modules, Node.js built-ins only, no packages to install).",
    "Tools: list_files, read_file, write_file (whole file content), run_tests.",
    "run_tests runs example checks and shows the failing ones with input, expected value and actual value. The final grade also uses further hidden checks of the same behaviour, so implement everything the task describes, not only what the examples show.",
    "Work efficiently: you have at most " + maxSteps + " steps, and each reply that calls tools is one step. Several tool calls in one reply cost one step.",
    "Read the code first, write your changes, then call run_tests. Keep going until run_tests passes.",
    "When run_tests passes, stop and reply with one short sentence. Do not rewrite working code afterwards.",
    "Never try to read or write outside the project folder.",
  ].join("\n");
}

/** Generous size of the four tool definitions (names, descriptions, JSON schemas) sent with every request. */
const TOOL_DEFINITION_BYTES = 4 * 1024;

/**
 * Worst-case tokens one task can bill, for budgeting before a run.
 *
 * Basis: a token covers at least one byte of text, so bytes are an upper bound
 * on tokens for every tokenizer. One task makes at most `maxSteps` model calls
 * (maxRetries is 0, so none repeat). Step k (counted from 0) is sent
 *   system prompt + tool definitions + the longest task prompt
 *   + the workspace limit              (what the files can hold)
 *   + the tool-output limit            (everything read_file/list_files/run_tests may return)
 *   + k * (maxOutputTokensPerStep      (each earlier reply, at its cap)
 *          + maxOutputTokensPerStep)   (their tool-result stubs: a tool call costs the model
 *                                       at least ~20 tokens and a refused call's result is
 *                                       under 20, so stubs never exceed the calls)
 * Summing k = 0 .. maxSteps-1 gives the input bound; the output bound is
 * maxSteps * maxOutputTokensPerStep. The workspace and the tool-output limit are
 * both counted although the second mostly repeats the first: over-counting is
 * the safe side. The final judging run makes no model call.
 */
export function codingEvalWorstCaseTokens(
  limits: Pick<
    CodingEvalLimits,
    "maxSteps" | "maxOutputTokensPerStep" | "maxWorkspaceBytes" | "maxToolOutputBytes"
  > = CODING_EVAL_LIMITS,
  tasks: readonly CodingEvalTask[] = CODING_EVAL_TASKS,
): { inputTokens: number; outputTokens: number } {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const longestPrompt = Math.max(0, ...tasks.map((task) => bytes(task.prompt)));
  const base =
    bytes(codingEvalSystemPrompt(limits.maxSteps)) +
    TOOL_DEFINITION_BYTES +
    longestPrompt +
    limits.maxWorkspaceBytes +
    limits.maxToolOutputBytes;
  const growthPerStep = 2 * limits.maxOutputTokensPerStep;
  const steps = limits.maxSteps;
  return {
    inputTokens: steps * base + growthPerStep * ((steps * (steps - 1)) / 2),
    outputTokens: steps * limits.maxOutputTokensPerStep,
  };
}
