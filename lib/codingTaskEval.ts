import "server-only";

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { AiModel } from "@/lib/models";
import {
  CODING_EVAL_FRAME_PREFIX,
  CODING_EVAL_LIMITS,
  CODING_EVAL_RUNNER_FILE,
  CODING_EVAL_RUNNER_SOURCE,
  buildRunnerCases,
  checkSandboxWrite,
  codingEvalSystemPrompt,
  formatCodingEvalReport,
  judgeCodingEvalCases,
  keepTail,
  parseRunnerOutput,
  resolveSandboxPath,
  type CodingEvalCase,
  type CodingEvalCaseVerdict,
  type CodingEvalFailure,
  type CodingEvalLimits,
  type CodingEvalResult,
  type CodingEvalTask,
} from "@/lib/codingTaskEvalCore";

/**
 * Real-task coding evaluation: a model gets a small JavaScript project and four
 * tools (list_files, read_file, write_file, run_tests), works like an agent,
 * and the harness then runs the task's hidden cases to decide pass or fail.
 *
 * This is a PAID call path (every task is up to `maxSteps` model calls; see
 * codingEvalWorstCaseTokens for the bound). The caller owns the budget: pass
 * `shouldContinue` to runCodingEval and stop dispatching when it is spent.
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
 *
 * The verdict cannot be forged by the model's code. The expected values never
 * enter the child; the parent compares what a trusted runner reports (see
 * lib/codingTaskEvalCore.ts). A module that prints fake results, calls
 * process.exit, or even learns the one-time token has nothing to forge with.
 */

export type CodingEvalModelFactory = (model: AiModel) => LanguageModel | Promise<LanguageModel>;

export type SandboxCasesResult = {
  /** Every case passed and the run itself was sound. */
  passed: boolean;
  /** Per-case verdicts, in case order. Empty when `problem` is set. */
  verdicts: CodingEvalCaseVerdict[];
  /** Why the run produced no verdicts (timeout, crash, bad frame, import error), or null. */
  problem: string | null;
  /** Non-frame output the module printed (console.log, stderr), tail only, workspace path masked. */
  logs: string;
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
    SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows",
  } as unknown as NodeJS.ProcessEnv;
}

function maskWorkspace(text: string, dirs: readonly string[]): string {
  let masked = text;
  for (const dir of dirs) {
    const forms = new Set([
      dir,
      dir.replaceAll("\\", "\\\\"),
      dir.replaceAll("\\", "/"),
      encodeURI(dir.replaceAll("\\", "/")),
    ]);
    for (const form of forms) masked = masked.replaceAll(form, "<workspace>");
  }
  return masked;
}

export type RunSandboxedCasesOptions = {
  limits?: Pick<CodingEvalLimits, "testTimeoutMs" | "testOutputMaxChars">;
  signal?: AbortSignal;
  /** Test hook: the frame token. Real runs use a fresh random one. */
  token?: string;
};

/**
 * Runs `cases` against the workspace's src/index.mjs in the permission-
 * restricted child process and judges the reported values in this process.
 *
 * Only the trusted runner file executes at the top level of the child. It
 * receives the one-time token and the calls (arguments only) on stdin, imports
 * the model's module, runs the calls and writes the values back in one frame.
 * The frame is accepted only if it carries the token and is the only such
 * line. The runner file is removed afterwards.
 */
export async function runSandboxedCases(
  dir: string,
  cases: readonly CodingEvalCase[],
  options: RunSandboxedCasesOptions = {},
): Promise<SandboxCasesResult> {
  const limits = options.limits || CODING_EVAL_LIMITS;
  const realDir = await realpath(dir);
  const runnerFile = join(realDir, CODING_EVAL_RUNNER_FILE);
  const token = options.token || randomBytes(16).toString("hex");
  await writeFile(runnerFile, CODING_EVAL_RUNNER_SOURCE, "utf8");
  try {
    const raw = await new Promise<{ stdout: string; stderr: string; timedOut: boolean; exitCode: number | null }>(
      (resolve) => {
        const args = ["--permission", `--allow-fs-read=${realDir}`, "--max-old-space-size=256", CODING_EVAL_RUNNER_FILE];
        const child = spawn(process.execPath, args, {
          cwd: realDir,
          env: sandboxEnvironment(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        // Keep the end of each stream: the frame is the last thing written.
        const keep = 1024 * 1024;
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (stdout.length > keep * 2) stdout = stdout.slice(stdout.length - keep);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
          if (stderr.length > 64 * 1024) stderr = stderr.slice(stderr.length - 32 * 1024);
        });
        const stop = () => {
          timedOut = true;
          child.kill("SIGKILL");
        };
        const timer = setTimeout(stop, limits.testTimeoutMs);
        const onAbort = () => stop();
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          resolve({ stdout, stderr, timedOut, exitCode });
        };
        child.on("error", (error) => {
          stderr += `\nfailed to start the runner: ${error.message}`;
          finish(null);
        });
        child.on("close", (code) => finish(code));
        // The child may exit before reading all of stdin (an early process.exit).
        child.stdin.on("error", () => undefined);
        child.stdin.end(`${token}\n${JSON.stringify({ cases: buildRunnerCases(cases) })}`);
      },
    );
    const clean = (text: string) => maskWorkspace(text, [realDir, dir]).replace(ANSI, "");
    const parsed = parseRunnerOutput(raw.stdout, token);
    const logLines = raw.stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith(CODING_EVAL_FRAME_PREFIX));
    const logs = keepTail(clean([...logLines, raw.stderr].join("\n").trim()), limits.testOutputMaxChars);
    if (raw.timedOut) {
      return { passed: false, verdicts: [], problem: "timeout", logs, timedOut: true, exitCode: raw.exitCode };
    }
    if ("problem" in parsed) {
      return { passed: false, verdicts: [], problem: parsed.problem, logs, timedOut: false, exitCode: raw.exitCode };
    }
    const judgement = judgeCodingEvalCases(cases, parsed.frame);
    return {
      passed: judgement.passed,
      verdicts: judgement.verdicts,
      problem: judgement.problem,
      logs,
      timedOut: false,
      exitCode: raw.exitCode,
    };
  } finally {
    await rm(runnerFile, { force: true });
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
      else if (entry.isFile() && relative !== CODING_EVAL_RUNNER_FILE) found.push(relative);
    }
  };
  await walk("", 1);
  return found;
}

async function workspaceFileSizes(root: string, limits: CodingEvalLimits): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const relative of await listWorkspaceFiles(root, limits)) {
    const path = resolveSandboxPath(root, relative, limits);
    if (path) sizes.set(relative, (await stat(path)).size);
  }
  return sizes;
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
 * model can correct itself without burning the run. Everything a tool returns
 * counts against `maxToolOutputBytes` for the task; once that is spent every
 * tool answers with a short refusal.
 */
/** More than write_file's answer ({ ok, bytes } or a refusal) ever takes. */
const MUTATION_ANSWER_MAX_BYTES = 512;

export function createCodingEvalTools(
  root: string,
  task: Pick<CodingEvalTask, "examples">,
  limits: CodingEvalLimits = CODING_EVAL_LIMITS,
  signal?: AbortSignal,
) {
  let testRuns = 0;
  let outputBytes = 0;
  // Tool calls of one step may run at once; they run one after another here,
  // so a size or count check and the write it guards cannot interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const metered = <T extends object>(produce: () => Promise<T>, mutates = false): Promise<T | { error: string }> => {
    const run = queue.then(() => meteredNow(produce, mutates));
    queue = run.catch(() => undefined);
    return run;
  };
  const meteredNow = async <T extends object>(
    produce: () => Promise<T>,
    mutates = false,
  ): Promise<T | { error: string }> => {
    if (outputBytes >= limits.maxToolOutputBytes) return { error: "tool output budget exhausted" };
    // A call that changes the workspace runs only when its short answer still
    // fits, so a change is never made behind an "exhausted" answer.
    if (mutates && outputBytes + MUTATION_ANSWER_MAX_BYTES > limits.maxToolOutputBytes) {
      return { error: "tool output budget exhausted" };
    }
    const result = await produce();
    const size = Buffer.byteLength(JSON.stringify(result));
    if (outputBytes + size > limits.maxToolOutputBytes) {
      outputBytes = limits.maxToolOutputBytes;
      return { error: "tool output budget exhausted" };
    }
    outputBytes += size;
    return result;
  };
  const invalidPath = { error: "invalid path: use a short relative path inside the project, like src/index.mjs" };
  return {
    list_files: tool({
      description: "List every file in the project, with its size in bytes.",
      inputSchema: z.object({}),
      execute: () =>
        metered(async () => {
          const sizes = await workspaceFileSizes(root, limits);
          return { files: [...sizes].map(([path, bytes]) => ({ path, bytes })) };
        }),
    }),
    read_file: tool({
      description: "Read one project file as text. The path is relative to the project root, for example src/index.mjs.",
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path }) =>
        metered(async () => {
          const resolved = resolveSandboxPath(root, path, limits);
          if (!resolved) return invalidPath;
          try {
            return { content: await readFile(resolved, "utf8") };
          } catch {
            return { error: "file not found" };
          }
        }),
    }),
    write_file: tool({
      description:
        "Create or overwrite one project file with the full new content. The path is relative to the project root.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: ({ path, content }) =>
        metered(async () => {
          const resolved = resolveSandboxPath(root, path, limits);
          if (!resolved) return invalidPath;
          const sizes = await workspaceFileSizes(root, limits);
          const normalized = path.replace(/^(\.\/)+/, "");
          const total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
          const refusal = checkSandboxWrite(
            {
              fileCount: sizes.size,
              isNewFile: !sizes.has(normalized),
              otherBytes: total - (sizes.get(normalized) || 0),
              content,
            },
            limits,
          );
          if (refusal) return { error: refusal };
          await mkdir(dirname(resolved), { recursive: true });
          await writeFile(resolved, content, "utf8");
          return { ok: true, bytes: Buffer.byteLength(content) };
        }, true),
    }),
    run_tests: tool({
      description:
        "Run the example checks against the project. Returns whether they pass and, for failures, the input, the expected value and the actual value. The final grade also uses further hidden checks.",
      inputSchema: z.object({}),
      execute: () =>
        metered(async () => {
          if (testRuns >= limits.maxTestRunsPerTask) {
            return { error: `run_tests is limited to ${limits.maxTestRunsPerTask} calls per task` };
          }
          testRuns += 1;
          const run = await runSandboxedCases(root, task.examples, { limits, signal });
          const report = formatCodingEvalReport(task.examples, {
            passed: run.passed,
            problem: run.problem,
            verdicts: run.verdicts,
          });
          const output = run.logs && !run.passed ? `${report}\n\nconsole output:\n${run.logs}` : report;
          return {
            passed: run.passed,
            timedOut: run.timedOut,
            examples: task.examples.length,
            output: keepTail(output, limits.testOutputMaxChars),
          };
        }),
    }),
  };
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
 *
 * Cost is counted conservatively: no retries (each task makes at most
 * `maxSteps` calls), and `usageUnknown` is set when a step reported no usage or
 * the task ended in error or timeout, so the caller can charge the worst case.
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
  let missingUsage = false;
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
      const languageModel = await (input.callModel || defaultCallModel)(model);
      await generateText({
        model: languageModel,
        system: codingEvalSystemPrompt(limits.maxSteps),
        prompt: task.prompt,
        tools: createCodingEvalTools(root, task, limits, controller.signal),
        stopWhen: stepCountIs(limits.maxSteps),
        maxOutputTokens: limits.maxOutputTokensPerStep,
        maxRetries: 0,
        abortSignal: controller.signal,
        onStepEnd: (step) => {
          steps += 1;
          // Each step's count must be a finite non-negative number: one that is
          // not makes the run's usage unknown, so a bad count can never cancel
          // a real one into a total that looks confirmed.
          const stepInput = step.usage.inputTokens;
          const stepOutput = step.usage.outputTokens;
          if (typeof stepInput === "number" && Number.isFinite(stepInput) && stepInput >= 0) inputTokens += stepInput;
          else missingUsage = true;
          if (typeof stepOutput === "number" && Number.isFinite(stepOutput) && stepOutput >= 0) outputTokens += stepOutput;
          else missingUsage = true;
          lastFinishReason = step.finishReason;
        },
      });
    } catch {
      if (controller.signal.aborted) timedOut = true;
      else errored = true;
    }
    if (!timedOut && !errored) {
      // The model's own run_tests calls are not the verdict: judge the final files on the hidden cases.
      const verdict = await runSandboxedCases(root, task.hidden, { limits, signal: controller.signal });
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
    usageUnknown: missingUsage || errored || timedOut || steps === 0,
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
  const concurrency = Math.min(2, Math.max(1, Math.trunc(input.concurrency || 1) || 1));
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
