/** Launcher-only review transport. A claim is durable before the first submit:
 * an interrupted or ambiguous submit can never cause a second submission. */
import { spawnSync } from "node:child_process";
import { constants, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync,
  writeFileSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const JOB = /^r-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;
const VENDOR = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_OUTPUT = 65_536;

function validInput(input) {
  return input && UUID.test(input.attemptId) && SHA.test(input.baseSha) &&
    SHA.test(input.commitSha) && input.baseSha !== input.commitSha &&
    input.reviewRef === `refs/amux-v52-review/${input.attemptId}` &&
    ["claude", "codex", "cursor", "copilot"].includes(input.author) &&
    VENDOR.test(input.authorVendor) && typeof input.scope === "string" &&
    input.scope.length > 0 && input.scope.length <= 8_192 &&
    typeof input.touchesContract === "boolean";
}

function evidence(input, verdict, jobId = null, reviewerVendors = []) {
  return { job_id: jobId, base_sha: input.baseSha,
    commit_sha: input.commitSha, verdict,
    author_vendor: input.authorVendor,
    reviewer_vendors: reviewerVendors,
    touches_contract: input.touchesContract };
}

function checkedRun(program, args, cwd, timeout = 30_000, objectsDir) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8",
    timeout, maxBuffer: MAX_OUTPUT, windowsHide: true,
    env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
      ...(objectsDir ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: objectsDir } : {}) } });
  return { code: result.status ?? 65, stdout: result.stdout ?? "" };
}

/** Only object bytes cross the worker/bridge boundary. Git config and refs
 * used by the SSH-key holder live in its own private bare repository. */
export function prepareReviewRepository(input, directory, objectsDir,
  run = checkedRun) {
  if (!isAbsolute(objectsDir ?? "") ||
      !lstatSync(objectsDir).isDirectory())
    throw new Error("review object directory unavailable");
  const repository = join(directory, `${input.attemptId}.git`);
  const git = (args, cwd = repository) => {
    const reply = run("/usr/bin/git", args, cwd, 5_000, objectsDir);
    if (reply.code !== 0) throw new Error("isolated review git failed");
    return reply.stdout.trim();
  };
  git(["init", "--bare", "--quiet", repository], directory);
  if (!lstatSync(repository).isDirectory())
    throw new Error("isolated review repository unavailable");
  git(["update-ref", "refs/remotes/origin/develop", input.baseSha]);
  git(["update-ref", input.reviewRef, input.commitSha]);
  if (git(["rev-parse", "--verify", `${input.commitSha}^`]) !==
      input.baseSha ||
      git(["rev-parse", "--verify", `${input.reviewRef}^{commit}`]) !==
        input.commitSha)
    throw new Error("review commit does not bind the base");
  return repository;
}

function requireRootOwnedClient(path) {
  let cursor = path;
  for (;;) {
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new Error("unsafe review client path");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!lstatSync(path).isFile()) throw new Error("unsafe review client path");
}

function durableWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
  }
}

function claim(path, input) {
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify({ input })); fsyncSync(fd); }
    finally { closeSync(fd); }
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return false;
  }
}

function readState(path, input) {
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (JSON.stringify(state.input) !== JSON.stringify(input))
    throw new Error("review attempt binding conflict");
  return state;
}

function reviewVendors(status) {
  if (!Array.isArray(status.reviews) || status.reviews.length > 4) return null;
  const vendors = status.reviews.map((review) => review?.vendor);
  if (vendors.some((vendor) => !VENDOR.test(vendor)) ||
      new Set(vendors).size !== vendors.length) return null;
  return vendors;
}

export function reviewStep(input, options = {}) {
  if (!validInput(input)) throw new Error("invalid review request");
  const directory = options.stateDir ?? process.env.AMUX_V52_REVIEW_STATE_DIR;
  const objectsDir = options.objectsDir ??
    process.env.AMUX_V52_REVIEW_OBJECTS_DIR;
  const client = options.client ?? process.env.AMUX_V52_REVIEW_CLIENT;
  if (!isAbsolute(directory ?? "") ||
      !isAbsolute(client ?? "")) throw new Error("review launcher configuration missing");
  if (!options.run) requireRootOwnedClient(client);
  const dirStat = lstatSync(directory);
  const uid = options.uid ?? process.getuid?.();
  if (!dirStat.isDirectory() || uid !== undefined && dirStat.uid !== uid ||
      process.platform !== "win32" && (dirStat.mode & 0o077) !== 0)
    throw new Error("unsafe review state directory");
  const path = join(directory, `${input.attemptId}.json`);
  const run = options.run ?? checkedRun;
  const fresh = claim(path, input);
  let state = readState(path, input);
  if (state.final) return { kind: "final", evidence: state.final };
  if (fresh) {
    let repository;
    try {
      repository = options.prepareRepository ?
        options.prepareRepository(input, directory, objectsDir, run) :
        prepareReviewRepository(input, directory, objectsDir, run);
    } catch {
      const final = evidence(input, "unknown");
      durableWrite(path, { input, final });
      return { kind: "final", evidence: final };
    }
    const args = [client, "submit", "--author", input.author,
      "--author-vendor", input.authorVendor,
      "--repo", options.repo ?? "tomverse",
      "--scope", input.scope, "--head", input.commitSha,
      "--head-ref", input.reviewRef];
    if (input.touchesContract) args.push("--reviewers", "2");
    const reply = run("/usr/bin/node", args, repository, 30_000, objectsDir);
    let submitted;
    try { submitted = JSON.parse(reply.stdout); } catch {}
    if (reply.code !== 3 || !JOB.test(submitted?.jobId)) {
      const final = evidence(input, "unknown");
      durableWrite(path, { input, final });
      return { kind: "final", evidence: final };
    }
    state = { input, jobId: submitted.jobId };
    durableWrite(path, state);
    return { kind: "pending", jobId: state.jobId };
  }
  if (!JOB.test(state.jobId)) {
    // A claim without a durable job id may have reached the review server.
    const final = evidence(input, "unknown");
    durableWrite(path, { input, final });
    return { kind: "final", evidence: final };
  }
  const reply = run("/usr/bin/node", [client, "status", state.jobId], directory);
  if (reply.code === 65 && (state.statusFailures ?? 0) < 2) {
    // A known submission is already durable. Retry only its read, never submit.
    durableWrite(path, { ...state,
      statusFailures: (state.statusFailures ?? 0) + 1 });
    return { kind: "pending", jobId: state.jobId };
  }
  let status;
  try { status = JSON.parse(reply.stdout); } catch {}
  const expectedCode = { pending: 3, accept: 0, reject: 1, unknown: 2 }[status?.status];
  const valid = reply.code === expectedCode && status?.jobId === state.jobId &&
    status.base === input.baseSha && status.head === input.commitSha &&
    status.author === input.author &&
    status.repo === (options.repo ?? "tomverse") &&
    status.authorVendor === input.authorVendor &&
    typeof status.touchesContract === "boolean";
  if (valid && status.status === "pending") {
    if (state.statusFailures) durableWrite(path, { input,
      jobId: state.jobId, statusFailures: 0 });
    return { kind: "pending", jobId: state.jobId };
  }
  const vendors = valid ? reviewVendors(status) : null;
  const verdict = valid && vendors &&
    ["accept", "reject"].includes(status.status) &&
    vendors.length >= (input.touchesContract ? 2 : 1) &&
    vendors.every((vendor) => vendor !== input.authorVendor) ?
    status.status : "unknown";
  const final = evidence(input, verdict, state.jobId,
    verdict === "unknown" ? [] : vendors);
  durableWrite(path, { input, final });
  return { kind: "final", evidence: final };
}

export function reviewFindings(jobId, options = {}) {
  if (!JOB.test(jobId)) throw new Error("invalid review job ID");
  const worktree = options.stateDir ?? process.env.AMUX_V52_REVIEW_STATE_DIR;
  const client = options.client ?? process.env.AMUX_V52_REVIEW_CLIENT;
  if (!isAbsolute(worktree ?? "") || !isAbsolute(client ?? ""))
    throw new Error("review launcher configuration missing");
  if (!options.run) requireRootOwnedClient(client);
  const run = options.run ?? checkedRun;
  const statusReply = run("/usr/bin/node", [client, "status", jobId],
    worktree, 12_000);
  let status;
  try { status = JSON.parse(statusReply.stdout); } catch {}
  if (statusReply.code !== 1 || status?.jobId !== jobId ||
      status.status !== "reject" || !Array.isArray(status.reviews) ||
      status.reviews.length > 2)
    throw new Error("review findings unavailable");
  const reports = [];
  for (let index = 0; index < status.reviews.length; index += 1) {
    if (status.reviews[index]?.verdict !== "reject") continue;
    const reply = run("/usr/bin/node", [client, "report", jobId,
      "--slot", String(status.reviews[index].slot)], worktree, 12_000);
    if (reply.code !== 0 || !reply.stdout.trim())
      throw new Error("review findings unavailable");
    reports.push(reply.stdout.trim());
  }
  if (reports.length === 0) throw new Error("review findings unavailable");
  return reports.join("\n\n").slice(0, 8_192);
}

const entry = (() => {
  try { return realpathSync(process.argv[1] ?? "") ===
    realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (entry) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const result = input.op === "step" ? reviewStep(input.review) :
      input.op === "findings" ? { kind: "findings",
        text: reviewFindings(input.jobId) } : null;
    if (!result) throw new Error("invalid review operation");
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`review launcher error: ${error.message}\n`);
    process.exitCode = 65;
  }
}
