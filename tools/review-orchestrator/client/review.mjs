#!/usr/bin/env node
/**
 * Client the Windows apps call. It packs the commits under review into a git
 * bundle and sends the request to the review server over SSH. It never names
 * a reviewer: the server picks one whose model vendor differs from the author's.
 *
 *   node tools/review-orchestrator/client/review.mjs submit --author codex [--base <rev>] [--head <rev>]
 *                                          [--reviewers 2] [--scope "..."] [--author-vendor xai]
 *   node tools/review-orchestrator/client/review.mjs wait <jobId> [--timeout 540]
 *   node tools/review-orchestrator/client/review.mjs status [jobId]
 *   node tools/review-orchestrator/client/review.mjs report <jobId> [--slot 0]
 *
 * Environment:
 *   REVIEW_ORCH_HOST     SSH destination (user@host or a ~/.ssh/config alias). Required.
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

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
      options[key] = value;
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
  return match ? match[1] : null;
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

function transport(token, stdinPath) {
  const local = process.env.REVIEW_ORCH_LOCAL_BIN;
  let command;
  let args;
  if (local) {
    // Test transport: run the server entry point directly, no SSH.
    command = process.execPath;
    args = [local, "rpc", token];
  } else {
    const host = process.env.REVIEW_ORCH_HOST;
    if (!host) throw new Error("REVIEW_ORCH_HOST is not set");
    command = process.env.REVIEW_ORCH_SSH || "ssh";
    args = ["-o", "BatchMode=yes", host, process.env.REVIEW_ORCH_REMOTE || "review-orchestrator", "rpc", token];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [stdinPath ? "pipe" : "ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 65));
    if (stdinPath) {
      // If the server closes early, its exit code is the answer; a broken pipe is not.
      child.stdin.on("error", () => {});
      const source = createReadStream(stdinPath);
      source.on("error", reject);
      source.pipe(child.stdin);
    }
  });
}

async function submit(options) {
  const author = options.author;
  if (!author) throw new Error("--author is required (claude, codex, cursor, ...)");
  const head = git(["rev-parse", "--verify", `${options.head ?? "HEAD"}^{commit}`]);
  const baseRef = options.base ?? process.env.REVIEW_ORCH_BASE ?? "origin/develop";
  const base = options.base
    ? git(["rev-parse", "--verify", `${baseRef}^{commit}`])
    : git(["merge-base", head, baseRef]);
  if (base === head) throw new Error("nothing to review: head equals base");
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
      scope: options.scope,
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
