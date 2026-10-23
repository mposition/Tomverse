#!/usr/bin/env node
/**
 * The auto-rec runner: one Auto router optimizer `code` recommendation per
 * run, from claim to a develop pull request a person merges.
 *
 *   claim (gateway) -> worktree from origin/develop -> Claude Code headless
 *   -> one runner-made commit on develop -> scope check -> related unit tests
 *   + lint -> independent review of exactly that commit
 *   -> publish (gateway: push + PR) -> result (gateway)
 *
 * It runs as the unprivileged `autorec` account and holds no secret: the
 * app's shared secret and the GitHub token live only in the gateway
 * (autorec-gateway.mjs), because this account also runs the code the agent
 * wrote. A step whose outcome is unknown is logged and the run ends without
 * a retry; the app turns the expired lease into `needs_lookup`.
 *
 * Exit codes: 0 nothing to do or a reported outcome, 1 an error or an
 * unknown outcome (see the run log).
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { release, tryAcquire } from "../../review-orchestrator/lib/fsutil.mjs";
import { DEFAULTS, FAILURE_REASONS, GIT_IDENTITY, LIMITS, OUTCOME_FAILED, OUTCOME_PR_OPENED, REPO_URL } from "../lib/contract.mjs";
import {
  TEST_LANES,
  branchNameFor,
  buildInstruction,
  buildPrBody,
  buildPrTitle,
  checkChangeScope,
  classifyReviewExit,
  cycleUrlFrom,
  leaseAllowsPublish,
  lintableFiles,
  parseRawDiff,
  selectRelatedTests,
} from "../lib/core.mjs";

const REVIEW_JOB_ID = /^r-\d{8}-\d{6}-[0-9a-f]{6}$/;

/**
 * Claude Code in print mode, non-interactive: only the listed built-in tools
 * exist, only the listed calls run, everything else is denied without a
 * prompt (`dontAsk`), and no MCP server is loaded (the subscription account's
 * claude.ai connectors include payment and deployment tools).
 */
export const CLAUDE_ARGS = Object.freeze([
  "-p",
  "--output-format",
  "json",
  "--permission-mode",
  "dontAsk",
  "--tools",
  "Read,Edit,Write,Grep,Glob,Bash",
  "--allowedTools",
  [
    "Read",
    "Edit",
    "Write",
    "Grep",
    "Glob",
    "Bash(git status)",
    "Bash(git status *)",
    "Bash(git diff)",
    "Bash(git diff *)",
    "Bash(git log *)",
    "Bash(git add *)",
    "Bash(git commit *)",
    "Bash(node --test *)",
    "Bash(node --import tsx *)",
    "Bash(node --conditions=react-server *)",
    "Bash(npx tsc *)",
    "Bash(npx eslint *)",
  ].join(","),
  "--strict-mcp-config",
  "--no-session-persistence",
]);

export function readRunnerConfig(env) {
  return {
    home: env.HOME || DEFAULTS.home,
    path: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    mirror: env.AUTOREC_MIRROR || DEFAULTS.mirror,
    workDir: env.AUTOREC_WORK_DIR || DEFAULTS.workDir,
    logDir: env.AUTOREC_LOG_DIR || DEFAULTS.logDir,
    claudeBin: env.AUTOREC_CLAUDE_BIN || DEFAULTS.claudeBin,
    reviewClient: env.AUTOREC_REVIEW_CLIENT || DEFAULTS.reviewClient,
    reviewSsh: env.AUTOREC_REVIEW_SSH || DEFAULTS.reviewSsh,
    reviewHost: env.REVIEW_ORCH_HOST || DEFAULTS.reviewHost,
    gitBin: env.AUTOREC_GIT_BIN || DEFAULTS.gitBin,
    gatewaySocket: env.AUTOREC_GATEWAY_SOCKET || DEFAULTS.gatewaySocket,
    nodeBin: process.execPath,
    npmBin: env.AUTOREC_NPM_BIN || DEFAULTS.npmBin,
    // Optional: a `claude setup-token` token from /etc/autorec/claude.env.
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN || null,
  };
}

const baseEnv = (config) => ({ HOME: config.home, PATH: config.path, LANG: "C.UTF-8", USER: "autorec", LOGNAME: "autorec" });

const commitEnv = (config) => ({
  ...baseEnv(config),
  GIT_AUTHOR_NAME: GIT_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
});

function agentEnv(config) {
  return {
    ...commitEnv(config),
    TERM: "dumb",
    ...(config.claudeOauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken } : {}),
  };
}

/**
 * The review client and its git and ssh come only from root-owned paths: the
 * agent can write ~/.local/bin and ~/.ssh/config, and a fake `ssh` there could
 * answer "accept" for the review server.
 */
const reviewEnv = (config) => ({
  ...baseEnv(config),
  PATH: DEFAULTS.trustedPath,
  REVIEW_ORCH_SSH: config.reviewSsh,
  REVIEW_ORCH_HOST: config.reviewHost,
});

const failed = (reason, detail = undefined) => ({ outcome: OUTCOME_FAILED, reason, ...(detail ? { detail } : {}) });

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Make sure the mirror's node_modules matches develop's lockfile and Prisma schema. */
async function ensureDependencies(deps, base) {
  const { config, exec, fs } = deps;
  const blobs = await exec(config.gitBin, ["-C", config.mirror, "rev-parse", `${base}:package-lock.json`, `${base}:prisma/schema.prisma`], {
    env: baseEnv(config),
    timeoutMs: 60_000,
  });
  if (blobs.code !== 0) return false;
  const key = blobs.stdout.trim().split(/\s+/).join(" ");
  const stamp = join(config.mirror, ".git", "autorec-deps-key");
  if (fs.readText(stamp) === key && fs.exists(join(config.mirror, "node_modules"))) return true;
  deps.log("dependencies_install", { base });
  const checkout = await exec(config.gitBin, ["-C", config.mirror, "checkout", "--quiet", "--force", "--detach", base], {
    env: baseEnv(config),
    timeoutMs: 5 * 60_000,
  });
  if (checkout.code !== 0) return false;
  const install = await exec(config.npmBin, ["ci", "--no-audit", "--no-fund"], {
    cwd: config.mirror,
    env: baseEnv(config),
    timeoutMs: LIMITS.setupMs,
  });
  if (install.code !== 0 || install.timedOut) return false;
  fs.writeText(stamp, key);
  return true;
}

async function review(deps, ctx, claim, base, head) {
  const { config, exec } = deps;
  const client = (args, timeoutMs) =>
    exec(config.nodeBin, [config.reviewClient, ...args], { cwd: ctx.worktree, env: reviewEnv(config), timeoutMs });
  const scope = `auto-rec ${claim.id}: ${claim.recommendation.replace(/\s+/g, " ").slice(0, 300)}`;
  // The base is the develop commit this run fetched itself. The client also
  // looks at the worktree's own refs, which the agent's code can move, so the
  // verdict counts only when the job reports this base and this head.
  const submitted = await client(["submit", "--author", "claude", "--base", base, "--scope", scope], 10 * 60_000);
  const jobId = parseJsonObject(submitted.stdout)?.jobId;
  if (submitted.code !== 3 || typeof jobId !== "string" || !REVIEW_JOB_ID.test(jobId)) {
    deps.log("review_submit_failed", { code: submitted.code });
    return { verdict: "unknown", jobId: null };
  }
  ctx.reviewJobId = jobId;
  deps.log("review_submitted", { jobId });
  const deadline = deps.now() + LIMITS.reviewWaitMs;
  for (;;) {
    const waited = await client(["wait", jobId], 12 * 60_000);
    // A `wait` that outran its own timeout is still a pending review, not a verdict.
    const verdict = waited.timedOut ? "pending" : classifyReviewExit(waited.code);
    if (verdict === "pending" && deps.now() < deadline) {
      // `wait` itself blocks for minutes; this only stops a fast-returning server from spinning.
      await deps.sleep(10_000);
      continue;
    }
    if (verdict === "accept") {
      const job = parseJsonObject(waited.stdout);
      if (job?.head !== head || job?.base !== base || (job?.focus ?? null) !== null) {
        deps.log("review_range_mismatch", { jobId });
        return { verdict: "unknown", jobId };
      }
    }
    return { verdict: verdict === "pending" ? "unknown" : verdict, jobId };
  }
}

/** Everything between the claim and the publish. Returns the outcome to report. */
async function work(deps, claim, ctx) {
  const { config, exec, fs } = deps;
  const git = (cwd, args, timeoutMs = 120_000) => exec(config.gitBin, ["-C", cwd, ...args], { env: baseEnv(config), timeoutMs });

  ctx.stage = "setup";
  const branch = branchNameFor(claim.id);
  const worktree = join(config.workDir, basename(branch));
  // The token belongs to the gateway alone. A clone made with it in the URL
  // would leave it in a file this account (and the agent's code) can read.
  const origin = await git(config.mirror, ["remote", "get-url", "origin"]);
  if (origin.code === 0 && origin.stdout.includes("@")) return failed("setup_failed", "mirror_origin_has_credentials");
  // HTTP/1.1: an HTTP/2 stream from the host was cut mid-pack on a large fetch (curl 92).
  const fetched = await git(
    config.mirror,
    ["-c", "http.version=HTTP/1.1", "fetch", "--no-tags", "--quiet", REPO_URL, "+refs/heads/develop:refs/remotes/origin/develop"],
    LIMITS.setupMs,
  );
  if (fetched.code !== 0) return failed("setup_failed", "develop_fetch");
  const baseResult = await git(config.mirror, ["rev-parse", "--verify", "refs/remotes/origin/develop^{commit}"]);
  if (baseResult.code !== 0) return failed("setup_failed", "develop_missing");
  const base = baseResult.stdout.trim();
  // A previous run that died mid-way may have left both behind.
  await git(config.mirror, ["worktree", "prune"]);
  if (fs.exists(worktree)) await git(config.mirror, ["worktree", "remove", "--force", worktree]);
  await git(config.mirror, ["branch", "-D", branch]);
  // Set first, so cleanup removes whatever a half-finished `worktree add` left.
  ctx.worktree = worktree;
  ctx.branch = branch;
  if ((await git(config.mirror, ["worktree", "add", "--quiet", "-b", branch, worktree, base])).code !== 0) {
    return failed("setup_failed", "worktree_add");
  }
  if (!(await ensureDependencies(deps, base))) return failed("setup_failed", "dependencies");
  fs.symlink(join(config.mirror, "node_modules"), join(worktree, "node_modules"));

  ctx.stage = "agent";
  const agent = await exec(config.claudeBin, CLAUDE_ARGS, {
    cwd: worktree,
    env: agentEnv(config),
    input: buildInstruction(claim),
    timeoutMs: LIMITS.claudeMs,
  });
  const summary = parseJsonObject(agent.stdout);
  deps.log("agent_finished", {
    code: agent.code,
    timedOut: agent.timedOut,
    subtype: summary?.subtype ?? null,
    turns: summary?.num_turns ?? null,
  });
  deps.runLog("agent_result", typeof summary?.result === "string" ? summary.result.slice(-8_000) : agent.stderr.slice(-4_000));
  if (agent.timedOut) return failed("timeout");
  if (agent.code !== 0) return failed("agent_error");

  // Only committed work counts: drop anything the agent left uncommitted.
  await git(worktree, ["reset", "--quiet", "--hard", "HEAD"]);
  await git(worktree, ["clean", "-fdxq", "-e", "/node_modules"]);
  // A push publishes every commit it carries, so what leaves is one commit the
  // runner makes from the agent's final tree, on the develop it fetched: no
  // intermediate commit can carry something a later one removed.
  const treeResult = await git(worktree, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (treeResult.code !== 0) return failed("runner_error", "head");
  const squashed = await exec(config.gitBin, ["-C", worktree, "commit-tree", treeResult.stdout.trim(), "-p", base, "-F", "-"], {
    env: commitEnv(config),
    input: `${buildPrTitle(claim)}\n`,
    timeoutMs: 60_000,
  });
  const head = squashed.stdout.trim();
  if (squashed.code !== 0 || !/^[0-9a-f]{40}$/.test(head)) return failed("runner_error", "squash");
  if ((await git(worktree, ["reset", "--quiet", "--hard", head])).code !== 0) return failed("runner_error", "squash");
  const diff = await git(worktree, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head]);
  if (diff.code !== 0) return failed("runner_error", "diff");
  const changes = parseRawDiff(diff.stdout);
  const scope = checkChangeScope(changes);
  if (!scope.ok) {
    deps.log("scope_refused", { reason: scope.reason, refused: scope.refused.slice(0, 20) });
    return failed(scope.reason);
  }

  ctx.stage = "tests";
  const changed = changes.map((change) => change.path);
  const related = selectRelatedTests(changed, fs.listTestFiles(worktree), (path) => fs.readText(join(worktree, path)));
  if (Object.keys(related).length === 0) return failed("tests", "no_related_tests");
  for (const lane of TEST_LANES) {
    const files = related[lane.label];
    if (!files) continue;
    deps.log("tests_run", { lane: lane.label, files: files.length });
    const run = await exec(config.nodeBin, [...lane.nodeArgs, "--test", "--test-concurrency=1", ...files], {
      cwd: worktree,
      env: baseEnv(config),
      timeoutMs: LIMITS.testsMs,
    });
    deps.runLog(`tests_${lane.label}`, `${run.stdout.slice(-8_000)}\n${run.stderr.slice(-4_000)}`);
    if (run.code !== 0 || run.timedOut) return failed("tests", `lane_${lane.label}`);
  }
  const lintTargets = lintableFiles(changes.filter((change) => change.status !== "D").map((change) => change.path));
  if (lintTargets.length > 0) {
    const lint = await exec(config.nodeBin, [join(worktree, "node_modules", "eslint", "bin", "eslint.js"), "--max-warnings=0", ...lintTargets], {
      cwd: worktree,
      env: baseEnv(config),
      timeoutMs: LIMITS.lintMs,
    });
    deps.runLog("lint", `${lint.stdout.slice(-8_000)}\n${lint.stderr.slice(-2_000)}`);
    if (lint.code !== 0 || lint.timedOut) return failed("tests", "lint");
  }

  ctx.stage = "review";
  const verdict = await review(deps, ctx, claim, base, head);
  if (verdict.verdict === "reject") return failed("review_reject");
  if (verdict.verdict !== "accept") return failed("review_unknown");

  if (!leaseAllowsPublish(claim.leaseUntil, deps.now())) return failed("lease_expired");
  const bundlePath = join(config.workDir, `${basename(branch)}.bundle`);
  if ((await git(worktree, ["bundle", "create", "--quiet", bundlePath, `refs/heads/${branch}`, `^${base}`])).code !== 0) {
    return failed("runner_error", "bundle");
  }
  const bundle = fs.readBuffer(bundlePath);
  fs.remove(bundlePath);
  const header = {
    op: "publish",
    id: claim.id,
    branch,
    head,
    title: buildPrTitle(claim),
    body: buildPrBody({ claim, reviewJobId: verdict.jobId, cycleUrl: cycleUrlFrom(claim) }),
  };

  // From here an interrupted call may have pushed: no failure is reported without knowing.
  ctx.stage = "publish";
  let reply;
  try {
    reply = await deps.gateway({ ...header }, bundle, 60 * 60_000);
  } catch (error) {
    deps.log("publish_no_answer", { message: error.message });
    return { unknown: "publish" };
  }
  deps.log("publish_answer", { status: reply?.status ?? null, code: reply?.code ?? null, detail: reply?.detail ?? null });
  if (reply?.status === "published") return { outcome: OUTCOME_PR_OPENED, prUrl: reply.prUrl };
  if (reply?.status === "refused") return failed(FAILURE_REASONS.includes(reply.code) ? reply.code : "runner_error");
  if (reply?.status === "failed" && reply.code === "pr_failed") return failed("pr_failed");
  return { unknown: "publish" };
}

async function cleanup(deps, ctx) {
  const { config, exec } = deps;
  const git = (args) => exec(config.gitBin, ["-C", config.mirror, ...args], { env: baseEnv(config), timeoutMs: 120_000 });
  try {
    if (ctx.worktree) await git(["worktree", "remove", "--force", ctx.worktree]);
    if (ctx.branch) await git(["branch", "-D", ctx.branch]);
    await git(["worktree", "prune"]);
  } catch (error) {
    deps.log("cleanup_failed", { message: error.message });
  }
}

async function report(deps, claim, outcome) {
  const body =
    outcome.outcome === OUTCOME_PR_OPENED
      ? { op: "result", id: claim.id, claimId: claim.claimId, outcome: OUTCOME_PR_OPENED, prUrl: outcome.prUrl }
      : { op: "result", id: claim.id, claimId: claim.claimId, outcome: OUTCOME_FAILED, reason: outcome.reason };
  let reply;
  try {
    reply = await deps.gateway(body, null, 3 * 60_000);
  } catch (error) {
    deps.log("result_no_answer", { message: error.message });
    return 1;
  }
  deps.log("result_answer", { status: reply?.status ?? null, code: reply?.code ?? null });
  return reply?.status === "reported" ? 0 : 1;
}

export async function runLocked(deps) {
  let reply;
  try {
    reply = await deps.gateway({ op: "claim" }, null, 3 * 60_000);
  } catch (error) {
    deps.log("claim_no_answer", { message: error.message });
    return 1;
  }
  if (reply?.status === "empty") {
    deps.log("no_recommendation");
    return 0;
  }
  if (reply?.status !== "claimed") {
    deps.log("claim_failed", { status: reply?.status ?? null, code: reply?.code ?? null });
    return 1;
  }
  const claim = reply.claim;
  deps.startRunLog(claim.id);
  deps.log("claimed", { id: claim.id, leaseUntil: claim.leaseUntil });
  const ctx = { stage: "claimed", worktree: null, branch: null, reviewJobId: null };
  let outcome;
  try {
    outcome = await work(deps, claim, ctx);
  } catch (error) {
    deps.log("runner_exception", { stage: ctx.stage, message: error.message });
    outcome = ctx.stage === "publish" ? { unknown: "publish" } : failed("runner_error");
  } finally {
    await cleanup(deps, ctx);
  }
  if (outcome.unknown) {
    deps.log("outcome_unknown", { step: outcome.unknown, id: claim.id });
    return 1;
  }
  deps.log("outcome", { outcome: outcome.outcome, reason: outcome.reason ?? null, detail: outcome.detail ?? null, prUrl: outcome.prUrl ?? null });
  return report(deps, claim, outcome);
}

export async function runOnce(deps) {
  const lockPath = join(deps.config.workDir, ".runner.lock");
  const token = deps.lock.acquire(lockPath);
  if (!token) {
    deps.log("runner_busy");
    return 0;
  }
  try {
    deps.pruneLogs();
    return await runLocked(deps);
  } finally {
    deps.lock.release(lockPath, token);
  }
}

// ---------------------------------------------------------------- real I/O

function realExec(command, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // Its own process group, so a timeout takes the whole tree with it.
      detached: true,
    });
    const out = [];
    const err = [];
    let outSize = 0;
    let errSize = 0;
    const cap = 16 * 1024 * 1024;
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outSize += chunk.length;
      if (outSize <= cap) out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errSize += chunk.length;
      if (errSize <= cap) err.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: "", timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Whatever the command left running in its group ends with it.
      kill();
      resolve({
        code: code ?? 137,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** One request to the gateway socket: a JSON line, the optional payload, then one JSON line back. */
export function callGateway(socketPath, header, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("gateway_timeout")), timeoutMs);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(header)}\n`);
      if (payload) socket.write(payload);
      socket.end();
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => finish(new Error(`gateway_${error.code ?? "error"}`)));
    socket.on("close", () => {
      const line = Buffer.concat(chunks).toString("utf8").split("\n")[0];
      const value = parseJsonObject(line);
      if (value) finish(null, value);
      else finish(new Error("gateway_no_answer"));
    });
  });
}

function listTestFiles(worktree) {
  const files = [];
  for (const directory of ["tests", "tests/server-contract", "tests/client"]) {
    let names = [];
    try {
      names = readdirSync(join(worktree, directory));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.test\.(?:mjs|ts|tsx)$/.test(name)) continue;
      try {
        if (statSync(join(worktree, directory, name)).isFile()) files.push(`${directory}/${name}`);
      } catch {
        // vanished
      }
    }
  }
  return files;
}

export function realRunnerDeps(env) {
  const config = readRunnerConfig(env);
  let runLogPath = null;
  const stamp = () => new Date().toISOString();
  const emit = (line) => {
    process.stdout.write(`${line}\n`);
    if (runLogPath) {
      try {
        appendFileSync(runLogPath, `${line}\n`, { mode: 0o600 });
      } catch {
        // the journal still has it
      }
    }
  };
  return {
    config,
    exec: realExec,
    gateway: (header, payload, timeoutMs) => callGateway(config.gatewaySocket, header, payload, timeoutMs),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    lock: { acquire: (path) => (mkdirSync(config.workDir, { recursive: true }), tryAcquire(path)), release },
    fs: {
      exists: (path) => existsSync(path),
      readText: (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return null;
        }
      },
      readBuffer: (path) => readFileSync(path),
      writeText: (path, text) => writeFileSync(path, text),
      remove: (path) => rmSync(path, { force: true }),
      symlink: (target, path) => symlinkSync(target, path, "dir"),
      listTestFiles,
    },
    // Journal lines: event names, codes, ids and counts, never agent or test output.
    log: (event, fields = {}) => emit(JSON.stringify({ at: stamp(), event, ...fields })),
    // The per-run file in logDir also keeps output tails, for the operator.
    runLog: (section, text) => {
      if (!runLogPath) return;
      try {
        appendFileSync(runLogPath, `----- ${section} -----\n${text}\n`, { mode: 0o600 });
      } catch {
        // best effort
      }
    },
    startRunLog: (id) => {
      mkdirSync(config.logDir, { recursive: true });
      const safe = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
      runLogPath = join(config.logDir, `${stamp().replace(/[:.]/g, "-")}-${safe}.log`);
    },
    pruneLogs: () => {
      const cutoff = Date.now() - LIMITS.logRetentionDays * 24 * 60 * 60_000;
      try {
        for (const name of readdirSync(config.logDir)) {
          const path = join(config.logDir, name);
          if (name.endsWith(".log") && statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
        }
      } catch {
        // no log directory yet
      }
    },
  };
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
/**
 * The gateway answers this process alone, and the agent's code shares its
 * uid: without --disable-sigusr1 a SIGUSR1 would open the Node inspector and
 * let that code run inside this process.
 */
export const startupProblem = (execArgv) => (execArgv.includes("--disable-sigusr1") ? null : "inspector_signal_enabled");

if (isEntry && startupProblem(process.execArgv)) {
  process.stdout.write(`${JSON.stringify({ event: "runner_refused", code: startupProblem(process.execArgv) })}\n`);
  process.exit(64);
} else if (isEntry) {
  runOnce(realRunnerDeps(process.env)).then(
    (code) => process.exit(code),
    (error) => {
      process.stdout.write(`${JSON.stringify({ event: "runner_crashed", message: error.message })}\n`);
      process.exit(1);
    },
  );
}
