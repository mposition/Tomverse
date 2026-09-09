// Runs the author–reviewer exchange for one task, or packages a change for an
// independent reviewer to read.
//
// Modes:
//   --mode=mock     scripted executors from --fixture; the whole loop, offline.
//   --mode=dry-run  the command-line executors are built and never run; the
//                   outcome is `failed` with `author_not_executed`, and the
//                   record shows the exact commands that would have run.
//   --mode=package  no executor at all: takes the diff of --base..HEAD (or
//                   the worktree), computes the digest, runs --test-command if
//                   given, and writes the exchange record and the reviewer
//                   prompt for a person to hand to the reviewer. Generated
//                   files can be left out of the diff with --diff-exclude=.
//   --mode=live     runs the command-line executors. Refused unless
//                   --i-have-authorised-live-execution is also given, because
//                   a live run spends and edits.
//
// Usage:
//   node --import tsx scripts/cross-review.mjs --task=<task.json> --mode=mock \
//     --fixture=<fixture.json> --out=<dir> [--author=claude] [--reviewer=codex] \
//     [--max-revisions=2] [--test-command="npm test -- x"]
//
// task.json: { taskId, requirement, completionCriteria[], baseCommit, writableScope[] }
// fixture.json (mock): { author: AuthorOutput[] , reviewer: ReviewVerdict[] , tests?: TestRun[][] }
//   A reviewer entry may carry reviewedDigest "@current" to mean the digest
//   of the change it is shown; anything else is compared literally.
//
// Nothing here pushes, merges, or dispatches a workflow. A test command runs
// locally, once per round, and its exit status is the test result.

import { createHash } from "node:crypto";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_MAX_REVISIONS,
  renderReviewPrompt,
  runCrossReview,
} from "../lib/crossReviewCore.ts";
import {
  CLI_INVOCATIONS,
  cliAuthor,
  cliReviewer,
  mockAuthor,
  mockReviewer,
} from "../lib/crossReviewExecutors.ts";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length > 0 ? rest.join("=") : "true"];
  })
);
const flag = (name, fallback) => args.get(name) ?? fallback;
const die = (message) => {
  console.error(message);
  process.exit(1);
};

const mode = flag("mode", "mock");
if (!["mock", "dry-run", "package", "live"].includes(mode)) die("--mode must be mock, dry-run, package or live.");
const taskPath = flag("task");
if (!taskPath) die("--task=<task.json> is required.");
const task = JSON.parse(readFileSync(taskPath, "utf8"));
for (const field of ["taskId", "requirement", "completionCriteria", "baseCommit", "writableScope"]) {
  if (task[field] === undefined) die(`${taskPath} has no ${field}.`);
}
const outDir = flag("out", `artifacts/cross-review/${task.taskId}`);
const maxRevisions = Number.parseInt(flag("max-revisions", String(DEFAULT_MAX_REVISIONS)), 10);
if (!Number.isInteger(maxRevisions) || maxRevisions < 0) die("--max-revisions must be a non-negative integer.");
const roles = { author: flag("author", "claude"), reviewer: flag("reviewer", "codex") };
const testCommand = args.get("test-command") ?? null;
const timeoutMs = Number.parseInt(flag("timeout-ms", String(10 * 60 * 1000)), 10);

const digest = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

const runTestCommand = () => {
  if (!testCommand) return [];
  const startedAt = Date.now();
  try {
    const output = execFileSync("sh", ["-c", testCommand], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return [{ command: testCommand, passed: true, output: output.trim().split("\n").slice(-5).join("\n"), durationMs: Date.now() - startedAt }];
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim().split("\n").slice(-10).join("\n");
    return [{ command: testCommand, passed: false, output, durationMs: Date.now() - startedAt }];
  }
};

mkdirSync(outDir, { recursive: true });
const write = (name, contents) => {
  const path = join(outDir, name);
  writeFileSync(path, contents);
  console.error(`written ${path}`);
};

if (mode === "package") {
  const base = flag("base", task.baseCommit);
  // Generated files can be left out of the reviewed diff with
  // --diff-exclude=<path> (repeatable); they still count as files changed.
  const excluded = process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--diff-exclude="))
    .map((arg) => `:(exclude)${arg.slice("--diff-exclude=".length)}`);
  const pathspec = [...(task.writableScope.length > 0 ? task.writableScope : ["."]), ...excluded];
  const diff = execFileSync("git", ["diff", base, "--", ...pathspec], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const filesChanged = execFileSync("git", ["diff", "--name-only", base, "--", ...(task.writableScope.length > 0 ? task.writableScope : ["."])], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
  const changeDigest = digest(diff);
  const testResults = runTestCommand();
  const summary = flag("summary", "(no summary supplied; the diff is the record)");
  const request = {
    task,
    round: 0,
    changeDigest,
    commit: dirty ? null : commit,
    diff,
    testResults,
    guardViolations: [],
    authorSummary: summary,
    authorSelfAssessment: null,
    previousFindings: [],
  };
  const exchange = {
    version: "cross-review-v1",
    taskId: task.taskId,
    requirement: task.requirement,
    completionCriteria: task.completionCriteria,
    baseCommit: base,
    roles,
    maxRevisions,
    rounds: [],
    changeDigest,
    commit: dirty ? null : commit,
    headCommit: commit,
    worktreeDirty: dirty,
    changeSummary: summary,
    filesChanged,
    testResults,
    reviewConclusion: null,
    findings: [],
    nextAction: `hand review-prompt.md to the ${roles.reviewer} reviewer; its verdict must name digest ${changeDigest}`,
    status: "awaiting_review",
    failure: null,
    holdReason: null,
    producedAt: new Date().toISOString(),
  };
  write("exchange.json", `${JSON.stringify(exchange, null, 2)}\n`);
  write("review-prompt.md", renderReviewPrompt(request));
  write("change.diff", diff);
  console.log(`packaged ${task.taskId}: ${filesChanged.length} file(s), digest ${changeDigest}, ${testResults.length} test command(s)${testResults.every((t) => t.passed) ? "" : " (FAILING)"}`);
  process.exit(0);
}

let author;
let reviewer;
if (mode === "mock") {
  const fixturePath = flag("fixture");
  if (!fixturePath) die("--fixture=<fixture.json> is required in mock mode.");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  author = mockAuthor(roles.author, (fixture.author ?? []).map((entry) => ("ok" in entry ? entry : { ok: true, value: entry })));
  reviewer = mockReviewer(roles.reviewer, (fixture.reviewer ?? []).map((entry) => ("ok" in entry ? entry : { ok: true, value: entry })));
  var fixtureTests = fixture.tests ?? null;
} else {
  if (mode === "live" && flag("i-have-authorised-live-execution", "false") !== "true") {
    die("--mode=live runs external tools that edit and spend. Pass --i-have-authorised-live-execution to confirm.");
  }
  const spawner = async (command, cliArgs, options) =>
    new Promise((resolve) => {
      const child = nodeSpawn(command, cliArgs, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) } });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ status: null, stdout, stderr, error });
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr, timedOut });
      });
      child.stdin.end(options.input);
    });
  const build = (role, id) => {
    const invocation = CLI_INVOCATIONS[id]?.[role];
    if (!invocation) die(`no command-line invocation is recorded for ${id} as ${role}; known: ${Object.keys(CLI_INVOCATIONS).join(", ")}`);
    return {
      id,
      invocation,
      mode: mode === "live" ? "live" : "dry-run",
      cwd: process.cwd(),
      timeoutMs,
      spawn: mode === "live" ? spawner : undefined,
    };
  };
  author = cliAuthor(build("author", roles.author));
  reviewer = cliReviewer(build("reviewer", roles.reviewer));
}

let round = 0;
const outcome = await runCrossReview({
  task,
  roles,
  author,
  reviewer,
  digest,
  maxRevisions,
  timeoutMs,
  runTests: async () => {
    const fromFixture = typeof fixtureTests !== "undefined" && fixtureTests ? fixtureTests[round] ?? [] : [];
    round += 1;
    return testCommand ? runTestCommand() : fromFixture;
  },
});

write("exchange.json", `${JSON.stringify(outcome.exchange, null, 2)}\n`);
const last = outcome.exchange.rounds[outcome.exchange.rounds.length - 1];
if (last) {
  write(
    "review-prompt.md",
    renderReviewPrompt({
      task,
      round: last.round,
      changeDigest: last.changeDigest,
      commit: last.commit,
      diff: "(see exchange.json rounds[].changeDigest; the diff is held by the author executor)",
      testResults: last.testResults,
      guardViolations: last.guardViolations,
      authorSummary: last.changeSummary,
      authorSelfAssessment: null,
      previousFindings: [],
    })
  );
}
console.log(
  `${task.taskId}: ${outcome.status}${outcome.failure ? ` (${outcome.failure})` : ""}${outcome.holdReason ? ` (${outcome.holdReason})` : ""} after ${outcome.exchange.rounds.length} round(s) — ${outcome.exchange.nextAction}`
);
process.exit(outcome.status === "passed" ? 0 : 2);
