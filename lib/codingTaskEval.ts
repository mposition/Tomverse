import "server-only";

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { AiModel } from "@/lib/models";
import {
  CODING_EVAL_HIDDEN_TEST_FILE,
  CODING_EVAL_LIMITS,
  checkSandboxWrite,
  keepTail,
  resolveSandboxPath,
  type CodingEvalFailure,
  type CodingEvalLimits,
  type CodingEvalResult,
  type CodingEvalTask,
} from "@/lib/codingTaskEvalCore";

/**
 * Real-task coding evaluation: a model gets a small JavaScript project and four
 * tools (list_files, read_file, write_file, run_tests), works like an agent,
 * and the harness then runs hidden node:test tests to decide pass or fail.
 *
 * This is a PAID call path (every task is up to `maxSteps` model calls). The
 * caller owns the budget: pass `shouldContinue` to runCodingEval and stop
 * dispatching when the cycle's budget is spent.
 *
 * Security boundary. The model's code runs in a child `node` process started
 * with the Node permission model (`--permission`), an empty environment, the
 * workspace as cwd, and read access to that one directory only:
 *  - blocked: reading any other file (parent folders, the repository, home),
 *    every file write, child processes, worker threads, native addons;
 *  - NOT blocked: network access (Node 22 has no network permission). The
 *    child has nothing secret to send: it sees no environment variable and no
 *    file outside the workspace.
 * Do not widen `--allow-fs-read`, add `--allow-fs-write`, or pass environment
 * variables to the child without redoing that argument.
 */

export type CodingEvalModelFactory = (model: AiModel) => LanguageModel | Promise<LanguageModel>;

export type SandboxTestResult = {
  /** Exit code 0 and at least one test ran and none failed. */
  passed: boolean;
  /** Combined stdout and stderr, tail only, workspace path masked. */
  output: string;
  timedOut: boolean;
  exitCode: number | null;
};

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// libuv copies these from the parent on Windows whenever the child's environment
// lacks them (SystemRoot is the one node needs; the rest are only defaults it
// fills in). Passing them as empty strings stops the copy.
const WINDOWS_COPIED_VARIABLES = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

// NodeJS.ProcessEnv demands NODE_ENV (Next types); the child intentionally gets none.
function sandboxEnvironment(): NodeJS.ProcessEnv {
  // Nothing from the parent. On Windows node cannot start without SystemRoot
  // (its crypto initialisation asserts); that path is not a secret.
  if (process.platform !== "win32") return {} as unknown as NodeJS.ProcessEnv;
  return {
    ...Object.fromEntries(WINDOWS_COPIED_VARIABLES.map((name) => [name, ""])),
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
  } as unknown as NodeJS.ProcessEnv;
}

function maskWorkspace(text: string, dirs: readonly string[]): string {
  let masked = text;
  for (const dir of dirs) {
    const forms = new Set([dir, dir.replaceAll("\\", "\\\\"), dir.replaceAll("\\", "/"), encodeURI(dir.replaceAll("\\", "/"))]);
    for (const form of forms) masked = masked.replaceAll(form, "<workspace>");
  }
  return masked;
}

/**
 * Writes the hidden test file into `dir`, runs it in the permission-restricted
 * child process, removes the file again and reports the outcome.
 *
 * The file is run directly (`node <file>`), not through `node --test`: the
 * test runner spawns one child process per file, and `--permission` denies
 * spawning. A direct run still uses node:test and exits non-zero on failure.
 */
export async function runSandboxedTests(
  dir: string,
  testSource: string,
  limits: Pick<CodingEvalLimits, "testTimeoutMs" | "testOutputMaxChars"> = CODING_EVAL_LIMITS,
  signal?: AbortSignal,
): Promise<SandboxTestResult> {
  const realDir = await realpath(dir);
  const testFile = join(realDir, CODING_EVAL_HIDDEN_TEST_FILE);
  await writeFile(testFile, testSource, "utf8");
  try {
    return await new Promise<SandboxTestResult>((resolve) => {
      const args = [
        "--permission",
        `--allow-fs-read=${realDir}`,
        "--max-old-space-size=256",
        "--test-reporter=tap",
        CODING_EVAL_HIDDEN_TEST_FILE,
      ];
      const child = spawn(process.execPath, args, {
        cwd: realDir,
        env: sandboxEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = "";
      let timedOut = false;
      let settled = false;
      const keep = Math.max(limits.testOutputMaxChars * 4, 16_384);
      const collect = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > keep * 2) output = output.slice(output.length - keep);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const stop = () => {
        timedOut = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, limits.testTimeoutMs);
      const onAbort = () => stop();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const text = maskWorkspace(output, [realDir, dir]).replace(ANSI, "");
        const ranTests = /^# pass (\d+)$/m.exec(text);
        const failures = /^# fail (\d+)$/m.exec(text);
        const passed =
          !timedOut && exitCode === 0 && ranTests !== null && Number(ranTests[1]) > 0 && Number(failures?.[1] ?? "1") === 0;
        resolve({ passed, output: keepTail(text, limits.testOutputMaxChars), timedOut, exitCode });
      };
      child.on("error", (error) => {
        output += `\nfailed to start test process: ${error.message}`;
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  } finally {
    await rm(testFile, { force: true });
  }
}

async function listWorkspaceFiles(root: string, limits: CodingEvalLimits): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relativeDir: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth || found.length > limits.maxFiles * 4) return;
    const entries = await readdir(join(root, relativeDir), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative, depth + 1);
      else if (entry.isFile() && relative !== CODING_EVAL_HIDDEN_TEST_FILE) found.push(relative);
    }
  };
  await walk("", 1);
  return found;
}

async function snapshotWorkspace(root: string, limits: CodingEvalLimits): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const relative of await listWorkspaceFiles(root, limits)) {
    const path = resolveSandboxPath(root, relative, limits);
    if (path) files[relative] = await readFile(path, "utf8");
  }
  return files;
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

/**
 * The four tools the model gets. Exported so tests can drive them directly.
 * A refused request returns `{ error }` to the model instead of throwing, so the
 * model can correct itself without burning the run.
 */
export function createCodingEvalTools(
  root: string,
  tests: string,
  limits: CodingEvalLimits = CODING_EVAL_LIMITS,
  signal?: AbortSignal,
) {
  let testRuns = 0;
  return {
    list_files: tool({
      description: "List every file in the project, with its size in bytes.",
      inputSchema: z.object({}),
      execute: async () => {
        const files = [];
        for (const relative of await listWorkspaceFiles(root, limits)) {
          const path = resolveSandboxPath(root, relative, limits);
          if (path) files.push({ path: relative, bytes: Buffer.byteLength(await readFile(path, "utf8")) });
        }
        return { files };
      },
    }),
    read_file: tool({
      description: "Read one project file as text. The path is relative to the project root, for example src/index.mjs.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const resolved = resolveSandboxPath(root, path, limits);
        if (!resolved) return { error: "invalid path: use a short relative path inside the project, like src/index.mjs" };
        try {
          return { content: await readFile(resolved, "utf8") };
        } catch {
          return { error: "file not found" };
        }
      },
    }),
    write_file: tool({
      description:
        "Create or overwrite one project file with the full new content. The path is relative to the project root.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        const resolved = resolveSandboxPath(root, path, limits);
        if (!resolved) return { error: "invalid path: use a short relative path inside the project, like src/index.mjs" };
        const existing = await listWorkspaceFiles(root, limits);
        const normalized = path.replace(/^(\.\/)+/, "");
        const refusal = checkSandboxWrite(existing.length, !existing.includes(normalized), content, limits);
        if (refusal) return { error: refusal };
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, content, "utf8");
        return { ok: true, bytes: Buffer.byteLength(content) };
      },
    }),
    run_tests: tool({
      description:
        "Run the project's hidden acceptance tests. Returns whether they passed and the end of the test output.",
      inputSchema: z.object({}),
      execute: async () => {
        if (testRuns >= limits.maxTestRunsPerTask) {
          return { error: `run_tests is limited to ${limits.maxTestRunsPerTask} calls per task` };
        }
        testRuns += 1;
        const result = await runSandboxedTests(root, tests, limits, signal);
        return { passed: result.passed, timedOut: result.timedOut, output: result.output };
      },
    }),
  };
}

function systemPrompt(maxSteps: number): string {
  return [
    "You are an autonomous coding agent fixing or finishing a small JavaScript project (ES modules, Node.js built-ins only, no packages to install).",
    "Tools: list_files, read_file, write_file (whole file content), run_tests.",
    "run_tests runs acceptance tests you cannot read; it reports whether they pass and the end of their output. Use that output to find what is still wrong.",
    "Work efficiently: you have at most " + maxSteps + " steps, and each reply that calls tools is one step. Several tool calls in one reply cost one step.",
    "Read the code first, write your changes, then call run_tests. Keep going until run_tests passes.",
    "When run_tests passes, stop and reply with one short sentence. Do not rewrite working code afterwards.",
    "Never try to read or write outside the project folder.",
  ].join("\n");
}

export type RunCodingEvalTaskInput = {
  task: CodingEvalTask;
  model: AiModel;
  /**
   * Builds the language model. Defaults to getActiveAiModel (the real, paid
   * provider call); tests pass a fake.
   */
  callModel?: CodingEvalModelFactory;
  limits?: Partial<CodingEvalLimits>;
};

async function defaultCallModel(model: AiModel): Promise<LanguageModel> {
  const { getActiveAiModel } = await import("@/lib/activeAiModel");
  return getActiveAiModel(model);
}

/**
 * Runs one task against one model and returns the verdict. Never throws for a
 * model or provider failure: that is reported as `failure: "error"`.
 */
export async function runCodingEvalTask(input: RunCodingEvalTaskInput): Promise<CodingEvalResult> {
  const { task, model } = input;
  const limits: CodingEvalLimits = { ...CODING_EVAL_LIMITS, ...input.limits };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.taskTimeoutMs);
  let root: string | null = null;
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastFinishReason: string | undefined;
  let timedOut = false;
  let errored = false;
  let passed = false;
  let changed = false;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "coding-eval-")));
    for (const [relative, content] of Object.entries(task.files)) {
      const path = resolveSandboxPath(root, relative, limits);
      if (!path) throw new Error(`task ${task.id} has an invalid file path`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
    try {
      const languageModel = await (input.callModel ?? defaultCallModel)(model);
      await generateText({
        model: languageModel,
        system: systemPrompt(limits.maxSteps),
        prompt: task.prompt,
        tools: createCodingEvalTools(root, task.tests, limits, controller.signal),
        stopWhen: stepCountIs(limits.maxSteps),
        maxOutputTokens: limits.maxOutputTokensPerStep,
        maxRetries: 1,
        abortSignal: controller.signal,
        onStepEnd: (step) => {
          steps += 1;
          inputTokens += step.usage.inputTokens ?? 0;
          outputTokens += step.usage.outputTokens ?? 0;
          lastFinishReason = step.finishReason;
        },
      });
    } catch {
      if (controller.signal.aborted) timedOut = true;
      else errored = true;
    }
    if (!timedOut && !errored) {
      // The model's own run_tests calls are not the verdict: judge the final files once more.
      const verdict = await runSandboxedTests(root, task.tests, limits, controller.signal);
      if (verdict.timedOut && controller.signal.aborted) timedOut = true;
      passed = verdict.passed;
      changed = !sameFiles(await snapshotWorkspace(root, limits), task.files);
    }
  } catch {
    errored = true;
  } finally {
    clearTimeout(timer);
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
  let failure: CodingEvalFailure = null;
  if (!passed) {
    if (timedOut) failure = "timeout";
    else if (errored) failure = "error";
    else if (steps >= limits.maxSteps && lastFinishReason === "tool-calls") failure = "step_limit";
    else if (!changed) failure = "no_change";
    else failure = "tests_failed";
  }
  return {
    taskId: task.id,
    difficulty: task.difficulty,
    modelId: model.id,
    passed,
    steps,
    durationMs: Date.now() - startedAt,
    inputTokens,
    outputTokens,
    failure,
  };
}

export type RunCodingEvalInput = {
  tasks: readonly CodingEvalTask[];
  models: readonly AiModel[];
  callModel?: CodingEvalModelFactory;
  /**
   * Checked before every task starts. Return false to stop dispatching (budget
   * spent, cycle cancelled). A task already running is not interrupted.
   */
  shouldContinue: () => boolean | Promise<boolean>;
  /** Called after each finished task, e.g. to record cost as it accrues. */
  onResult?: (result: CodingEvalResult) => void | Promise<void>;
  /** 1 or 2; anything else is clamped into that range. Default 1. */
  concurrency?: number;
  limits?: Partial<CodingEvalLimits>;
};

/**
 * Runs every task for every model (task-major: all models on a task before the
 * next task, so a stop leaves the comparison balanced). Results come back in
 * dispatch order; tasks never started because `shouldContinue` returned false
 * are absent.
 */
export async function runCodingEval(input: RunCodingEvalInput): Promise<CodingEvalResult[]> {
  const jobs = input.tasks.flatMap((task) => input.models.map((model) => ({ task, model })));
  const results: (CodingEvalResult | undefined)[] = new Array(jobs.length).fill(undefined);
  const concurrency = Math.min(2, Math.max(1, Math.trunc(input.concurrency ?? 1) || 1));
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      if (next >= jobs.length) return;
      if (!(await input.shouldContinue())) {
        stopped = true;
        return;
      }
      // `next` is re-read after the await: another worker may have taken the slot.
      const index = next++;
      if (index >= jobs.length) return;
      const result = await runCodingEvalTask({
        ...jobs[index],
        callModel: input.callModel,
        limits: input.limits,
      });
      results[index] = result;
      await input.onResult?.(result);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.filter((result): result is CodingEvalResult => result !== undefined);
}
