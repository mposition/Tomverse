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
//   - an untracked file the diff would not show, unless it is an exact
//     generated path or an exact canonical control record valid for this
//     package round. The package output directory is never a blanket scope
//     exception.
//   - a --diff-exclude path that, resolved to one spelling (`..` and `.`
//     included), is not exactly one of the task's `generatedPaths` or exactly
//     the package's own --out directory. A parent of the package directory, a
//     file under it, a path above the repository, any scoped source, and a
//     name git would read as a pattern (`*` `?` `[` `]`, a leading `:` `!`
//     `^`) are refused by name (lib/crossReviewCore.ts,
//     packageExclusionProblems); every scope entry and exclusion is handed to
//     git with `:(literal)` magic besides, so a name is never a pattern. An
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
import { execFileSync, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  MAX_REVISIONS,
  PREFLIGHT_RECORD_VERSION,
  inheritedFindings,
  judgePreflight,
  lineageOf,
  normalizeRepoPath,
  packageExclusionProblems,
  packageTreeScopeProblems,
  preflightGate,
  preflightReportProblems,
  reviewVerdictProblems,
  redactCrossReviewDiagnosticText,
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
  claudeSubscriptionAuthProblems,
  completeUtf8Capture,
  decodeCliResult,
  extractUsage,
  mockAuthor,
  mockReviewer,
  sanitizedCliEnvironment,
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
const normalizedOutDir = normalizeRepoPath(outDir);
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

const commandShell = (() => {
  if (process.platform !== "win32") return "sh";
  try {
    // Git for Windows ships the POSIX shell this command contract requires,
    // but its bin directory is not necessarily on PATH in PowerShell/Codex.
    const gitExecPath = execFileSync("git", ["--exec-path"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    const bundled = join(gitExecPath, "..", "..", "..", "bin", "sh.exe");
    if (existsSync(bundled)) return bundled;
  } catch {
    // The command below will fail closed and be recorded as a failed check.
  }
  return "sh";
})();

// ---------------------------------------------------------------------------
// Commands the control program runs: the test command and the guard commands.

const runCommand = (command) => {
  const startedAt = Date.now();
  try {
    const output = execFileSync(commandShell, ["-c", command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { passed: true, output: output.trim().split("\n").slice(-5).join("\n"), durationMs: Date.now() - startedAt };
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim().split("\n").slice(-10).join("\n");
    return { passed: false, output, durationMs: Date.now() - startedAt };
  }
};
const redactTestRun = (run) => ({
  ...run,
  command: redactCrossReviewDiagnosticText(run.command),
  output: redactCrossReviewDiagnosticText(run.output),
});
const redactGuardRun = (run) => ({
  ...run,
  rule: redactCrossReviewDiagnosticText(run.rule),
  detail: redactCrossReviewDiagnosticText(run.detail),
});
const runTestCommand = () => (testCommand ? [redactTestRun({ command: testCommand, ...runCommand(testCommand) })] : []);
/** Every --guard-command, run once, as the guard runs the control program records. */
const runGuardCommands = () =>
  guardCommands.map((command) => {
    const run = runCommand(command);
    const recorded = redactGuardRun({ rule: command, passed: run.passed, detail: run.output, durationMs: run.durationMs });
    return { ...recorded, detail: recorded.detail.slice(-400) };
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
/** Tracked files changed against the base (index and worktree), and every untracked file. */
const treeChanges = (base) => {
  const tracked = gitLines("diff", "--name-only", base);
  const untracked = gitLines("status", "--porcelain", "--untracked-files=all")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(2).trim());
  return { tracked: [...new Set(tracked)].sort(), untracked: [...new Set(untracked)].sort() };
};
// Every pathspec is handed to git literally: a scope entry or an exclusion
// is a name, never a pattern, so a bracketed spelling such as
// `[c]rossReviewCore` names a file that does not exist rather than
// matching the one it patterns.
const literal = (path) => `:(literal)${path}`;
const scopePathspec = () => (task.writableScope.length > 0 ? task.writableScope : ["."]).map(literal);
const scopedDiff = (base, excluded) => git("diff", base, "--", ...scopePathspec(), ...excluded.map((path) => `:(exclude,literal)${path}`));
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

const repositoryRoot = resolve(git("rev-parse", "--show-toplevel").trim());
const repositoryReal = realpathSync(repositoryRoot);
const outputAbsolute = resolve(repositoryRoot, outDir);
const pathKey = (path) => {
  const named = resolve(path);
  return process.platform === "win32" ? named.toLowerCase() : named;
};
const repositoryRelativeOutput = relative(repositoryRoot, outputAbsolute);
if (
  repositoryRelativeOutput === "" ||
  repositoryRelativeOutput === ".." ||
  repositoryRelativeOutput.startsWith(`..${sep}`) ||
  isAbsolute(repositoryRelativeOutput)
) {
  die(`refusing output path outside the repository: ${outDir}`);
}
if (pathKey(repositoryRoot) !== pathKey(repositoryReal)) {
  die(`refusing repository path reached through an alias or reparse point: ${repositoryRoot} -> ${repositoryReal}`);
}

const lstatIfPresent = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};
const assertSafeOutputPath = ({ requireDirectory = false } = {}) => {
  let cursor = repositoryRoot;
  for (const component of repositoryRelativeOutput.split(/[\\/]/u).filter(Boolean)) {
    cursor = join(cursor, component);
    const stat = lstatIfPresent(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`output component is a symbolic link, junction or reparse point: ${cursor}`);
    }
    const real = realpathSync(cursor);
    if (pathKey(real) !== pathKey(cursor)) {
      throw new Error(`output component resolves through an alias or reparse point: ${cursor} -> ${real}`);
    }
    if (pathKey(cursor) !== pathKey(outputAbsolute) && !stat.isDirectory()) {
      throw new Error(`output parent component is not a directory: ${cursor}`);
    }
  }
  if (requireDirectory) {
    const target = lstatIfPresent(outputAbsolute);
    if (!target?.isDirectory() || target.isSymbolicLink()) {
      throw new Error(`output path is not a safe directory: ${outputAbsolute}`);
    }
  }
};
const prepareOutputDirectory = () => {
  assertSafeOutputPath();
  mkdirSync(outputAbsolute, { recursive: true });
  assertSafeOutputPath({ requireDirectory: true });
};
const assertSafeOutputFile = (path) => {
  const absolute = resolve(path);
  const relativeToOutput = relative(outputAbsolute, absolute);
  if (relativeToOutput === "" || relativeToOutput === ".." || relativeToOutput.startsWith(`..${sep}`) || isAbsolute(relativeToOutput)) {
    throw new Error(`output file escapes the package directory: ${path}`);
  }
  assertSafeOutputPath({ requireDirectory: true });
  const stat = lstatIfPresent(absolute);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`output file is not a regular file: ${absolute}`);
  }
  if (stat.nlink !== 1) {
    throw new Error(`output file has ${stat.nlink} hard links, expected exactly one: ${absolute}`);
  }
  const real = realpathSync(absolute);
  if (pathKey(real) !== pathKey(absolute)) {
    throw new Error(`output file resolves through an alias or reparse point: ${absolute} -> ${real}`);
  }
};

try {
  assertSafeOutputPath();
} catch (error) {
  die(`refusing unsafe output path: ${error.message}`);
}
let outputTempSequence = 0;
const sameFileIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
const write = (name, contents) => {
  let temporaryPath = null;
  let temporaryIdentity = null;
  let descriptor = null;
  try {
    prepareOutputDirectory();
    const path = join(outputAbsolute, name);
    assertSafeOutputFile(path);
    outputTempSequence += 1;
    temporaryPath = join(outputAbsolute, `.cross-review-tmp-${process.pid}-${outputTempSequence}-${basename(name)}`);
    descriptor = openSync(temporaryPath, "wx", 0o600);
    temporaryIdentity = lstatSync(temporaryPath);
    if (!temporaryIdentity.isFile() || temporaryIdentity.isSymbolicLink() || temporaryIdentity.nlink !== 1) {
      throw new Error(`exclusive output temporary is not a private regular file: ${temporaryPath}`);
    }
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    // Re-check both the directory chain and the destination immediately
    // before replacement. rename replaces the directory entry; it never
    // opens or writes through the destination inode.
    assertSafeOutputPath({ requireDirectory: true });
    assertSafeOutputFile(path);
    const stillOurs = lstatSync(temporaryPath);
    if (!sameFileIdentity(temporaryIdentity, stillOurs) || stillOurs.nlink !== 1) {
      throw new Error(`exclusive output temporary changed before replacement: ${temporaryPath}`);
    }
    renameSync(temporaryPath, path);
    temporaryPath = null;
    const installed = lstatSync(path);
    if (!sameFileIdentity(temporaryIdentity, installed) || installed.nlink !== 1) {
      throw new Error(`atomic output replacement did not install the private temporary: ${path}`);
    }
    console.error(`written ${join(outDir, name)}`);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The original error remains the reason for refusal.
      }
    }
    if (temporaryPath !== null && temporaryIdentity !== null) {
      try {
        const current = lstatSync(temporaryPath);
        if (sameFileIdentity(temporaryIdentity, current) && current.nlink === 1) unlinkSync(temporaryPath);
      } catch {
        // Never remove a path whose identity we cannot prove is our temp.
      }
    }
    die(`refusing unsafe output write: ${error.message}`);
  }
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeysProblems = (value, expected, label) => {
  if (!isRecord(value)) return [`${label} must be an object`];
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return JSON.stringify(actual) === JSON.stringify(wanted) ? [] : [`${label} keys are ${actual.join(", ")}; expected exactly ${wanted.join(", ")}`];
};
const validIsoTime = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalJson(nested)]));
};
const canonicalEqual = (left, right) => JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
const digestBytes = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const pathEnvironment = (environment) =>
  Object.entries(environment).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
const pathIsInsideRepository = (path) => {
  const fromRepository = relative(repositoryReal, path);
  return fromRepository === "" || (!fromRepository.startsWith(`..${sep}`) && fromRepository !== ".." && !isAbsolute(fromRepository));
};
const testShimAllowed = (environment) => {
  // Integration fixtures cannot manufacture a native executable cheaply.
  // This escape hatch is structurally limited to T-* repositories whose
  // canonical root is under the OS temp directory; a product checkout can
  // never activate it by setting the environment variable alone.
  if (environment.CROSS_REVIEW_TEST_CLI_SHIM !== "1" || !task.taskId.startsWith("T-")) return false;
  const temporaryRoot = realpathSync(tmpdir());
  const fromTemporary = relative(temporaryRoot, repositoryReal);
  return fromTemporary === "" || (!fromTemporary.startsWith(`..${sep}`) && fromTemporary !== ".." && !isAbsolute(fromTemporary));
};
const nativeWindowsCandidates = (command, environment) => {
  const candidates = [];
  if (command === "claude" && environment.USERPROFILE) candidates.push(join(environment.USERPROFILE, ".local", "bin", "claude.exe"));
  if (command === "codex" && environment.LOCALAPPDATA) {
    const root = join(environment.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    if (existsSync(root)) {
      for (const name of readdirSync(root).sort().reverse()) candidates.push(join(root, name, "codex.exe"));
    }
  }
  return candidates;
};
const executableCandidates = (command, environment) => {
  if (isAbsolute(command)) return [command];
  const pathDirectories = pathEnvironment(environment)
    .split(delimiter)
    .filter((entry) => entry !== "" && isAbsolute(entry));
  if (process.platform !== "win32") return pathDirectories.map((entry) => join(entry, command));
  const native = [
    ...nativeWindowsCandidates(command, environment),
    ...pathDirectories.flatMap((entry) => [join(entry, `${command}.exe`), join(entry, `${command}.com`)]),
  ];
  if (!testShimAllowed(environment)) return native;
  return [
    ...pathDirectories.flatMap((entry) => [join(entry, `${command}.cmd`), join(entry, `${command}.bat`)]),
    ...native,
  ];
};
const executableIdentityAt = (path) => {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return null;
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink()) return null;
  const canonical = realpathSync(absolute);
  const after = lstatSync(canonical);
  if (!after.isFile() || after.isSymbolicLink() || pathIsInsideRepository(canonical)) return null;
  const bytes = readFileSync(canonical);
  return { path: canonical, bytes: bytes.length, digest: digestBytes(bytes), kind: extname(canonical).toLowerCase() || "native" };
};
const trustedWindowsSystemExecutable = (name, configuredPath) => {
  const candidate = realpathSync(configuredPath);
  const expectedTail = new RegExp(`^[A-Za-z]:\\\\Windows\\\\System32\\\\${name.replace(".", "\\.")}$`, "iu");
  if (!expectedTail.test(candidate)) throw new Error(`${name} is not the canonical Windows System32 executable: ${candidate}`);
  const identity = executableIdentityAt(candidate);
  if (!identity) throw new Error(`${name} is not a safe executable: ${candidate}`);
  return identity;
};
const trustedCommandProcessorIdentity = (environment) =>
  trustedWindowsSystemExecutable("cmd.exe", environment.ComSpec ?? environment.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe");
const resolveCliExecutable = (command, environment) => {
  const windowsCommandProcessor = process.platform === "win32" ? trustedCommandProcessorIdentity(environment) : null;
  for (const candidate of executableCandidates(command, environment)) {
    const identity = executableIdentityAt(candidate);
    if (identity) {
      return {
        ...identity,
        launcher:
          process.platform === "win32" && [".cmd", ".bat"].includes(identity.kind)
            ? windowsCommandProcessor
            : null,
        terminator:
          process.platform === "win32"
            ? trustedWindowsSystemExecutable("taskkill.exe", join(dirname(windowsCommandProcessor.path), "taskkill.exe"))
            : null,
      };
    }
  }
  die(`cannot resolve ${command} to a canonical executable outside the repository`);
};
const assertCliExecutable = (expected, label) => {
  const current = isRecord(expected) && typeof expected.path === "string" ? executableIdentityAt(expected.path) : null;
  const expectedBase = isRecord(expected)
    ? { path: expected.path, bytes: expected.bytes, digest: expected.digest, kind: expected.kind }
    : null;
  if (!current || !canonicalEqual(current, expectedBase)) {
    throw new Error(`${label} executable identity changed or is unsafe; package again`);
  }
  if (expected.kind === ".cmd" || expected.kind === ".bat") {
    const launcher = isRecord(expected.launcher) && typeof expected.launcher.path === "string" ? executableIdentityAt(expected.launcher.path) : null;
    if (!launcher || !canonicalEqual(launcher, expected.launcher)) {
      throw new Error(`${label} command processor identity changed or is unsafe; package again`);
    }
  } else if (expected.launcher !== null) {
    throw new Error(`${label} native executable must not carry a command processor`);
  }
  if (process.platform === "win32") {
    const terminator = isRecord(expected.terminator) && typeof expected.terminator.path === "string" ? executableIdentityAt(expected.terminator.path) : null;
    if (!terminator || !canonicalEqual(terminator, expected.terminator)) {
      throw new Error(`${label} timeout terminator identity changed or is unsafe; package again`);
    }
  } else if (expected.terminator !== null) {
    throw new Error(`${label} non-Windows executable must not carry a timeout terminator`);
  }
  return expected;
};
const safeWindowsCommand = (command, cliArgs) => {
  const unsafe = cliArgs.filter((arg) => !SAFE_ARG.test(arg));
  if (unsafe.length > 0 || /["%!*?&|<>^()\r\n]/u.test(command)) {
    throw new Error(`refusing unsafe Windows command arguments: ${unsafe.join(" ")}`);
  }
  return `call "${command}" ${cliArgs.join(" ")}`;
};
const syncCli = (executable, cliArgs, options) => {
  assertCliExecutable(executable, "CLI probe");
  if (process.platform === "win32" && [".cmd", ".bat"].includes(executable.kind)) {
    return execFileSync(executable.launcher.path, ["/d", "/s", "/c", safeWindowsCommand(executable.path, cliArgs)], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return execFileSync(executable.path, cliArgs, options);
};
const companionBinding = (name, contents) => {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents ?? "", "utf8");
  if (bytes.length === 0) return null;
  return { name, bytes: bytes.length, digest: digestBytes(bytes) };
};
const companionProblems = (binding, expectedName, label) => {
  if (binding === null) return [];
  const problems = exactKeysProblems(binding, ["name", "bytes", "digest"], label);
  if (!isRecord(binding)) return problems;
  if (binding.name !== expectedName) problems.push(`${label}.name must be ${expectedName}`);
  if (!Number.isInteger(binding.bytes) || binding.bytes < 0) problems.push(`${label}.bytes must be a non-negative integer`);
  if (typeof binding.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(binding.digest)) problems.push(`${label}.digest must be a SHA-256`);
  return problems;
};
const readBoundCompanion = (binding, expectedName, label) => {
  const problems = companionProblems(binding, expectedName, label);
  if (problems.length > 0) die(`invalid ${label}: ${problems.join("; ")}`);
  if (binding === null) return Buffer.alloc(0);
  const path = join(outputAbsolute, binding.name);
  assertSafeOutputFile(path);
  if (!existsSync(path)) die(`invalid ${label}: ${binding.name} is missing`);
  const bytes = readFileSync(path);
  if (bytes.length !== binding.bytes || digestBytes(bytes) !== binding.digest) {
    die(`invalid ${label}: ${binding.name} bytes do not match its binding`);
  }
  return bytes;
};
const recordSandboxSignature = (record) => {
  const args = [];
  for (let index = 1; index < record.command.length; index += 1) {
    if (record.command[index] === "-c" && /^(model|model_reasoning_effort)=/u.test(record.command[index + 1] ?? "")) {
      index += 1;
      continue;
    }
    args.push(record.command[index]);
  }
  return `${record.command[0]} ${args.join(" ")} @ ${record.cwd} shell:${record.codexShell}`;
};
const exactProbeCommandObserved = (stdout, probePath) => {
  const allowed = new Set([
    `Set-Content -LiteralPath '${probePath}' -Value probe`,
    `printf probe > '${probePath}'`,
  ]);
  let count = 0;
  for (const line of stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "item.completed" || !isRecord(event.item)) continue;
    if (event.item.type === "command_execution" && typeof event.item.command === "string" && allowed.has(event.item.command)) count += 1;
  }
  return count === 1;
};
const preflightRecordKeys = [
  "version",
  "taskId",
  "round",
  "changeDigest",
  "headCommit",
  "reviewer",
  "toolVersion",
  "command",
  "cwd",
  "sandboxSignature",
  "codexShell",
  "codexAuth",
  "claudeAuth",
  "expectedReadOutput",
  "probePath",
  "probeLanded",
  "writeRefusalObserved",
  "writeRefusalEvidence",
  "startedAt",
  "durationMs",
  "usage",
  "exitStatus",
  "report",
  "executorFailure",
  "passed",
  "problems",
  "companions",
];
const validatePreflightRecord = (name, record, expected, { requirePassing = true } = {}) => {
  const problems = exactKeysProblems(record, preflightRecordKeys, `preflight ${name}`);
  if (!isRecord(record)) die(`invalid preflight ${name}: ${problems.join("; ")}`);
  if (record.version !== PREFLIGHT_RECORD_VERSION) problems.push(`version must be ${PREFLIGHT_RECORD_VERSION}`);
  if (record.taskId !== expected.taskId) problems.push(`taskId must be ${expected.taskId}`);
  if (record.round !== expected.round) problems.push(`round must be ${expected.round}`);
  if (record.changeDigest !== expected.changeDigest) problems.push(`changeDigest must be ${expected.changeDigest}`);
  if (record.headCommit !== expected.headCommit || record.expectedReadOutput !== expected.headCommit) problems.push(`head binding must be ${expected.headCommit}`);
  if (record.reviewer !== roles.reviewer) problems.push(`reviewer must be ${roles.reviewer}`);
  if (typeof record.toolVersion !== "string" || record.toolVersion.trim() === "") problems.push("toolVersion must be a non-empty string");
  if (record.toolVersion !== expected.reviewerContract.toolVersion) problems.push("toolVersion does not match the packaged reviewer tool version");
  if (!Array.isArray(record.command) || record.command.length === 0 || record.command.some((entry) => typeof entry !== "string" || entry === "")) problems.push("command must be a non-empty string array");
  if (typeof record.cwd !== "string" || record.cwd === "") problems.push("cwd must be a non-empty string");
  if (!['default', 'windows-powershell'].includes(record.codexShell)) problems.push("codexShell is unsupported");
  if (!['login', 'env'].includes(record.codexAuth)) problems.push("codexAuth is unsupported");
  if (Array.isArray(record.command) && record.command.length > 0 && typeof record.cwd === "string" && record.sandboxSignature !== recordSandboxSignature(record)) problems.push("sandboxSignature does not match command/cwd/codexShell");
  if (!canonicalEqual(record.command, expected.reviewerContract.command)) problems.push("command does not match the packaged reviewer command");
  if (record.cwd !== expected.reviewerContract.cwd) problems.push("cwd does not match the packaged reviewer cwd");
  if (record.sandboxSignature !== expected.reviewerContract.sandboxSignature) problems.push("sandboxSignature does not match the packaged reviewer sandbox");
  if (record.codexShell !== expected.reviewerContract.codexShell || record.codexAuth !== expected.reviewerContract.codexAuth) problems.push("shell/auth provenance does not match the package");
  if (!canonicalEqual(record.claudeAuth, expected.reviewerContract.claudeAuth)) problems.push("Claude subscription auth provenance does not match the package");
  if (!validIsoTime(record.startedAt)) problems.push("startedAt must be an ISO timestamp");
  if (!Number.isInteger(record.durationMs) || record.durationMs < 0) problems.push("durationMs must be a non-negative integer");
  if (!(record.usage === null || isRecord(record.usage))) problems.push("usage must be an object or null");
  if (typeof record.probeLanded !== "boolean") problems.push("probeLanded must be a boolean");
  if (typeof record.writeRefusalObserved !== "boolean") problems.push("writeRefusalObserved must be a boolean");
  if (typeof record.passed !== "boolean") problems.push("passed must be a boolean");
  if (typeof record.probePath !== "string" || record.probePath === "") problems.push("probePath must be a non-empty string");
  if (!Array.isArray(record.problems) || record.problems.some((entry) => typeof entry !== "string")) problems.push("problems must be a string array");
  const executorSucceeded = record.executorFailure === null;
  if (executorSucceeded) {
    if (record.exitStatus !== 0) problems.push("exitStatus must be 0 when the executor succeeded");
    const reportProblems = preflightReportProblems(record.report);
    problems.push(...reportProblems.map((problem) => `report.${problem}`));
  } else {
    if (!(record.exitStatus === null || Number.isInteger(record.exitStatus))) problems.push("exitStatus must be null or an integer when the executor failed");
    if (record.report !== null) problems.push("report must be null when the executor failed");
    problems.push(...exactKeysProblems(record.executorFailure, ["failure", "detail"], "executorFailure"));
    if (isRecord(record.executorFailure)) {
      if (typeof record.executorFailure.failure !== "string" || record.executorFailure.failure.trim() === "") problems.push("executorFailure.failure must be a non-empty string");
      if (typeof record.executorFailure.detail !== "string" || record.executorFailure.detail.trim() === "") problems.push("executorFailure.detail must be a non-empty string");
    }
  }
  if (!isRecord(record.companions)) problems.push("companions must be an object");
  else {
    problems.push(...exactKeysProblems(record.companions, ["events", "stderr"], "preflight companions"));
    problems.push(...companionProblems(record.companions.events, `${name.replace(/\.json$/u, "")}.events.jsonl`, "preflight companions.events"));
    problems.push(...companionProblems(record.companions.stderr, `${name.replace(/\.json$/u, "")}.stderr.txt`, "preflight companions.stderr"));
  }
  if (problems.length > 0) die(`invalid preflight ${name}: ${problems.join("; ")}`);
  const stdout = readBoundCompanion(record.companions.events, `${name.replace(/\.json$/u, "")}.events.jsonl`, "preflight companions.events").toString("utf8");
  const stderr = readBoundCompanion(record.companions.stderr, `${name.replace(/\.json$/u, "")}.stderr.txt`, "preflight companions.stderr").toString("utf8");
  if (!canonicalEqual(record.usage, extractUsage(stdout))) die(`invalid preflight ${name}: usage does not match the bound raw events`);
  const evidence = writeRefusalEvidence(stdout, stderr, record.probePath, record.cwd);
  if (record.writeRefusalEvidence !== evidence || record.writeRefusalObserved !== (evidence !== null)) die(`invalid preflight ${name}: refusal evidence does not match bound companions`);
  if (!executorSucceeded) {
    if (record.exitStatus === 0) {
      const decodedFailure = decodeCliResult(record.reviewer, stdout, preflightReportProblems);
      if (decodedFailure.ok || !canonicalEqual(record.executorFailure, { failure: decodedFailure.failure, detail: decodedFailure.detail })) {
        die(`invalid preflight ${name}: a zero-exit executor failure does not match the bound raw events`);
      }
    }
    const expectedProblems = [
      `the reviewer returned no usable report: ${record.executorFailure.failure} \u2014 ${record.executorFailure.detail}`,
      ...(record.probeLanded ? ["the write probe landed"] : []),
    ];
    if (record.passed !== false || !canonicalEqual(record.problems, expectedProblems)) {
      die(`invalid preflight ${name}: stored executor failure judgement is inconsistent`);
    }
    if (requirePassing) die(`invalid preflight ${name}: referenced preflight did not pass (${expectedProblems.join("; ")})`);
    return record;
  }
  const decoded = decodeCliResult(record.reviewer, stdout, preflightReportProblems);
  if (!decoded.ok) die(`invalid preflight ${name}: bound raw events do not decode to one report (${decoded.failure}: ${decoded.detail})`);
  if (!canonicalEqual(decoded.value, record.report)) die(`invalid preflight ${name}: bound raw report does not match record.report`);
  if (!exactProbeCommandObserved(stdout, record.probePath)) die(`invalid preflight ${name}: bound raw events carry no single exact probe refusal command`);
  const judged = judgePreflight({ report: record.report, expectedReadOutput: expected.headCommit, probeExists: record.probeLanded, writeRefusalObserved: evidence !== null });
  if (record.passed !== judged.passed || JSON.stringify(record.problems) !== JSON.stringify(judged.problems)) die(`invalid preflight ${name}: stored judgement does not match the current preflight rule`);
  if (requirePassing && !judged.passed) die(`invalid preflight ${name}: referenced preflight did not pass (${judged.problems.join("; ")})`);
  return record;
};
const verdictRecordKeys = [
  "version",
  "taskId",
  "round",
  "reviewer",
  "toolVersion",
  "command",
  "cwd",
  "sandboxSignature",
  "codexShell",
  "codexAuth",
  "claudeAuth",
  "preflight",
  "overrides",
  "startedAt",
  "durationMs",
  "usage",
  "receivedAt",
  "companions",
  "verdict",
];
const validateVerdictRecord = (round, pkg, record) => {
  const problems = exactKeysProblems(record, verdictRecordKeys, `verdict round ${round}`);
  if (!isRecord(record)) die(`invalid verdict round ${round}: ${problems.join("; ")}`);
  if (record.version !== "cross-review-verdict-v3") problems.push("version must be cross-review-verdict-v3");
  if (record.taskId !== task.taskId) problems.push(`taskId must be ${task.taskId}`);
  if (record.round !== round) problems.push(`round must be ${round}`);
  if (record.reviewer !== roles.reviewer) problems.push(`reviewer must be ${roles.reviewer}`);
  if (typeof record.toolVersion !== "string" || record.toolVersion.trim() === "") problems.push("toolVersion must be a non-empty string");
  if (record.toolVersion !== pkg.reviewerContract.toolVersion) problems.push("toolVersion does not match the packaged reviewer tool version");
  if (!Array.isArray(record.command) || record.command.length === 0 || record.command.some((entry) => typeof entry !== "string" || entry === "")) problems.push("command must be a non-empty string array");
  if (typeof record.cwd !== "string" || record.cwd === "") problems.push("cwd must be a non-empty string");
  if (!['default', 'windows-powershell'].includes(record.codexShell)) problems.push("codexShell is unsupported");
  if (!['login', 'env'].includes(record.codexAuth)) problems.push("codexAuth is unsupported");
  if (Array.isArray(record.command) && record.command.length > 0 && typeof record.cwd === "string" && record.sandboxSignature !== recordSandboxSignature(record)) problems.push("sandboxSignature does not match command/cwd/codexShell");
  if (!canonicalEqual(record.command, pkg.reviewerContract.command)) problems.push("command does not match the packaged reviewer command");
  if (record.cwd !== pkg.reviewerContract.cwd) problems.push("cwd does not match the packaged reviewer cwd");
  if (record.sandboxSignature !== pkg.reviewerContract.sandboxSignature) problems.push("sandboxSignature does not match the packaged reviewer sandbox");
  if (record.codexShell !== pkg.reviewerContract.codexShell || record.codexAuth !== pkg.reviewerContract.codexAuth) problems.push("shell/auth provenance does not match the package");
  if (!canonicalEqual(record.claudeAuth, pkg.reviewerContract.claudeAuth)) problems.push("Claude subscription auth provenance does not match the package");
  if (!(record.preflight === null || (typeof record.preflight === "string" && /^preflight-[A-Za-z0-9._-]+\.json$/u.test(record.preflight)))) problems.push("preflight must be null or an exact preflight record name");
  if (!Array.isArray(record.overrides) || record.overrides.some((entry) => typeof entry !== "string")) problems.push("overrides must be a string array");
  if (!validIsoTime(record.startedAt) || !validIsoTime(record.receivedAt)) problems.push("startedAt and receivedAt must be ISO timestamps");
  else if (Date.parse(record.receivedAt) < Date.parse(record.startedAt)) problems.push("receivedAt must not precede startedAt");
  if (!Number.isInteger(record.durationMs) || record.durationMs < 0) problems.push("durationMs must be a non-negative integer");
  if (!(record.usage === null || isRecord(record.usage))) problems.push("usage must be an object or null");
  problems.push(...reviewVerdictProblems(record.verdict));
  if (isRecord(record.verdict)) {
    if (record.verdict.taskId !== task.taskId) problems.push("inner verdict taskId does not match the task");
    if (record.verdict.round !== round) problems.push("inner verdict round does not match the wrapper");
    if (record.verdict.reviewedDigest !== pkg.changeDigest) problems.push("inner verdict digest does not match the package");
  }
  if (!isRecord(record.companions)) problems.push("companions must be an object");
  else {
    problems.push(...exactKeysProblems(record.companions, ["events", "stderr"], "verdict companions"));
    problems.push(...companionProblems(record.companions.events, `review-round${round}.events.jsonl`, "verdict companions.events"));
    problems.push(...companionProblems(record.companions.stderr, `review-round${round}.stderr.txt`, "verdict companions.stderr"));
  }
  if (problems.length > 0) die(`invalid verdict round ${round}: ${problems.join("; ")}`);
  const stdout = readBoundCompanion(record.companions.events, `review-round${round}.events.jsonl`, "verdict companions.events").toString("utf8");
  readBoundCompanion(record.companions.stderr, `review-round${round}.stderr.txt`, "verdict companions.stderr");
  if (!canonicalEqual(record.usage, extractUsage(stdout))) die(`invalid verdict round ${round}: usage does not match the bound raw events`);
  const decoded = decodeCliResult(record.reviewer, stdout, reviewVerdictProblems);
  if (!decoded.ok) die(`invalid verdict round ${round}: bound raw events do not decode to one verdict (${decoded.failure}: ${decoded.detail})`);
  if (!canonicalEqual(decoded.value, record.verdict)) die(`invalid verdict round ${round}: bound raw verdict does not match record.verdict`);
  if (record.preflight !== null) {
    const preflightPath = join(outputAbsolute, record.preflight);
    assertSafeOutputFile(preflightPath);
    if (!existsSync(preflightPath)) die(`invalid verdict round ${round}: referenced preflight ${record.preflight} is missing`);
    const preflightRecord = validatePreflightRecord(record.preflight, readJson(preflightPath), {
      taskId: task.taskId,
      round,
      changeDigest: pkg.changeDigest,
      headCommit: pkg.headCommit,
      reviewerContract: pkg.reviewerContract,
    });
    if (
      preflightRecord.sandboxSignature !== record.sandboxSignature ||
      !canonicalEqual(preflightRecord.command, record.command) ||
      preflightRecord.cwd !== record.cwd ||
      preflightRecord.toolVersion !== record.toolVersion ||
      !canonicalEqual(preflightRecord.claudeAuth, record.claudeAuth)
    ) {
      die(`invalid verdict round ${round}: verdict and referenced preflight execution provenance differ`);
    }
  } else if (!record.overrides.some((entry) => entry.startsWith("skip-preflight:"))) {
    die(`invalid verdict round ${round}: no preflight is bound and no skip-preflight override is recorded`);
  }
  return record;
};

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
const outputPath = (name) => normalizeRepoPath(`${normalizedOutDir}/${name}`);
const reviewerContractProblems = (contract) => {
  const problems = exactKeysProblems(
    contract,
    ["reviewer", "executable", "toolVersion", "command", "cwd", "sandboxSignature", "codexShell", "codexAuth", "claudeAuth"],
    "reviewerContract"
  );
  if (!isRecord(contract)) return problems;
  if (contract.reviewer !== roles.reviewer) problems.push(`reviewerContract.reviewer must be ${roles.reviewer}`);
  problems.push(...exactKeysProblems(contract.executable, ["path", "bytes", "digest", "kind", "launcher", "terminator"], "reviewerContract.executable"));
  if (isRecord(contract.executable)) {
    if (typeof contract.executable.path !== "string" || !isAbsolute(contract.executable.path)) problems.push("reviewerContract.executable.path must be absolute");
    if (!Number.isInteger(contract.executable.bytes) || contract.executable.bytes < 1) problems.push("reviewerContract.executable.bytes must be positive");
    if (typeof contract.executable.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(contract.executable.digest)) problems.push("reviewerContract.executable.digest must be a SHA-256");
    if (typeof contract.executable.kind !== "string" || contract.executable.kind === "") problems.push("reviewerContract.executable.kind must be non-empty");
    if ([".cmd", ".bat"].includes(contract.executable.kind)) {
      problems.push(...exactKeysProblems(contract.executable.launcher, ["path", "bytes", "digest", "kind"], "reviewerContract.executable.launcher"));
      if (isRecord(contract.executable.launcher)) {
        if (typeof contract.executable.launcher.path !== "string" || !isAbsolute(contract.executable.launcher.path)) problems.push("reviewerContract.executable.launcher.path must be absolute");
        if (!Number.isInteger(contract.executable.launcher.bytes) || contract.executable.launcher.bytes < 1) problems.push("reviewerContract.executable.launcher.bytes must be positive");
        if (typeof contract.executable.launcher.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(contract.executable.launcher.digest)) problems.push("reviewerContract.executable.launcher.digest must be a SHA-256");
      }
    } else if (contract.executable.launcher !== null) {
      problems.push("reviewerContract.executable.launcher must be null for a native executable");
    }
    if (process.platform === "win32") {
      problems.push(...exactKeysProblems(contract.executable.terminator, ["path", "bytes", "digest", "kind"], "reviewerContract.executable.terminator"));
      if (isRecord(contract.executable.terminator)) {
        if (typeof contract.executable.terminator.path !== "string" || !isAbsolute(contract.executable.terminator.path)) problems.push("reviewerContract.executable.terminator.path must be absolute");
        if (!Number.isInteger(contract.executable.terminator.bytes) || contract.executable.terminator.bytes < 1) problems.push("reviewerContract.executable.terminator.bytes must be positive");
        if (typeof contract.executable.terminator.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(contract.executable.terminator.digest)) problems.push("reviewerContract.executable.terminator.digest must be a SHA-256");
      }
    } else if (contract.executable.terminator !== null) {
      problems.push("reviewerContract.executable.terminator must be null off Windows");
    }
  }
  if (typeof contract.toolVersion !== "string" || contract.toolVersion.trim() === "") problems.push("reviewerContract.toolVersion must be non-empty");
  if (!Array.isArray(contract.command) || contract.command.length === 0 || contract.command.some((entry) => typeof entry !== "string" || entry === "")) problems.push("reviewerContract.command must be a non-empty string array");
  if (typeof contract.cwd !== "string" || contract.cwd === "") problems.push("reviewerContract.cwd must be non-empty");
  if (typeof contract.sandboxSignature !== "string" || contract.sandboxSignature === "") problems.push("reviewerContract.sandboxSignature must be non-empty");
  if (roles.reviewer === "claude") {
    problems.push(...claudeSubscriptionAuthProblems(contract.claudeAuth));
  } else if (contract.claudeAuth !== null) {
    problems.push("reviewerContract.claudeAuth must be null for a non-Claude reviewer");
  }
  return problems;
};
const loadPackage = (round) => {
  if (!existsSync(packageFile(round))) die(`no package for round ${round} under ${outDir}.`);
  const pkg = readJson(packageFile(round));
  if (typeof pkg.diff !== "string") die(`${packageFile(round)} carries no diff.`);
  if (digest(pkg.diff) !== pkg.changeDigest) die(`${packageFile(round)}: the diff no longer digests to ${pkg.changeDigest}; the package was altered.`);
  if (pkg.taskId !== task.taskId || pkg.round !== round) die(`${packageFile(round)} does not bind task ${task.taskId} round ${round}.`);
  if (pkg.version !== "cross-review-package-v5" || !isRecord(pkg.reviewerContract)) {
    die(`${packageFile(round)} does not carry the current cross-review-package-v5 reviewer contract; start a new exchange.`);
  }
  const contractProblems = reviewerContractProblems(pkg.reviewerContract);
  if (contractProblems.length > 0) die(`${packageFile(round)} has an invalid reviewer contract: ${contractProblems.join("; ")}; start a new exchange.`);
  return pkg;
};
const priorRequiredOutputNames = (round) => {
  if (round === 0) return new Set();
  const names = new Set(["change.diff", "review-prompt.md", "exchange.json"]);
  for (let prior = 0; prior < round; prior += 1) {
    names.add(`package-round${prior}.json`);
    names.add(`change-round${prior}.diff`);
    names.add(`verdict-round${prior}.json`);
  }
  return names;
};
const allowedPriorOutputNames = (round) => {
  const names = priorRequiredOutputNames(round);
  for (let prior = 0; prior < round; prior += 1) {
    const verdictPath = verdictFile(prior);
    if (!existsSync(verdictPath)) continue;
    const record = validateVerdictRecord(prior, loadPackage(prior), readJson(verdictPath));
    for (const binding of [record.companions.events, record.companions.stderr]) {
      if (binding !== null) names.add(binding.name);
    }
    if (record.preflight !== null) {
      names.add(record.preflight);
      const preflightRecord = readJson(join(outputAbsolute, record.preflight));
      for (const binding of [preflightRecord.companions.events, preflightRecord.companions.stderr]) {
        if (binding !== null) names.add(binding.name);
      }
    }
  }
  return names;
};
const inspectOutputEntries = () => {
  assertSafeOutputPath();
  if (!existsSync(outputAbsolute)) return [];
  assertSafeOutputPath({ requireDirectory: true });
  return readdirSync(outputAbsolute).sort().map((name) => {
    const path = join(outputAbsolute, name);
    assertSafeOutputFile(path);
    return name;
  });
};
const currentRoundOutputNames = (pkg, label) => {
  const allowed = allowedPriorOutputNames(pkg.round);
  for (const name of [`package-round${pkg.round}.json`, `change-round${pkg.round}.diff`, "change.diff", "review-prompt.md", "exchange.json"]) {
    allowed.add(name);
  }
  const entries = inspectOutputEntries();
  for (const name of entries.filter((entry) => /^preflight-.*\.json$/u.test(entry))) {
    if (allowed.has(name)) continue;
    const record = validatePreflightRecord(
      name,
      readJson(join(outputAbsolute, name)),
      {
        taskId: task.taskId,
        round: pkg.round,
        changeDigest: pkg.changeDigest,
        headCommit: pkg.headCommit,
        reviewerContract: pkg.reviewerContract,
      },
      { requirePassing: false }
    );
    allowed.add(name);
    for (const binding of [record.companions.events, record.companions.stderr]) {
      if (binding !== null) allowed.add(binding.name);
    }
  }
  const currentVerdictName = `verdict-round${pkg.round}.json`;
  if (entries.includes(currentVerdictName)) {
    const verdict = validateVerdictRecord(pkg.round, pkg, readJson(join(outputAbsolute, currentVerdictName)));
    allowed.add(currentVerdictName);
    for (const binding of [verdict.companions.events, verdict.companions.stderr]) {
      if (binding !== null) allowed.add(binding.name);
    }
  }
  const unexpected = entries.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) die(`refusing ${label}: unexpected package output file(s): ${unexpected.join(", ")}`);
  return allowed;
};
const assertPackagedChange = (pkg, label) => {
  const liveDigest = digest(scopedDiff(pkg.baseCommit, pkg.diffExcluded ?? []));
  if (liveDigest !== pkg.changeDigest) {
    die(`refusing ${label}: packaged source diff changed (${liveDigest} vs ${pkg.changeDigest})`);
  }
  for (const [path, recorded] of Object.entries(pkg.excludedDigests ?? {})) {
    const now = snapshot(path);
    if (now !== recorded) die(`refusing ${label}: excluded file ${path} changed (${now} vs ${recorded})`);
  }
  const allowedOutputFiles = [...currentRoundOutputNames(pkg, label)].map(outputPath);
  const tree = treeChanges(pkg.baseCommit);
  const outside = packageTreeScopeProblems({
    ...tree,
    writableScope: task.writableScope,
    allowedOutputFiles,
  });
  if (outside.length > 0) {
    die(`refusing ${label}: tree changed outside the writable scope after packaging: ${outside.join(", ")}`);
  }
  const allowedUntracked = new Set(allowedOutputFiles);
  const generatedExcluded = Object.keys(pkg.excludedDigests ?? {}).map(normalizeRepoPath);
  const unexpectedUntracked = tree.untracked
    .map(normalizeRepoPath)
    .filter((file) => !allowedUntracked.has(file) && !generatedExcluded.some((path) => under(file, path)));
  if (unexpectedUntracked.length > 0) {
    die(`refusing ${label}: untracked file appeared after packaging: ${unexpectedUntracked.join(", ")}`);
  }
};
const validateOutputEntries = ({ allowed, required = allowed, label }) => {
  let entries;
  try {
    entries = inspectOutputEntries();
  } catch (error) {
    die(`refusing unsafe package output while ${label}: ${error.message}`);
  }
  const unexpected = entries.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    die(`refusing package output while ${label}: unexpected file(s): ${unexpected.join(", ")}`);
  }
  const missing = [...required].filter((name) => !entries.includes(name));
  if (missing.length > 0) {
    die(`refusing package output while ${label}: required file(s) missing: ${missing.join(", ")}`);
  }
  return entries;
};
const snapshotOutputRecords = (names) =>
  Object.fromEntries(
    [...names].sort().map((name) => {
      const path = join(outputAbsolute, name);
      assertSafeOutputFile(path);
      if (!existsSync(path)) die(`cannot snapshot missing package record ${name}`);
      const bytes = readFileSync(path);
      return [name, { bytes: bytes.length, digest: digestBytes(bytes) }];
    })
  );
const assertOutputRecordsUnchanged = (recorded, label) => {
  for (const [name, binding] of Object.entries(recorded)) {
    const path = join(outputAbsolute, name);
    assertSafeOutputFile(path);
    if (!existsSync(path)) die(`refusing package while ${label}: prior record ${name} disappeared`);
    const bytes = readFileSync(path);
    if (bytes.length !== binding.bytes || digestBytes(bytes) !== binding.digest) {
      die(`refusing package while ${label}: prior record ${name} changed`);
    }
  }
};
const packagedRounds = () =>
  (existsSync(outDir) ? readdirSync(outDir) : [])
    .map((name) => /^package-round(\d+)\.json$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);

const loadRound = (round) => {
  const pkg = loadPackage(round);
  const verdictRecord = existsSync(verdictFile(round)) ? validateVerdictRecord(round, pkg, readJson(verdictFile(round))) : null;
  return { round, pkg, verdict: verdictRecord?.verdict ?? null };
};

const loadRounds = (upTo) => {
  const rounds = [];
  for (let round = 0; round <= upTo; round += 1) {
    rounds.push(loadRound(round));
    if (round < upTo && !rounds[round].verdict) die(`round ${round} has no verdict, so round ${upTo} cannot exist yet.`);
  }
  return rounds;
};

const validatePriorOutputContents = (rounds, expectedExchangeRounds = rounds.length) => {
  if (rounds.length === 0) return;
  for (const entry of rounds) {
    const recordedDiff = readFileSync(join(outDir, `change-round${entry.round}.diff`), "utf8");
    if (recordedDiff !== entry.pkg.diff) {
      die(`change-round${entry.round}.diff does not match package-round${entry.round}.json`);
    }
  }
  const latest = rounds.at(-1);
  if (readFileSync(join(outDir, "change.diff"), "utf8") !== latest.pkg.diff) {
    die(`change.diff does not match package-round${latest.round}.json`);
  }
  const exchange = readJson(join(outDir, "exchange.json"));
  if (exchange.taskId !== task.taskId || !Array.isArray(exchange.rounds) || exchange.rounds.length !== expectedExchangeRounds) {
    die(`exchange.json does not describe ${task.taskId}'s expected ${expectedExchangeRounds} round(s)`);
  }
  for (const entry of rounds) {
    if (exchange.rounds[entry.round]?.changeDigest !== entry.pkg.changeDigest) {
      die(`exchange.json round ${entry.round} does not match package-round${entry.round}.json`);
    }
  }
};

const replay = async (rounds, producedAt = null) => {
  const latest = rounds[rounds.length - 1];
  const exchange = await replayExchange({
    task,
    roles,
    maxRevisions,
    digest,
    ...(producedAt === null ? {} : { now: () => new Date(producedAt) }),
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
const killTree = (child, executable) => {
  if (process.platform === "win32") {
    try {
      assertCliExecutable(executable, "review timeout");
      const killed = nodeSpawnSync(executable.terminator.path, ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      if (killed.status !== 0 || killed.error) child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    child.kill("SIGKILL");
  }
};
let lastSpawn = null;
const capturedBytes = (spawn, field) => spawn?.[`${field}Bytes`] ?? Buffer.from(spawn?.[field] ?? "", "utf8");
const spawner = async (command, cliArgs, options) =>
  new Promise((resolve) => {
    if (!options.executable || options.executable.path !== command) {
      resolve({ status: null, stdout: "", stderr: "", error: new Error(`refusing an unbound CLI executable`) });
      return;
    }
    try {
      assertCliExecutable(options.executable, "review child");
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    let launchCommand = command;
    let launchArgs = cliArgs;
    if (process.platform === "win32" && [".cmd", ".bat"].includes(options.executable.kind)) {
      try {
        launchCommand = options.executable.launcher.path;
        launchArgs = ["/d", "/s", "/c", safeWindowsCommand(command, cliArgs)];
      } catch (error) {
        resolve({ status: null, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)) });
        return;
      }
    }
    const child = nodeSpawn(launchCommand, launchArgs, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32" && [".cmd", ".bat"].includes(options.executable.kind),
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, options.executable);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    const captured = () => {
      const stdoutCapture = completeUtf8Capture(stdoutChunks);
      const stderrCapture = completeUtf8Capture(stderrChunks);
      return {
        stdoutBytes: stdoutCapture.bytes,
        stderrBytes: stderrCapture.bytes,
        // Human/parser decoding happens once, only after complete byte capture.
        stdout: stdoutCapture.text,
        stderr: stderrCapture.text,
      };
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      const output = captured();
      lastSpawn = { command, args: cliArgs, ...output, status: null, timedOut, error: error.message };
      resolve({ status: null, ...output, error });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      const output = captured();
      lastSpawn = { command, args: cliArgs, ...output, status, timedOut, error: null };
      resolve({ status, ...output, timedOut });
    });
    child.stdin.on("error", () => {
      // the child closed stdin early; its exit status says what happened
    });
    child.stdin.end(options.input);
  });

const buildCli = (role, id, executorMode) => {
  const template = CLI_INVOCATIONS[id]?.[role];
  if (!template) die(`no command-line invocation is recorded for ${id} as ${role}; known: ${Object.keys(CLI_INVOCATIONS).join(", ")}`);
  const codex = id === "codex";
  const environment = sanitizedCliEnvironment(id, process.env, codex ? codexEnv : undefined);
  const executable = resolveCliExecutable(template.command, environment);
  return {
    id,
    invocation: { ...template, command: executable.path },
    executable,
    mode: executorMode,
    cwd: process.cwd(),
    timeoutMs,
    spawn: executorMode === "live" ? (command, cliArgs, options) => spawner(command, cliArgs, { ...options, executable }) : undefined,
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

const toolVersion = (id, executable) => {
  try {
    return syncCli(executable, ["--version"], {
      encoding: "utf8",
      env: sanitizedCliEnvironment(id, process.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";
    console.error(`reviewer version probe failed: ${error instanceof Error ? error.message : String(error)}${stderr ? ` — ${stderr}` : ""}`);
    return null;
  }
};

const claudeAuthProvenance = (id, executable) => {
  if (id !== "claude") return null;
  let status;
  try {
    const stdout = syncCli(executable, ["auth", "status", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: sanitizedCliEnvironment("claude", process.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    status = JSON.parse(stdout);
  } catch (error) {
    die(`cannot verify Claude Code Max first-party login: ${error instanceof Error ? error.message : String(error)}`);
  }
  const problems = claudeSubscriptionAuthProblems(status);
  if (problems.length > 0) die(`refusing Claude API/auth fallback: ${problems.join("; ")}`);
  return {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "max",
  };
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
  try {
    inspectOutputEntries();
  } catch (error) {
    die(`refusing unsafe package output: ${error.message}`);
  }
  const packaged = packagedRounds();
  const round = Number.parseInt(flag("round", String(packaged.length)), 10);
  if (!Number.isInteger(round) || round < 0) die("--round must be a non-negative integer.");
  const allowedPriorNames = allowedPriorOutputNames(round);
  const requiredPriorNames = priorRequiredOutputNames(round);
  validateOutputEntries({
    allowed: allowedPriorNames,
    required: requiredPriorNames,
    label: `preparing round ${round}`,
  });
  if (existsSync(packageFile(round)) && existsSync(verdictFile(round))) {
    die(`round ${round} is packaged and reviewed; a revised change is round ${round + 1}.`);
  }
  let previous = [];
  if (round > 0) {
    previous = loadRounds(round - 1);
    validatePriorOutputContents(previous);
    if (!previous[round - 1].verdict) die(`round ${round - 1} has no verdict yet; review it before packaging round ${round}.`);
    const refusal = refusalToContinue(await replay(previous), round);
    if (refusal) die(`refusing to package round ${round}: ${refusal}`);
  }
  const priorOutputSnapshot = snapshotOutputRecords(allowedPriorNames);
  const immutablePriorNames = new Set([...allowedPriorNames].filter((name) => !["change.diff", "review-prompt.md", "exchange.json"].includes(name)));
  const immutablePriorSnapshot = Object.fromEntries(
    Object.entries(priorOutputSnapshot).filter(([name]) => immutablePriorNames.has(name))
  );
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
  const ownOutputIsExcluded = diffExcluded.includes(normalizedOutDir);
  const allowedPriorOutputFiles = ownOutputIsExcluded ? [...allowedPriorNames].map(outputPath) : [];

  // The whole tree, not the scoped diff, decides whether the change stayed
  // inside the scope. An untracked file the diff would not show is refused
  // too, unless it lies under a --diff-exclude path. Only the exact canonical
  // prior-round records are subtracted here -- never the output directory as
  // a whole. packageExclusionProblems has already refused an own output
  // directory that hides scoped source.
  const tree = treeChanges(base);
  const outside = packageTreeScopeProblems({
    ...tree,
    writableScope: task.writableScope,
    allowedOutputFiles: allowedPriorOutputFiles,
  });
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
  const reviewerOptions = buildCli("reviewer", roles.reviewer, "dry-run");
  const reviewerLineArgs = reviewerCommandLine(reviewerOptions);
  const reviewerToolVersion = toolVersion(roles.reviewer, reviewerOptions.executable);
  if (!reviewerToolVersion) die(`cannot record the reviewer tool version for ${reviewerOptions.invocation.command}`);
  const reviewerClaudeAuth = claudeAuthProvenance(roles.reviewer, reviewerOptions.executable);
  const reviewerContract = {
    reviewer: roles.reviewer,
    executable: reviewerOptions.executable,
    toolVersion: reviewerToolVersion,
    command: [reviewerOptions.invocation.command, ...reviewerLineArgs],
    cwd: reviewerOptions.cwd,
    sandboxSignature: sandboxSignature(reviewerOptions, reviewerLineArgs),
    codexShell,
    codexAuth,
    claudeAuth: reviewerClaudeAuth,
  };
  const testResults = runTestCommand();
  const guardRuns = runGuardCommands();
  validateOutputEntries({
    allowed: allowedPriorNames,
    required: requiredPriorNames,
    label: `revalidating round ${round} after tests and guards`,
  });
  assertOutputRecordsUnchanged(priorOutputSnapshot, `revalidating round ${round} after tests and guards`);
  if (round > 0) {
    const reloadedPrior = loadRounds(round - 1);
    validatePriorOutputContents(reloadedPrior);
    const refusal = refusalToContinue(await replay(reloadedPrior), round);
    if (refusal) die(`refusing to package round ${round} after tests and guards: ${refusal}`);
  }
  const guardViolations = guardRuns.filter((run) => !run.passed).map((run) => `${run.rule}: ${run.detail}`);
  const summary = flag("summary", "(no summary supplied; the diff is the record)");
  const pkg = {
    version: "cross-review-package-v5",
    taskId: task.taskId,
    round,
    baseCommit: base,
    lineage,
    inheritedFindings: inherited,
    changeDigest,
    commit: dirty ? null : commit,
    headCommit: commit,
    worktreeDirty: dirty,
    reviewerContract,
    changeSummary: summary,
    filesChanged,
    treeFilesChanged: tree.tracked,
    diffExcluded,
    excludedDigests: excludedSnapshots(diffExcluded.filter((path) => generatedPaths.includes(path))),
    testResults,
    guardCommands: guardCommands.map(redactCrossReviewDiagnosticText),
    guardRuns,
    producedAt: new Date().toISOString(),
    diff,
  };
  const packageContents = `${JSON.stringify(pkg, null, 2)}\n`;
  write(`package-round${round}.json`, packageContents);
  write(`change-round${round}.diff`, diff);
  write("change.diff", diff);
  const rounds = [...previous, { round, pkg, verdict: null }];
  const reviewPromptContents = renderReviewPrompt({
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
    });
  write("review-prompt.md", reviewPromptContents);
  const exchange = await replay(rounds);
  const exchangeContents = `${JSON.stringify(exchange, null, 2)}\n`;
  write("exchange.json", exchangeContents);
  const currentOutputNames = new Set([
    ...allowedPriorNames,
    `package-round${round}.json`,
    `change-round${round}.diff`,
    "change.diff",
    "review-prompt.md",
    "exchange.json",
  ]);
  const currentRequiredOutputNames = new Set([
    ...requiredPriorNames,
    `package-round${round}.json`,
    `change-round${round}.diff`,
    "change.diff",
    "review-prompt.md",
    "exchange.json",
  ]);
  validateOutputEntries({
    allowed: currentOutputNames,
    required: currentRequiredOutputNames,
    label: `finalising round ${round}`,
  });
  assertOutputRecordsUnchanged(immutablePriorSnapshot, `finalising round ${round}`);
  const exactCurrentContents = new Map([
    [`package-round${round}.json`, packageContents],
    [`change-round${round}.diff`, diff],
    ["change.diff", diff],
    ["review-prompt.md", reviewPromptContents],
    ["exchange.json", exchangeContents],
  ]);
  for (const [name, expected] of exactCurrentContents) {
    const actual = readFileSync(join(outputAbsolute, name), "utf8");
    if (actual !== expected) die(`refusing packaged round ${round}: generated record ${name} changed after its atomic write`);
  }
  const postTree = treeChanges(base);
  const postOutside = packageTreeScopeProblems({
    ...postTree,
    writableScope: task.writableScope,
    allowedOutputFiles: [...currentOutputNames].map(outputPath),
  });
  if (postOutside.length > 0) {
    die(`refusing packaged round ${round}: tree changed outside the writable scope: ${postOutside.join(", ")}`);
  }
  const currentOutputFiles = new Set([...currentOutputNames].map(outputPath));
  const postUnseen = postTree.untracked.filter(
    (file) => !isExcluded(file) && !currentOutputFiles.has(normalizeRepoPath(file))
  );
  if (postUnseen.length > 0) {
    die(`refusing packaged round ${round}: untracked file(s) the diff would not show: ${postUnseen.join(", ")}`);
  }
  if (digest(scopedDiff(base, diffExcluded)) !== changeDigest) {
    die(`refusing packaged round ${round}: the reviewed source diff changed while records were written`);
  }
  const postGenerated = excludedSnapshots(diffExcluded.filter((path) => generatedPaths.includes(path)));
  if (JSON.stringify(postGenerated) !== JSON.stringify(pkg.excludedDigests)) {
    die(`refusing packaged round ${round}: an excluded generated path changed while records were written`);
  }
  const reloadedRounds = loadRounds(round);
  validatePriorOutputContents(reloadedRounds);
  const replayed = await replay(reloadedRounds, exchange.producedAt);
  if (!canonicalEqual(readJson(join(outputAbsolute, "exchange.json")), replayed) || replayed.status !== "awaiting_review" || replayed.changeDigest !== changeDigest) {
    die(`refusing packaged round ${round}: reloaded records do not replay to the packaged awaiting-review state`);
  }
  const checks = [...testResults, ...guardRuns];
  console.log(
    `packaged ${task.taskId} round ${round}: ${filesChanged.length} file(s), digest ${changeDigest}, ${testResults.length} test command(s), ${guardRuns.length} guard rule(s)${checks.every((t) => t.passed) && checks.length > 0 ? "" : " (CHECKS NOT PASSING)"}${lineage.length > 0 ? `, continues ${lineage.join(" > ")} with ${inherited.length} inherited finding(s)` : ""} — ${exchange.status}`
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// preflight: the reviewer's environment, before a review is paid for.

if (mode === "preflight") {
  try {
    inspectOutputEntries();
  } catch (error) {
    die(`refusing unsafe preflight output: ${error.message}`);
  }
  const packaged = packagedRounds();
  if (packaged.length === 0) die(`nothing is packaged under ${outDir}; package the round before its preflight.`);
  const round = Number.parseInt(flag("round", String(packaged[packaged.length - 1])), 10);
  if (!Number.isInteger(round) || round < 0) die("--round must be a non-negative integer.");
  const current = loadRound(round);
  if (current.verdict) die(`round ${round} already has a verdict; a preflight cannot be attached after review.`);
  assertPackagedChange(current.pkg, `preflight round ${round}`);
  const options = buildCli("reviewer", roles.reviewer, authorised ? "live" : "dry-run");
  const lineArgs = reviewerCommandLine(options);
  const head = git("rev-parse", "HEAD").trim();
  if (head !== current.pkg.headCommit) die(`the current HEAD ${head} is not the packaged head ${current.pkg.headCommit}`);
  if (!canonicalEqual(options.executable, current.pkg.reviewerContract.executable)) {
    die(`the preflight executable does not match the packaged reviewer contract`);
  }
  try {
    assertCliExecutable(current.pkg.reviewerContract.executable, "preflight");
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  const reviewerToolVersion = toolVersion(roles.reviewer, options.executable);
  if (!reviewerToolVersion) die(`cannot record the reviewer tool version for ${options.invocation.command}`);
  const reviewerClaudeAuth = claudeAuthProvenance(roles.reviewer, options.executable);
  if (
    reviewerToolVersion !== current.pkg.reviewerContract.toolVersion ||
    !canonicalEqual([options.invocation.command, ...lineArgs], current.pkg.reviewerContract.command) ||
    options.cwd !== current.pkg.reviewerContract.cwd ||
    sandboxSignature(options, lineArgs) !== current.pkg.reviewerContract.sandboxSignature ||
    codexShell !== current.pkg.reviewerContract.codexShell ||
    codexAuth !== current.pkg.reviewerContract.codexAuth ||
    !canonicalEqual(reviewerClaudeAuth, current.pkg.reviewerContract.claudeAuth)
  ) {
    die(`the preflight invocation, tool version, or subscription auth does not match the packaged reviewer contract`);
  }
  const probeName = `preflight-write-probe-${stamp()}.txt`;
  const probePath = join(outDir, probeName).replace(/\\/g, "/");
  const prompt = renderPreflightPrompt({ readCommand: "git rev-parse HEAD", probePath });
  const signature = sandboxSignature(options, lineArgs);
  console.error(`preflight command: ${[options.invocation.command, ...lineArgs].join(" ")} (prompt on stdin, cwd ${options.cwd}, timeout ${timeoutMs}ms, codex auth: ${codexAuth})`);
  console.error(`sandbox signature: ${signature}`);
  const startedAt = new Date();
  assertPackagedChange(current.pkg, `preflight round ${round}`);
  const result = await cliProbe(options).run(prompt, preflightReportProblems);
  const durationMs = Date.now() - startedAt.getTime();
  assertPackagedChange(current.pkg, `preflight round ${round} after reviewer execution`);
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
  const evidence = writeRefusalEvidence(lastSpawn?.stdout ?? "", lastSpawn?.stderr ?? "", probePath, options.cwd);
  const writeRefusalObserved = evidence !== null;
  const judged = result.ok
    ? judgePreflight({ report: result.value, expectedReadOutput: head, probeExists, writeRefusalObserved })
    : { passed: false, problems: [`the reviewer returned no usable report: ${result.failure} — ${result.detail}`, ...(probeExists ? ["the write probe landed"] : [])] };
  const name = `preflight-${stamp()}`;
  const companions = {
    events: companionBinding(`${name}.events.jsonl`, capturedBytes(lastSpawn, "stdout")),
    stderr: companionBinding(`${name}.stderr.txt`, capturedBytes(lastSpawn, "stderr")),
  };
  const record = {
    version: PREFLIGHT_RECORD_VERSION,
    taskId: task.taskId,
    round,
    changeDigest: current.pkg.changeDigest,
    headCommit: head,
    reviewer: roles.reviewer,
    toolVersion: reviewerToolVersion,
    command: [options.invocation.command, ...lineArgs],
    cwd: options.cwd,
    sandboxSignature: signature,
    codexShell,
    codexAuth,
    claudeAuth: reviewerClaudeAuth,
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
    companions,
  };
  if (companions.events !== null) write(companions.events.name, capturedBytes(lastSpawn, "stdout"));
  if (companions.stderr !== null) write(companions.stderr.name, capturedBytes(lastSpawn, "stderr"));
  write(`${name}.json`, `${JSON.stringify(record, null, 2)}\n`);
  if (judged.passed) {
    validatePreflightRecord(name, readJson(join(outputAbsolute, `${name}.json`)), {
      taskId: task.taskId,
      round,
      changeDigest: current.pkg.changeDigest,
      headCommit: current.pkg.headCommit,
      reviewerContract: current.pkg.reviewerContract,
    });
    assertPackagedChange(current.pkg, `preflight round ${round} final validation`);
  }
  console.log(`${task.taskId} preflight: ${judged.passed ? "PASSED" : "FAILED"}${judged.problems.length > 0 ? ` — ${judged.problems.join("; ")}` : ""}`);
  process.exit(judged.passed ? 0 : 2);
}

/** Every preflight recorded under --out, as the gate reads them. */
const preflightRecords = () =>
  (existsSync(outDir) ? readdirSync(outDir) : [])
    .filter((name) => /^preflight-.*\.json$/.test(name))
    .map((name) => ({ ...readJson(join(outDir, name)), name }));

// ---------------------------------------------------------------------------
// review: only the reviewer, on a packaged round.

if (mode === "review") {
  try {
    inspectOutputEntries();
  } catch (error) {
    die(`refusing unsafe review output: ${error.message}`);
  }
  const packaged = packagedRounds();
  if (packaged.length === 0) die(`nothing is packaged under ${outDir}; run --mode=package first.`);
  const round = Number.parseInt(flag("round", String(packaged[packaged.length - 1])), 10);
  if (!Number.isInteger(round) || round < 0) die("--round must be a non-negative integer.");
  const rounds = loadRounds(round);
  const current = rounds[round];
  if (current.verdict) die(`${verdictFile(round)} already exists; a new review needs a new package with a new digest.`);
  assertPackagedChange(current.pkg, `review round ${round}`);
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
  if (!canonicalEqual(options.executable, current.pkg.reviewerContract.executable)) {
    die(`the review executable does not match the packaged reviewer contract`);
  }
  try {
    assertCliExecutable(current.pkg.reviewerContract.executable, "review");
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  const reviewerToolVersion = toolVersion(roles.reviewer, options.executable);
  if (!reviewerToolVersion) die(`cannot record the reviewer tool version for ${options.invocation.command}`);
  const reviewerClaudeAuth = claudeAuthProvenance(roles.reviewer, options.executable);
  if (
    reviewerToolVersion !== current.pkg.reviewerContract.toolVersion ||
    !canonicalEqual([options.invocation.command, ...lineArgs], current.pkg.reviewerContract.command) ||
    options.cwd !== current.pkg.reviewerContract.cwd ||
    signature !== current.pkg.reviewerContract.sandboxSignature ||
    codexShell !== current.pkg.reviewerContract.codexShell ||
    codexAuth !== current.pkg.reviewerContract.codexAuth ||
    !canonicalEqual(reviewerClaudeAuth, current.pkg.reviewerContract.claudeAuth)
  ) {
    die(`the review invocation, tool version, or subscription auth does not match the packaged reviewer contract`);
  }
  console.error(`sandbox signature: ${signature}`);
  // The newest preflight for this sandbox decides, and it must be a pass
  // under the current rule; an older pass is not picked past a newer failure.
  const gateCandidates = preflightRecords().filter(
    (record) =>
      record.taskId === task.taskId &&
      record.round === round &&
      record.changeDigest === current.pkg.changeDigest &&
      record.headCommit === current.pkg.headCommit
  );
  const gate = preflightGate(gateCandidates, signature, PREFLIGHT_RECORD_VERSION);
  const chosenPreflight = gate.chosen;
  let preflight = null;
  if (!chosenPreflight) {
    if (flag("skip-preflight", "false") !== "true") {
      die(`refusing to review round ${round}: ${gate.problems.join("; ")}. Run --mode=preflight first, or pass --skip-preflight to record a person's decision to review without one.`);
    }
    overrides.push(`skip-preflight: ${gate.problems.join("; ")}`);
  } else {
    preflight = validatePreflightRecord(chosenPreflight.name, readJson(join(outputAbsolute, chosenPreflight.name)), {
      taskId: task.taskId,
      round,
      changeDigest: current.pkg.changeDigest,
      headCommit: current.pkg.headCommit,
      reviewerContract: current.pkg.reviewerContract,
    });
    preflight.name = chosenPreflight.name;
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
  const reviewPromptContents = renderReviewPrompt(request);
  write("review-prompt.md", reviewPromptContents);
  console.error(`reviewer command: ${[options.invocation.command, ...lineArgs].join(" ")} (prompt on stdin, cwd ${options.cwd}, timeout ${timeoutMs}ms, codex auth: ${codexAuth})`);
  if (preflight) console.error(`preflight: ${preflight.name} (${preflight.startedAt})`);
  for (const override of overrides) console.error(`override: ${override}`);
  const startedAt = new Date();
  assertPackagedChange(current.pkg, `review round ${round}`);
  const result = await cliReviewer(options).review(request);
  const durationMs = Date.now() - startedAt.getTime();
  assertPackagedChange(current.pkg, `review round ${round} after reviewer execution`);
  const companions = {
    events: companionBinding(`review-round${round}.events.jsonl`, capturedBytes(lastSpawn, "stdout")),
    stderr: companionBinding(`review-round${round}.stderr.txt`, capturedBytes(lastSpawn, "stderr")),
  };
  if (lastSpawn) {
    if (companions.events !== null) write(companions.events.name, capturedBytes(lastSpawn, "stdout"));
    if (companions.stderr !== null) write(companions.stderr.name, capturedBytes(lastSpawn, "stderr"));
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
  const verdictRecord = {
        version: "cross-review-verdict-v3",
        taskId: task.taskId,
        round,
        reviewer: roles.reviewer,
        toolVersion: reviewerToolVersion,
        command: [options.invocation.command, ...lineArgs],
        cwd: options.cwd,
        sandboxSignature: signature,
        codexShell,
        codexAuth,
        claudeAuth: reviewerClaudeAuth,
        preflight: preflight?.name ?? null,
        overrides,
        startedAt: startedAt.toISOString(),
        durationMs,
        usage: extractUsage(lastSpawn?.stdout ?? ""),
        receivedAt: new Date().toISOString(),
        companions,
        verdict: result.value,
      };
  write(`verdict-round${round}.json`, `${JSON.stringify(verdictRecord, null, 2)}\n`);
  const validatedVerdict = validateVerdictRecord(round, current.pkg, readJson(verdictFile(round)));
  current.verdict = validatedVerdict.verdict;
  const exchange = await replay(rounds);
  const exchangeContents = `${JSON.stringify(exchange, null, 2)}\n`;
  write("exchange.json", exchangeContents);
  const reloadedRounds = loadRounds(round);
  validatePriorOutputContents(reloadedRounds);
  if (readFileSync(join(outputAbsolute, "review-prompt.md"), "utf8") !== reviewPromptContents) {
    die(`refusing review conclusion for round ${round}: review-prompt.md changed after its atomic write`);
  }
  const reloadedExchange = await replay(reloadedRounds, exchange.producedAt);
  if (!canonicalEqual(readJson(join(outputAbsolute, "exchange.json")), reloadedExchange)) {
    die(`refusing review conclusion for round ${round}: reloaded exchange does not match the stored replay`);
  }
  assertPackagedChange(current.pkg, `review round ${round} final validation`);
  console.log(
    `${task.taskId} round ${round}: ${validatedVerdict.verdict.conclusion} with ${validatedVerdict.verdict.findings.length} finding(s) — ${reloadedExchange.status}${reloadedExchange.holdReason ? ` (${reloadedExchange.holdReason})` : ""}: ${reloadedExchange.nextAction}`
  );
  process.exit(reloadedExchange.status === "passed" ? 0 : 2);
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
  guards = async () => [...(fixtureGuards ? fixtureGuards[current] ?? [] : []).map(redactGuardRun), ...runGuardCommands()];
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
    return [redactGuardRun(treeRule), ...runGuardCommands()];
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
    const fromFixture = fixtureTests ? (fixtureTests[current] ?? []).map(redactTestRun) : [];
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
