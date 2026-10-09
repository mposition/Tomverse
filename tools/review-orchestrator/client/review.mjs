#!/usr/bin/env node
/**
 * Client the Windows apps call. It packs the commits under review into a git
 * bundle and sends the request to the review server over SSH. It never names
 * a reviewer by default: the server picks an independent one. An operator can
 * pin provider ids with --reviewer; server-side eligibility checks still apply.
 *
 *   node tools/review-orchestrator/client/review.mjs submit --author codex [--base <rev>] [--head <rev>]
 *                                          [--reviewers 2] [--scope "..."] [--author-vendor xai]
 *                                          [--focus <rev>]   review only <rev>..HEAD
 *                                          [--reviewer claude] [--reviewer copilot]
 *   node tools/review-orchestrator/client/review.mjs wait <jobId> [--timeout 540]
 *   node tools/review-orchestrator/client/review.mjs status [jobId]
 *   node tools/review-orchestrator/client/review.mjs report <jobId> [--slot 0]
 *
 * Environment:
 *   REVIEW_ORCH_HOST     SSH destination (user@host or a ~/.ssh/config alias),
 *                        default "review-orch" -- the alias the README sets up, so
 *                        an app needs no environment variable (and no restart).
 *   REVIEW_ORCH_REMOTE   remote command, default "review-orchestrator"
 *   REVIEW_ORCH_BASE     default base ref, default "origin/develop"
 *
 * Exit codes are the server's: 0 accept, 1 reject, 2 unknown, 3 pending, 64 usage, 65 error.
 */
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const USAGE = 64;
export const DEFAULT_HOST = "review-orch";

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
      if (key === "reviewer") (options.reviewer ??= []).push(...value.split(","));
      else options[key] = value;
      i += 1;
    } else {
      options._.push(arg);
    }
  }
  return { command, options };
}

export function encodeRpc(request) {
  return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || "").trim()}`);
  return result.stdout.trim();
}

export function repoNameFromRemote(url) {
  const match = /([^/:\\]+?)(?:\.git)?\/?$/.exec(url.trim());
  // Config keys are lower-case names; GitHub repository names are not.
  return match ? match[1].toLowerCase() : null;
}

/**
 * Bundle `base..head` under a ref name unique to this submit, so two submits
 * from worktrees sharing one ref store cannot bundle each other's head.
 */
function createBundle(base, head) {
  const dir = mkdtempSync(join(tmpdir(), "review-orch-"));
  const path = join(dir, "review.bundle");
  const ref = `refs/review-orchestrator/${randomBytes(8).toString("hex")}`;
  git(["update-ref", ref, head]);
  try {
    git(["bundle", "create", path, ref, `^${base}`]);
  } finally {
    spawnSync("git", ["update-ref", "-d", ref]);
  }
  return { path, ref, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const TRUSTED_BASE_REFS = ["origin/develop", "origin/main"];

/**
 * The review base: the most recent fork point between HEAD and a trusted
 * branch (plus an explicit --base, if given). Always a fork point, never a
 * branch tip -- a tip is no ancestor once that branch has moved on. And the
 * nearest one: a develop branch reviewed against main's fork point drags in
 * every commit develop has merged since, hundreds of files that are not this
 * change and that trip the contract-path floor into two reviewers.
 */
export function nearestBase(head, explicit) {
  const refs = explicit ? [explicit, ...TRUSTED_BASE_REFS] : TRUSTED_BASE_REFS;
  const forkPoints = [];
  for (const ref of refs) {
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8" });
    if (exists.status !== 0) {
      if (ref === explicit) throw new Error(`--base ${ref} is not a commit`);
      continue;
    }
    const fork = spawnSync("git", ["merge-base", head, ref], { encoding: "utf8" });
    if (fork.status === 0) forkPoints.push(fork.stdout.trim());
  }
  if (forkPoints.length === 0) throw new Error("no fork point with origin/develop or origin/main; fetch origin first");
  // The descendant of all the others is the nearest. Incomparable fork points
  // cannot be ordered, so keep the first (the explicit one when given).
  const isAncestor = (a, b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b]).status === 0;
  return forkPoints.find((candidate) => forkPoints.every((other) => isAncestor(other, candidate))) ?? forkPoints[0];
}

function transport(token, stdinPath, { capture = false } = {}) {
  const local = process.env.REVIEW_ORCH_LOCAL_BIN;
  let command;
  let args;
  if (local) {
    // Test transport: run the server entry point directly, no SSH.
    command = process.execPath;
    args = [local, "rpc", token];
  } else {
    const host = process.env.REVIEW_ORCH_HOST || DEFAULT_HOST;
    command = process.env.REVIEW_ORCH_SSH || "ssh";
    args = ["-o", "BatchMode=yes", host, process.env.REVIEW_ORCH_REMOTE || "review-orchestrator", "rpc", token];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdinPath ? "pipe" : "ignore", capture ? "pipe" : "inherit", "inherit"],
      timeout: capture ? 30_000 : undefined,
    });
    let stdout = "";
    if (capture) child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 1_000_000) { child.kill(); reject(new Error("server status response too large")); }
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(capture ? { code: code ?? 65, stdout } : code ?? 65));
    if (stdinPath) {
      // If the server closes early, its exit code is the answer; a broken pipe is not.
      child.stdin.on("error", () => {});
      const source = createReadStream(stdinPath);
      source.on("error", reject);
      source.pipe(child.stdin);
    }
  });
}

export function supportsReviewerSelection(status) {
  return Array.isArray(status?.capabilities) && status.capabilities.includes("reviewer-selection-v1");
}

async function submit(options) {
  const author = options.author;
  if (!author) throw new Error("--author is required (claude, codex, cursor, ...)");
  if (options.reviewer) {
    // An older server ignores unknown request fields; never silently send a
    // pinned request to it and receive an automatically assigned reviewer.
    const reply = await transport(encodeRpc({ command: "status" }), null, { capture: true });
    let status;
    try { status = JSON.parse(reply.stdout); } catch { /* unavailable capability */ }
    if (reply.code !== 0 || !supportsReviewerSelection(status)) {
      throw new Error("reviewer_selection_unsupported: update the server before using --reviewer");
    }
  }
  const head = git(["rev-parse", "--verify", `${options.head ?? "HEAD"}^{commit}`]);
  const base = nearestBase(head, options.base ?? process.env.REVIEW_ORCH_BASE);
  if (base === head) throw new Error("nothing to review: head equals base");
  // --focus <rev>: show the reviewer only <rev>..HEAD (say, what changed since
  // the last review round). The server checks it lies between base and HEAD.
  const focus = options.focus ? git(["rev-parse", "--verify", `${options.focus}^{commit}`]) : undefined;
  if (git(["status", "--porcelain", "--untracked-files=no"]) !== "") {
    process.stderr.write("warning: uncommitted changes are not part of the review; only committed work is sent\n");
  }
  const repo = options.repo ?? repoNameFromRemote(git(["remote", "get-url", "origin"]));
  const bundle = createBundle(base, head);
  try {
    const request = {
      command: "submit",
      repo,
      base,
      head,
      author,
      authorVendor: options["author-vendor"],
      reviewers: options.reviewers ? Number(options.reviewers) : 1,
      reviewerProviders: options.reviewer,
      scope: options.scope,
      focus,
      bundleRef: bundle.ref,
    };
    return await transport(encodeRpc(request), bundle.path);
  } finally {
    bundle.cleanup();
  }
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === "submit") return submit(options);
  if (command === "wait" || command === "status" || command === "report") {
    const request = { command, jobId: options._[0] };
    if (options.timeout) request.timeoutSeconds = Number(options.timeout);
    if (options.slot) request.slot = Number(options.slot);
    if (command !== "status" && !request.jobId) throw new Error(`${command} needs a job id`);
    return transport(encodeRpc(request), null);
  }
  throw new Error("usage: review.mjs submit|wait|status|report ...");
}

// Compare real paths: a symlinked launcher must still run main, not exit 0 silently.
const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${JSON.stringify({ error: "client", message: error.message })}\n`);
      process.exit(USAGE);
    },
  );
}
