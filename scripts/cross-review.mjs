// Runs the author–reviewer exchange for one task, packages a change for an
// independent reviewer to read, checks the reviewer's environment, or runs
// only the reviewer on such a package.
//
// Modes:
//   --mode=mock      scripted executors from --fixture; the whole loop, offline.
//   --mode=dry-run   the command-line executors are built and never run; the
//                    outcome is `failed` with `author_not_executed`, and the
//                    record shows the exact commands that would have run.
//   --mode=package   no executor at all: takes the diff of the task's base
//                    commit (or --base) against HEAD or the worktree as round
//                    --round (default: the next round), computes the digest,
//                    runs --test-command and every --guard-command, and writes
//                    the package for that round plus the reviewer prompt.
//   --mode=preflight runs the reviewer's own invocation on a prompt that is
//                    not a review: read the HEAD commit, then try to write a
//                    probe file with one shell command naming its path. Passes
//                    only when the read matched what this script knows, the
//                    probe did not land, and the tool's own output shows the
//                    write at that path being refused. The call, its command,
//                    its usage, the evidence and its result are recorded under
//                    --out as preflight-<stamp>.json. Refused unless
//                    --i-have-authorised-live-execution is given; without it
//                    the exact command is shown.
//   --mode=review    runs only the reviewer, on the package of --round
//                    (default: the latest packaged round). The prompt is
//                    rebuilt from the stored package, the verdict is written as
//                    verdict-round<N>.json, and exchange.json becomes the
//                    control program's replay of every round so far. Refused
//                    unless --i-have-authorised-live-execution is given;
//                    without it the reviewer is built in dry-run and the exact
//                    command is shown. Also refused, so a paid review is not
//                    started in a state that cannot pass: when the package's
//                    tests or guards failed (override:
//                    --review-despite-check-failures) and when the newest
//                    preflight for the same sandbox signature is not a pass
//                    under the current rule -- none, failed, or judged under
//                    an older rule (override: --skip-preflight). An override
//                    is a person's decision and is recorded with the verdict.
//   --mode=live      runs both command-line executors in the loop. Refused
//                    unless --i-have-authorised-live-execution is also given,
//                    because a live run spends and edits. The diff of record
//                    is the working tree's diff against the base after the
//                    author ran -- not the diff the author returned, which is
//                    recorded only as its claim.
//
// What the package refuses, so a record can be trusted:
//   - a change outside the task's writableScope anywhere in the tree -- a
//     tracked file changed against the base, or an untracked file -- not just
//     in the scoped diff.
//   - an untracked file the diff would not show, unless it lies under a
//     --diff-exclude path.
//   - a --diff-exclude path that, resolved to one spelling (`..` and `.`
//     included), is not exactly one of the task's `generatedPaths` or exactly
//     the package's own --out directory. A parent of the package directory, a
//     file under it, a path above the repository and any scoped source are
//     refused by name (lib/crossReviewCore.ts, packageExclusionProblems). An
//     excluded generated file still counts as changed; its content digest --
//     or its absence -- is recorded, and a review refuses to run if it
//     changed, appeared or disappeared since packaging.
//   - round N > 0 unless the control program's replay of rounds 0..N-1 is
//     `awaiting_revision`. After `passed`, `on_hold` or `failed` the exchange
//     has concluded; a further change is a new task or a new --out.
//   - a second verdict on a round that has one.
//   - a review of a package the working tree does not match: the tree's diff
//     against the base, scoped and excluded as the package was, must digest
//     to the package's digest.
//
// A task that continues a concluded exchange names it in `supersedes`. The
// package of round 0 then records the lineage and the findings the prior
// exchange left open, and the reviewer of round 0 is shown them as the
// previous findings. Only an exchange on hold or failed can be continued, and
// the chain is capped (MAX_SUPERSESSIONS), so a new task is not a way to
// reset the revision cap (lib/crossReviewCore.ts, supersessionProblems).
//
// Codex executors:
//   --codex-config=<key=value>  repeatable; passed as `-c key=value`. A
//                   reviewer accepts only REVIEWER_CONFIG_OVERRIDE_KEYS. Give
//                   the value without quotes (`model=gpt-5.6-sol`).
//   --codex-auth=login|env      default `login`: OPENAI_API_KEY and
//                   CODEX_API_KEY are dropped from the child environment so
//                   codex uses its stored login; `env` leaves them in place.
//   --codex-shell=default|windows-powershell
//                   `windows-powershell` drops the app-execution-alias
//                   directory (…\Microsoft\WindowsApps) from the child's PATH,
//                   so `pwsh` -- the Store-installed PowerShell 7, whose
//                   WindowsApps ACLs deny the sandbox's restricted token --
//                   resolves to nothing and codex falls back to Windows
//                   PowerShell in System32. Part of the sandbox signature;
//                   recorded in the preflight and the verdict.
//
// Checks the control program applies (lib/crossReviewCore.ts): a pass needs at
// least one passing test run and at least one guard rule run with every rule
// passing. Nothing run is a failed check.
//   --test-command=<sh>   the test run, once per round; exit status decides.
//   --guard-command=<sh>  repeatable; each is a guard rule, recorded with its
//                         result; a non-zero exit is a failed rule.
//
// --max-revisions may lower the fixed cap (MAX_REVISIONS, 2) for a run and
// cannot raise it.
//
// task.json: { taskId, requirement, completionCriteria[], baseCommit, writableScope[],
//              generatedPaths?[], supersedes?: { taskId, exchange } }
// fixture.json (mock): { author: AuthorOutput[], reviewer: ReviewVerdict[], tests?: TestRun[][], guards?: GuardRun[][] }
//
// Package layout under --out: package-round<N>.json, change-round<N>.diff,
// verdict-round<N>.json, review-round<N>.events.jsonl, preflight-<stamp>.json,
// review-prompt.md and change.diff (latest round), exchange.json (the record).
//
// Nothing here pushes, merges, or dispatches a workflow.

import { createHash } from "node:crypto";
import { execFileSync, execSync, spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_REVISIONS,
  PREFLIGHT_RECORD_VERSION,
  inheritedFindings,
  judgePreflight,
  lineageOf,
  normalizeRepoPath,
  packageExclusionProblems,
  preflightGate,
  preflightReportProblems,
  renderPreflightPrompt,
  renderReviewPrompt,
  replayExchange,
  resolveMaxRevisions,
  runCrossReview,
  supersessionProblems,
  writeRefusalEvidence,
} from "../lib/crossReviewCore.ts";
import {
  CLI_INVOCATIONS,
  REVIEWER_CONFIG_OVERRIDE_KEYS,
  cliAuthor,
  cliCommandLine,
  cliProbe,
  cliReviewer,
  extractUsage,
  mockAuthor,
  mockReviewer,
} from "../lib/crossReviewExecutors.ts";

const argv = process.argv.slice(2);
const args = new Map(
  argv.map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length > 0 ? rest.join("=") : "true"];
  })
);
const flag = (name, fallback) => args.get(name) ?? fallback;
const repeated = (name) => argv.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));
const die = (message) => {
  console.error(message);
  process.exit(1);
};

const mode = flag("mode", "mock");
if (!["mock", "dry-run", "package", "preflight", "review", "live"].includes(mode)) {
  die("--mode must be mock, dry-run, package, preflight, review or live.");
}
const taskPath = flag("task");
if (!taskPath) die("--task=<task.json> is required.");
const task = JSON.parse(readFileSync(taskPath, "utf8"));
for (const field of ["taskId", "requirement", "completionCriteria", "baseCommit", "writableScope"]) {
  if (task[field] === undefined) die(`${taskPath} has no ${field}.`);
}
// Every path that is compared, digested or handed to git is normalised once
// here (forward slashes, no trailing slash), so a Windows spelling and a
// POSIX spelling of the same file cannot pass one check and miss another.
const generatedPaths = (task.generatedPaths ?? []).map(normalizeRepoPath);
const outDir = flag("out", `artifacts/cross-review/${task.taskId}`);
let maxRevisions;
try {
  maxRevisions = resolveMaxRevisions(args.has("max-revisions") ? Number(flag("max-revisions")) : undefined);
} catch (error) {
  die(`--max-revisions: ${error.message} (the cap is fixed at ${MAX_REVISIONS}; a run may only lower it).`);
}
const roles = { author: flag("author", "claude"), reviewer: flag("reviewer", "codex") };
const testCommand = args.get("test-command") ?? null;
const guardCommands = repeated("guard-command");
const timeoutMs = Number.parseInt(flag("timeout-ms", String(10 * 60 * 1000)), 10);
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) die("--timeout-ms must be a positive integer.");
const authorised = flag("i-have-authorised-live-execution", "false") === "true";
const codexConfig = repeated("codex-config");
const codexAuth = flag("codex-auth", "login");
if (!["login", "env"].includes(codexAuth)) die("--codex-auth must be login or env.");
const codexShell = flag("codex-shell", "default");
if (!["default", "windows-powershell"].includes(codexShell)) die("--codex-shell must be default or windows-powershell.");
// Node drops an environment entry whose value is undefined, so these remove
// the keys from the child rather than setting them to a string.
const codexEnv = {
  ...(codexAuth === "login" ? { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined } : {}),
  // The Windows sandbox starts its shell under a restricted token, and the
  // Store-installed PowerShell 7 lives under WindowsApps, whose ACLs deny
  // such a token (codex's own source says as much: "Windows can deny direct
  // starts of internal executables under WindowsApps"). With the
  // app-execution-alias directory out of the child's PATH, `pwsh` resolves
  // to nothing and codex falls back to Windows PowerShell in System32. The
  // adjustment is explicit, recorded, and part of the sandbox signature.
  ...(codexShell === "windows-powershell" ? windowsPowerShellPath() : {}),
};
function windowsPowerShellPath() {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH");
  if (!key) return {};
  const entries = process.env[key].split(";");
  const kept = entries.filter((entry) => !/[\\/]microsoft[\\/]windowsapps[\\/]?\s*$/i.test(entry));
  return { [key]: kept.join(";") };
}

const digest = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const digestFile = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// ---------------------------------------------------------------------------
// Commands the control program runs: the test command and the guard commands.

const runCommand = (command) => {
  const startedAt = Date.now();
  try {
    const output = execFileSync("sh", ["-c", command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { passed: true, output: output.trim().split("\n").slice(-5).join("\n"), durationMs: Date.now() - startedAt };
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim().split("\n").slice(-10).join("\n");
    return { passed: false, output, durationMs: Date.now() - startedAt };
  }
};
const runTestCommand = () => (testCommand ? [{ command: testCommand, ...runCommand(testCommand) }] : []);
/** Every --guard-command, run once, as the guard runs the control program records. */
const runGuardCommands = () =>
  guardCommands.map((command) => {
    const run = runCommand(command);
    return { rule: command, passed: run.passed, detail: run.output.slice(-400), durationMs: run.durationMs };
  });

// ---------------------------------------------------------------------------
// The working tree, as git sees it. The scope check reads all of it.

const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const gitLines = (...gitArgs) =>
  git(...gitArgs)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const under = (file, path) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`);
const inScope = (file) => task.writableScope.length === 0 || task.writableScope.some((scope) => under(file, scope));
/** Tracked files changed against the base (index and worktree), and every untracked file. */
const treeChanges = (base) => {
  const tracked = gitLines("diff", "--name-only", base);
  const untracked = gitLines("status", "--porcelain", "--untracked-files=all")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(2).trim());
  return { tracked: [...new Set(tracked)].sort(), untracked: [...new Set(untracked)].sort() };
};
const scopePathspec = () => (task.writableScope.length > 0 ? task.writableScope : ["."]);
const scopedDiff = (base, excluded) => git("diff", base, "--", ...scopePathspec(), ...excluded.map((path) => `:(exclude)${path}`));
/**
 * What an excluded path is at this moment: its content digest, a digest
 * over a directory's files, or "absent". Recorded at packaging and checked
 * at review, so an exclusion cannot hide a later change, and a file that
 * did not exist when packaged is seen if it exists at review.
 */
const snapshot = (path) => {
  if (!existsSync(path)) return "absent";
  const stat = statSync(path);
  if (stat.isFile()) return digestFile(path);
  if (!stat.isDirectory()) return "other";
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const entry = join(dir, name);
      const entryStat = statSync(entry);
      if (entryStat.isDirectory()) walk(entry);
      else if (entryStat.isFile()) hash.update(`${entry.replace(/\\/g, "/")}\n${digestFile(entry)}\n`);
    }
  };
  walk(path);
  return `tree:${hash.digest("hex")}`;
};
const excludedSnapshots = (excluded) => Object.fromEntries(excluded.map((path) => [path, snapshot(path)]));

mkdirSync(outDir, { recursive: true });
const write = (name, contents) => {
  const path = join(outDir, name);
  writeFileSync(path, contents);
  console.error(`written ${path}`);
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// ---------------------------------------------------------------------------
// The exchange this task continues, when it names one.

const supersededExchange = () => {
  if (!task.supersedes) return null;
  if (!existsSync(task.supersedes.exchange)) return null;
  const prior = readJson(task.supersedes.exchange);
  return { taskId: prior.taskId, status: prior.status, findings: prior.findings ?? [], lineage: prior.lineage ?? [] };
};
const continuation = () => {
  const prior = supersededExchange();
  const problems = supersessionProblems(task, prior);
  if (problems.length > 0) die(`refusing to continue ${task.supersedes?.taskId ?? "(no exchange)"}: ${problems.join("; ")}`);
  if (!prior) return { lineage: [], inherited: [] };
  return { lineage: lineageOf(prior), inherited: inheritedFindings(prior) };
};

// ---------------------------------------------------------------------------
// The package of a round, and the control program's reading of the rounds.

const packageFile = (round) => join(outDir, `package-round${round}.json`);
const verdictFile = (round) => join(outDir, `verdict-round${round}.json`);
const packagedRounds = () =>
  (existsSync(outDir) ? readdirSync(outDir) : [])
    .map((name) => /^package-round(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);

const loadRound = (round) => {
  if (!existsSync(packageFile(round))) die(`no package for round ${round} under ${outDir}.`);
  const pkg = readJson(packageFile(round));
  if (typeof pkg.diff !== "string") die(`${packageFile(round)} carries no diff.`);
  if (digest(pkg.diff) !== pkg.changeDigest) die(`${packageFile(round)}: the diff no longer digests to ${pkg.changeDigest}; the package was altered.`);
  if (pkg.taskId !== task.taskId) die(`${packageFile(round)} is for task ${pkg.taskId}, not ${task.taskId}.`);
  const verdict = existsSync(verdictFile(round)) ? readJson(verdictFile(round)).verdict : null;
  return { round, pkg, verdict };
};

const loadRounds = (upTo) => {
  const rounds = [];
  for (let round = 0; round <= upTo; round += 1) {
    rounds.push(loadRound(round));
    if (round < upTo && !rounds[round].verdict) die(`round ${round} has no verdict, so round ${upTo} cannot exist yet.`);
  }
  return rounds;
};

const replay = async (rounds) => {
  const latest = rounds[rounds.length - 1];
  const exchange = await replayExchange({
    task,
    roles,
    maxRevisions,
    digest,
    rounds: rounds.map((entry) => ({
      round: entry.round,
      diff: entry.pkg.diff,
      summary: entry.pkg.changeSummary,
      filesChanged: entry.pkg.filesChanged,
      commit: entry.pkg.commit,
      testResults: entry.pkg.testResults,
      guardRuns: entry.pkg.guardRuns ?? [],
      verdict: entry.verdict,
    })),
  });
  if (exchange.concludedAtRound !== null && exchange.concludedAtRound < rounds.length - 1) {
    console.error(`note: the control program concluded at round ${exchange.concludedAtRound}; packages after it are not part of the record.`);
  }
  return {
    ...exchange,
    lineage: rounds[0].pkg.lineage ?? [],
    inheritedFindings: rounds[0].pkg.inheritedFindings ?? [],
    headCommit: latest.pkg.headCommit,
    worktreeDirty: latest.pkg.worktreeDirty,
    filesChanged: latest.pkg.filesChanged,
  };
};

/** Why round N cannot be packaged or reviewed now, or null when it can. */
const refusalToContinue = (state, nextRound) => {
  if (state.status === "awaiting_revision") return null;
  if (state.status === "awaiting_review") return `round ${nextRound - 1} awaits its verdict; review it before round ${nextRound}.`;
  return `the exchange concluded as ${state.status}${state.holdReason ? ` (${state.holdReason})` : ""}${state.failure ? ` (${state.failure})` : ""} at round ${state.concludedAtRound}; a further change is a new task or a new --out.`;
};

/** What the reviewer of round N is shown as the previous findings, and from where. */
const previousFindingsFor = (rounds, round) => {
  if (round > 0) return { previousFindings: rounds[round - 1].verdict.findings, previousFindingsFrom: undefined };
  const inherited = rounds[0].pkg.inheritedFindings ?? [];
  return {
    previousFindings: inherited,
    previousFindingsFrom: inherited.length > 0 ? `the superseded exchange ${task.supersedes?.taskId ?? "(unknown)"}, left open there` : undefined,
  };
};

// ---------------------------------------------------------------------------
// The spawner for live runs, and the command-line executors.

const SAFE_ARG = /^[A-Za-z0-9_.,=:@+\/-]+$/;
const killTree = (child) => {
  if (process.platform === "win32") {
    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
};
let lastSpawn = null;
const spawner = async (command, cliArgs, options) =>
  new Promise((resolve) => {
    // On Windows the tools are npm `.cmd` shims, which Node refuses to spawn
    // without a shell; a shell gets an argument list it cannot mangle, or
    // nothing at all.
    const shell = process.platform === "win32";
    const unsafe = shell ? cliArgs.filter((arg) => !SAFE_ARG.test(arg)) : [];
    if (unsafe.length > 0) {
      resolve({ status: null, stdout: "", stderr: "", error: new Error(`refusing to pass through a shell: ${unsafe.join(" ")}`) });
      return;
    }
    const child = nodeSpawn(command, cliArgs, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, shell, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      lastSpawn = { command, args: cliArgs, stdout, stderr, status: null, timedOut, error: error.message };
      resolve({ status: null, stdout, stderr, error });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      lastSpawn = { command, args: cliArgs, stdout, stderr, status, timedOut, error: null };
      resolve({ status, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {
      // the child closed stdin early; its exit status says what happened
    });
    child.stdin.end(options.input);
  });

const buildCli = (role, id, executorMode) => {
  const invocation = CLI_INVOCATIONS[id]?.[role];
  if (!invocation) die(`no command-line invocation is recorded for ${id} as ${role}; known: ${Object.keys(CLI_INVOCATIONS).join(", ")}`);
  const codex = id === "codex";
  return {
    id,
    invocation,
    mode: executorMode,
    cwd: process.cwd(),
    timeoutMs,
    spawn: executorMode === "live" ? spawner : undefined,
    configOverrides: codex ? codexConfig : undefined,
    env: codex ? codexEnv : undefined,
  };
};

/** The reviewer's full command line, or a refusal. */
const reviewerCommandLine = (options) => {
  const line = cliCommandLine(options.invocation, options.configOverrides ?? [], REVIEWER_CONFIG_OVERRIDE_KEYS);
  if (!line.ok) die(line.detail);
  return line.args;
};

/**
 * What a preflight proves for: the command, its arguments with the model
 * choice taken out (a different model in the same sandbox is the same
 * environment), and the directory. A review matches on this.
 */
const sandboxSignature = (options, lineArgs) => {
  const args = [];
  for (let i = 0; i < lineArgs.length; i += 1) {
    if (lineArgs[i] === "-c" && /^(model|model_reasoning_effort)=/.test(lineArgs[i + 1] ?? "")) {
      i += 1;
      continue;
    }
    args.push(lineArgs[i]);
  }
  return `${options.invocation.command} ${args.join(" ")} @ ${options.cwd} shell:${codexShell}`;
};

const toolVersion = (command) => {
  try {
    return execSync(`${command} --version`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return null;
  }
};

/**
 * In live mode the author changes the tree; the tree is the change. The
 * diff of record is git's, over the whole tree, so the digest binds what
 * exists and an out-of-scope edit surfaces as a scope violation. What the
 * author returned is kept as its claim, next to its self-assessment.
 */
const treeBackedAuthor = (executor) => ({
  id: executor.id,
  produce: async (request) => {
    const produced = await executor.produce(request);
    if (!produced.ok) return produced;
    const tree = treeChanges(task.baseCommit);
    const diff = git("diff", task.baseCommit);
    const claimed = produced.value;
    const claim = `author-claimed diff digest ${digest(claimed.diff)} over ${claimed.filesChanged.length} file(s); the tree's diff digests to ${digest(diff)}${
      digest(claimed.diff) === digest(diff) ? " (identical)" : " (DIFFERS)"
    }`;
    return {
      ok: true,
      value: {
        diff,
        summary: claimed.summary,
        filesChanged: [...tree.tracked, ...tree.untracked],
        selfAssessment: claimed.selfAssessment ? `${claimed.selfAssessment}\n${claim}` : claim,
        commit: claimed.commit ?? null,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// package: the change of one round, for a reviewer to read.

if (mode === "package") {
  const packaged = packagedRounds();
  const round = Number.parseInt(flag("round", String(packaged.length)), 10);
  if (!Number.isInteger(round) || round < 0) die("--round must be a non-negative integer.");
  if (existsSync(packageFile(round)) && existsSync(verdictFile(round))) {
    die(`round ${round} is packaged and reviewed; a revised change is round ${round + 1}.`);
  }
  let previous = [];
  if (round > 0) {
    previous = loadRounds(round - 1);
    if (!previous[round - 1].verdict) die(`round ${round - 1} has no verdict yet; review it before packaging round ${round}.`);
    const refusal = refusalToContinue(await replay(previous), round);
    if (refusal) die(`refusing to package round ${round}: ${refusal}`);
  }
  // A continuation is checked at round 0, where it starts; later rounds
  // carry what round 0 recorded.
  const { lineage, inherited } = round === 0 ? continuation() : { lineage: previous[0].pkg.lineage ?? [], inherited: previous[0].pkg.inheritedFindings ?? [] };
  const base = flag("base", task.baseCommit);

  // What the reviewer does not see was fixed before the exchange: only the
  // task's generated paths and this package's own directory may be excluded.
  const diffExcluded = repeated("diff-exclude").map(normalizeRepoPath);
  const exclusionProblems = packageExclusionProblems({ excluded: diffExcluded, generatedPaths, outDir, writableScope: task.writableScope });
  if (exclusionProblems.length > 0) die(`refusing to package: ${exclusionProblems.join("; ")}`);
  const isExcluded = (file) => diffExcluded.some((path) => under(normalizeRepoPath(file), path));

  // The whole tree, not the scoped diff, decides whether the change stayed
  // inside the scope. An untracked file the diff would not show is refused
  // too, unless it lies under a --diff-exclude path.
  const tree = treeChanges(base);
  const outside = [...tree.tracked, ...tree.untracked].filter((file) => !inScope(file));
  if (outside.length > 0) die(`refusing to package: changed outside the writable scope: ${outside.join(", ")}`);
  const unseen = tree.untracked.filter((file) => !isExcluded(file));
  if (unseen.length > 0) {
    die(`refusing to package: untracked file(s) the diff would not show: ${unseen.join(", ")}. Add them, remove them, or declare them with --diff-exclude.`);
  }

  const diff = scopedDiff(base, diffExcluded);
  const filesChanged = gitLines("diff", "--name-only", base, "--", ...scopePathspec());
  const commit = git("rev-parse", "HEAD").trim();
  const dirty = git("status", "--porcelain").trim() !== "";
  const changeDigest = digest(diff);
  const testResults = runTestCommand();
  const guardRuns = runGuardCommands();
  const guardViolations = guardRuns.filter((run) => !run.passed).map((run) => `${run.rule}: ${run.detail}`);
  const summary = flag("summary", "(no summary supplied; the diff is the record)");
  const pkg = {
    version: "cross-review-package-v4",
    taskId: task.taskId,
    round,
    baseCommit: base,
    lineage,
    inheritedFindings: inherited,
    changeDigest,
    commit: dirty ? null : commit,
    headCommit: commit,
    worktreeDirty: dirty,
    changeSummary: summary,
    filesChanged,
    treeFilesChanged: tree.tracked,
    diffExcluded,
    excludedDigests: excludedSnapshots(diffExcluded.filter((path) => generatedPaths.includes(path))),
    testResults,
    guardCommands,
    guardRuns,
    producedAt: new Date().toISOString(),
    diff,
  };
  write(`package-round${round}.json`, `${JSON.stringify(pkg, null, 2)}\n`);
  write(`change-round${round}.diff`, diff);
  write("change.diff", diff);
  const rounds = [...previous, { round, pkg, verdict: null }];
  write(
    "review-prompt.md",
    renderReviewPrompt({
      task,
      round,
      changeDigest,
      commit: pkg.commit,
      diff,
      testResults,
      guardRuns,
      guardViolations,
      authorSummary: summary,
      authorSelfAssessment: null,
      ...previousFindingsFor(rounds, round),
    })
  );
  const exchange = await replay(rounds);
  write("exchange.json", `${JSON.stringify(exchange, null, 2)}\n`);
  const checks = [...testResults, ...guardRuns];
  console.log(
    `packaged ${task.taskId} round ${round}: ${filesChanged.length} file(s), digest ${changeDigest}, ${testResults.length} test command(s), ${guardRuns.length} guard rule(s)${checks.every((t) => t.passed) && checks.length > 0 ? "" : " (CHECKS NOT PASSING)"}${lineage.length > 0 ? `, continues ${lineage.join(" > ")} with ${inherited.length} inherited finding(s)` : ""} — ${exchange.status}`
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// preflight: the reviewer's environment, before a review is paid for.

if (mode === "preflight") {
  const options = buildCli("reviewer", roles.reviewer, authorised ? "live" : "dry-run");
  const lineArgs = reviewerCommandLine(options);
  const head = git("rev-parse", "HEAD").trim();
  const probeName = `preflight-write-probe-${stamp()}.txt`;
  const probePath = join(outDir, probeName).replace(/\\/g, "/");
  const prompt = renderPreflightPrompt({ readCommand: "git rev-parse HEAD", probePath });
  const signature = sandboxSignature(options, lineArgs);
  console.error(`preflight command: ${[options.invocation.command, ...lineArgs].join(" ")} (prompt on stdin, cwd ${options.cwd}, timeout ${timeoutMs}ms, codex auth: ${codexAuth})`);
  console.error(`sandbox signature: ${signature}`);
  const startedAt = new Date();
  const result = await cliProbe(options).run(prompt, preflightReportProblems);
  const durationMs = Date.now() - startedAt.getTime();
  if (!authorised) {
    console.log(`${task.taskId} preflight: ${result.failure} — ${result.detail}`);
    process.exit(2);
  }
  const probeExists = existsSync(probePath);
  if (probeExists) {
    // Evidence recorded below; the tree is left as it was.
    unlinkSync(probePath);
  }
  // The tool's own output, naming the probe path, is the evidence for the
  // refusal -- not the reviewer's account of it, and not a refusal of
  // something else.
  const evidence = writeRefusalEvidence(lastSpawn?.stdout ?? "", lastSpawn?.stderr ?? "", probePath);
  const writeRefusalObserved = evidence !== null;
  const judged = result.ok
    ? judgePreflight({ report: result.value, expectedReadOutput: head, probeExists, writeRefusalObserved })
    : { passed: false, problems: [`the reviewer returned no usable report: ${result.failure} — ${result.detail}`, ...(probeExists ? ["the write probe landed"] : [])] };
  const record = {
    version: PREFLIGHT_RECORD_VERSION,
    taskId: task.taskId,
    reviewer: roles.reviewer,
    toolVersion: toolVersion(options.invocation.command),
    command: [options.invocation.command, ...lineArgs],
    cwd: options.cwd,
    sandboxSignature: signature,
    codexShell,
    codexAuth,
    expectedReadOutput: head,
    probePath,
    probeLanded: probeExists,
    writeRefusalObserved,
    writeRefusalEvidence: evidence,
    startedAt: startedAt.toISOString(),
    durationMs,
    usage: extractUsage(lastSpawn?.stdout ?? ""),
    exitStatus: lastSpawn?.status ?? null,
    report: result.ok ? result.value : null,
    executorFailure: result.ok ? null : { failure: result.failure, detail: result.detail },
    passed: judged.passed,
    problems: judged.problems,
  };
  const name = `preflight-${stamp()}`;
  write(`${name}.json`, `${JSON.stringify(record, null, 2)}\n`);
  if (lastSpawn?.stdout) write(`${name}.events.jsonl`, lastSpawn.stdout);
  if (lastSpawn?.stderr) write(`${name}.stderr.txt`, lastSpawn.stderr);
  console.log(`${task.taskId} preflight: ${judged.passed ? "PASSED" : "FAILED"}${judged.problems.length > 0 ? ` — ${judged.problems.join("; ")}` : ""}`);
  process.exit(judged.passed ? 0 : 2);
}

/** Every preflight recorded under --out, as the gate reads them. */
const preflightRecords = () =>
  (existsSync(outDir) ? readdirSync(outDir) : [])
    .filter((name) => /^preflight-.*\.json$/.test(name))
    .map((name) => ({ name, ...readJson(join(outDir, name)) }));

// ---------------------------------------------------------------------------
// review: only the reviewer, on a packaged round.

if (mode === "review") {
  const packaged = packagedRounds();
  if (packaged.length === 0) die(`nothing is packaged under ${outDir}; run --mode=package first.`);
  const round = Number.parseInt(flag("round", String(packaged[packaged.length - 1])), 10);
  if (!Number.isInteger(round) || round < 0) die("--round must be a non-negative integer.");
  const rounds = loadRounds(round);
  const current = rounds[round];
  if (current.verdict) die(`${verdictFile(round)} already exists; a new review needs a new package with a new digest.`);
  if (round > 0) {
    const refusal = refusalToContinue(await replay(rounds.slice(0, round)), round);
    if (refusal) die(`refusing to review round ${round}: ${refusal}`);
  }
  // The reviewer reads the tree it is run in and is told which change it is
  // reading. The two have to be the same change: the tree's diff against
  // the base, scoped and excluded exactly as the package was, must digest to
  // what the package says, and every excluded file must still be what the
  // package recorded.
  const liveDiff = scopedDiff(current.pkg.baseCommit, current.pkg.diffExcluded ?? []);
  if (digest(liveDiff) !== current.pkg.changeDigest) {
    die(
      `the working tree is not the packaged change: its diff against ${current.pkg.baseCommit} digests to ${digest(liveDiff)}, ` +
        `the package to ${current.pkg.changeDigest}. Check out the packaged change, or package again.`
    );
  }
  // Every excluded generated path must be what the package recorded --
  // "absent" included, so a file made after packaging is seen -- and the
  // package must have recorded each of them.
  const recordedSnapshots = current.pkg.excludedDigests ?? {};
  for (const path of (current.pkg.diffExcluded ?? []).filter((entry) => generatedPaths.includes(entry))) {
    if (!(path in recordedSnapshots)) die(`the package recorded no snapshot of the excluded generated path ${path}. Package again.`);
  }
  for (const [path, recorded] of Object.entries(recordedSnapshots)) {
    const now = snapshot(path);
    if (now !== recorded) die(`the excluded file ${path} is not what the package recorded (${now} vs ${recorded}). Package again.`);
  }
  // A paid review is not started in a state that cannot pass, unless a
  // person says so and the record shows it.
  const failedChecks = [
    ...current.pkg.testResults.filter((run) => !run.passed).map((run) => `test failed: ${run.command}`),
    ...(current.pkg.testResults.length === 0 ? ["no test was run"] : []),
    ...(current.pkg.guardRuns ?? []).filter((run) => !run.passed).map((run) => `guard failed: ${run.rule}`),
    ...((current.pkg.guardRuns ?? []).length === 0 ? ["no guard was run"] : []),
  ];
  const overrides = [];
  if (failedChecks.length > 0) {
    if (flag("review-despite-check-failures", "false") !== "true") {
      die(`refusing to review round ${round}: the package's checks did not pass (${failedChecks.join("; ")}). Fix and package again, or pass --review-despite-check-failures to record a person's decision to review anyway.`);
    }
    overrides.push(`review-despite-check-failures: ${failedChecks.join("; ")}`);
  }
  const options = buildCli("reviewer", roles.reviewer, authorised ? "live" : "dry-run");
  const lineArgs = reviewerCommandLine(options);
  const signature = sandboxSignature(options, lineArgs);
  console.error(`sandbox signature: ${signature}`);
  // The newest preflight for this sandbox decides, and it must be a pass
  // under the current rule; an older pass is not picked past a newer failure.
  const gate = preflightGate(preflightRecords(), signature, PREFLIGHT_RECORD_VERSION);
  const preflight = gate.chosen;
  if (!preflight) {
    if (flag("skip-preflight", "false") !== "true") {
      die(`refusing to review round ${round}: ${gate.problems.join("; ")}. Run --mode=preflight first, or pass --skip-preflight to record a person's decision to review without one.`);
    }
    overrides.push(`skip-preflight: ${gate.problems.join("; ")}`);
  }
  const request = {
    task,
    round,
    changeDigest: current.pkg.changeDigest,
    commit: current.pkg.commit,
    diff: current.pkg.diff,
    testResults: current.pkg.testResults,
    guardRuns: current.pkg.guardRuns ?? [],
    guardViolations: (current.pkg.guardRuns ?? []).filter((run) => !run.passed).map((run) => `${run.rule}: ${run.detail}`),
    authorSummary: current.pkg.changeSummary,
    authorSelfAssessment: null,
    ...previousFindingsFor(rounds, round),
  };
  write("review-prompt.md", renderReviewPrompt(request));
  console.error(`reviewer command: ${[options.invocation.command, ...lineArgs].join(" ")} (prompt on stdin, cwd ${options.cwd}, timeout ${timeoutMs}ms, codex auth: ${codexAuth})`);
  if (preflight) console.error(`preflight: ${preflight.name} (${preflight.startedAt})`);
  for (const override of overrides) console.error(`override: ${override}`);
  const startedAt = new Date();
  const result = await cliReviewer(options).review(request);
  const durationMs = Date.now() - startedAt.getTime();
  if (lastSpawn) {
    if (lastSpawn.stdout) write(`review-round${round}.events.jsonl`, lastSpawn.stdout);
    if (lastSpawn.stderr) write(`review-round${round}.stderr.txt`, lastSpawn.stderr);
  }
  if (!result.ok) {
    if (authorised) {
      write(
        `review-round${round}.failure.json`,
        `${JSON.stringify(
          { round, reviewer: roles.reviewer, command: [options.invocation.command, ...lineArgs], preflight: preflight?.name ?? null, overrides, startedAt: startedAt.toISOString(), durationMs, usage: extractUsage(lastSpawn?.stdout ?? ""), failure: result.failure, detail: result.detail },
          null,
          2
        )}\n`
      );
    }
    console.log(`${task.taskId} round ${round}: reviewer ${result.failure} — ${result.detail}`);
    process.exit(2);
  }
  write(
    `verdict-round${round}.json`,
    `${JSON.stringify(
      {
        version: "cross-review-verdict-v2",
        taskId: task.taskId,
        round,
        reviewer: roles.reviewer,
        toolVersion: toolVersion(options.invocation.command),
        command: [options.invocation.command, ...lineArgs],
        sandboxSignature: signature,
        codexShell,
        codexAuth,
        preflight: preflight?.name ?? null,
        overrides,
        startedAt: startedAt.toISOString(),
        durationMs,
        usage: extractUsage(lastSpawn?.stdout ?? ""),
        receivedAt: new Date().toISOString(),
        verdict: result.value,
      },
      null,
      2
    )}\n`
  );
  current.verdict = result.value;
  const exchange = await replay(rounds);
  write("exchange.json", `${JSON.stringify(exchange, null, 2)}\n`);
  console.log(
    `${task.taskId} round ${round}: ${result.value.conclusion} with ${result.value.findings.length} finding(s) — ${exchange.status}${exchange.holdReason ? ` (${exchange.holdReason})` : ""}: ${exchange.nextAction}`
  );
  process.exit(exchange.status === "passed" ? 0 : 2);
}

// ---------------------------------------------------------------------------
// mock, dry-run, live: the whole loop.

let author;
let reviewer;
let fixtureTests = null;
let fixtureGuards = null;
let current = -1;
let guards;
if (mode === "mock") {
  const fixturePath = flag("fixture");
  if (!fixturePath) die("--fixture=<fixture.json> is required in mock mode.");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  author = mockAuthor(roles.author, (fixture.author ?? []).map((entry) => ("ok" in entry ? entry : { ok: true, value: entry })));
  reviewer = mockReviewer(roles.reviewer, (fixture.reviewer ?? []).map((entry) => ("ok" in entry ? entry : { ok: true, value: entry })));
  fixtureTests = fixture.tests ?? null;
  fixtureGuards = fixture.guards ?? null;
  guards = async () => [...(fixtureGuards ? fixtureGuards[current] ?? [] : []), ...runGuardCommands()];
} else {
  if (mode === "live" && !authorised) {
    die("--mode=live runs external tools that edit and spend. Pass --i-have-authorised-live-execution to confirm.");
  }
  const executorMode = mode === "live" ? "live" : "dry-run";
  const cliAuthorExecutor = cliAuthor(buildCli("author", roles.author, executorMode));
  author = mode === "live" ? treeBackedAuthor(cliAuthorExecutor) : cliAuthorExecutor;
  reviewer = cliReviewer(buildCli("reviewer", roles.reviewer, executorMode));
  // One guard rule the loop always runs in live mode: the tree the author
  // left behind holds nothing the diff of record cannot show.
  guards = async () => {
    const tree = treeChanges(task.baseCommit);
    // An untracked file is never in a git diff, so the diff of record cannot
    // show it whatever the author reported.
    const unseen = tree.untracked;
    const treeRule = {
      rule: "the working tree holds nothing the diff cannot show",
      passed: unseen.length === 0,
      detail: unseen.length === 0 ? `${tree.tracked.length} tracked change(s), no untracked file` : `untracked: ${unseen.join(", ")}`,
    };
    return [treeRule, ...runGuardCommands()];
  };
}

const outcome = await runCrossReview({
  task,
  roles,
  author,
  reviewer,
  digest,
  maxRevisions,
  timeoutMs,
  runTests: async () => {
    current += 1;
    const fromFixture = fixtureTests ? fixtureTests[current] ?? [] : [];
    return testCommand ? runTestCommand() : fromFixture;
  },
  guards,
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
      guardRuns: last.guardRuns,
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
