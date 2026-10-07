import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const PATCH_LIMIT_BYTES = 65_536;
const OUTPUT_LIMIT_BYTES = PATCH_LIMIT_BYTES + 4_096;
const MAX_PUBLISH_FILE_BYTES = 48 * 1024;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9._@+()\/-]+$/;
// First, local scanner. The app's separate scanner runs before durable storage.
const LOCAL_SECRET_PATTERNS = [
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,255}\b/,
  /\b(?:sk-(?:proj-|ant-)?|xai-)[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:@/]+:[^\s@/]{3,}@/i,
  /\b(?:authorization\s*[:=]\s*["']?bearer|[A-Za-z0-9_]*(?:api[_-]?key|secret|access[_-]?key|token|private[_-]?key|client[_-]?secret)\s*[:=])\s*["']?[A-Za-z0-9._~+/-]{16,}/i,
];
const hasLocalSecret = (value) => LOCAL_SECRET_PATTERNS.some((rule) =>
  rule.test(value));

const gitEnvironment = () => ({
  HOME: "/nonexistent",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
});

async function git(worktreePath, args, run = execFileAsync) {
  const { stdout } = await run("/usr/bin/git", [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-C", worktreePath, ...args,
  ], { env: gitEnvironment(), encoding: "buffer",
    maxBuffer: OUTPUT_LIMIT_BYTES, timeout: 5_000, windowsHide: true });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function modifiedBlobs(worktreePath, options) {
  const names = await git(worktreePath,
    ["diff", "--name-status", "-z", "--no-ext-diff",
      "--no-textconv", "--no-renames", "HEAD", "--"],
    options.run);
  const fields = names.toString("utf8").split("\0");
  if (fields.at(-1) !== "") return { ok: false,
    reason: "publish_files_invalid" };
  fields.pop();
  if (fields.length < 2 || fields.length % 2 !== 0 ||
      fields.length / 2 > 5) return { ok: false,
    reason: "publish_files_unsupported" };
  const files = [];
  const seen = new Set();
  let total = 0;
  for (let i = 0; i < fields.length; i += 2) {
    const [status, path] = [fields[i], fields[i + 1]];
    if (status !== "M" || !SAFE_PATH.test(path) || seen.has(path))
      return { ok: false, reason: "publish_files_unsupported" };
    seen.add(path);
    const filePath = posix.resolve(worktreePath, path);
    if (!filePath.startsWith(`${worktreePath}/`))
      return { ok: false, reason: "publish_files_invalid" };
    let handle;
    try {
      handle = await (options.openFile ?? open)(filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PUBLISH_FILE_BYTES ||
          stat.size < 1) return { ok: false,
        reason: "publish_files_unsupported" };
      const content = await handle.readFile();
      total += content.length;
      if (total > MAX_PUBLISH_FILE_BYTES) {
        content.fill(0);
        return { ok: false, reason: "publish_files_unsupported" };
      }
      const decoded = new TextDecoder("utf-8", { fatal: true })
        .decode(content);
      if (decoded.includes("\0") || hasLocalSecret(decoded)) {
        content.fill(0);
        return { ok: false, reason: "publish_files_secret_or_binary" };
      }
      files.push({ path, mode: "100644", bytesBase64:
        content.toString("base64") });
      content.fill(0);
    } catch { return { ok: false,
      reason: "publish_files_unavailable" }; }
    finally { await handle?.close(); }
  }
  return { ok: true, files };
}

/**
 * The local worker may edit files but has no GitHub write authority. Refuse
 * an implementation run on a dirty or foreign checkout so its patch can be
 * attributed to this attempt. The app and Publisher must independently
 * verify the eventual patch against the remote base and T1 rules.
 */
export async function captureAmuxV22PatchBaseline(worktreePath, options = {}) {
  if (typeof worktreePath !== "string" || !worktreePath.startsWith("/")) {
    return { ok: false, reason: "invalid_worktree" };
  }
  try {
    const root = (await git(worktreePath,
      ["rev-parse", "--show-toplevel"], options.run)).toString("utf8").trim();
    const resolvePath = options.realpath ?? realpath;
    if (await resolvePath(root) !== await resolvePath(worktreePath)) {
      return { ok: false, reason: "foreign_worktree" };
    }
    const baseSha = (await git(worktreePath,
      ["rev-parse", "--verify", "HEAD"], options.run)).toString("ascii").trim();
    if (!SHA.test(baseSha)) return { ok: false, reason: "invalid_base" };
    const status = await git(worktreePath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options.run);
    if (status.length !== 0) return { ok: false, reason: "dirty_worktree" };
    return { ok: true, baseSha };
  } catch {
    return { ok: false, reason: "baseline_unavailable" };
  }
}

/**
 * A patch is only a candidate. Untracked files cannot be represented by
 * git diff HEAD, so refuse the whole candidate instead of silently omitting
 * them. The original task result can still be retained for owner review.
 */
export async function captureAmuxV22Patch(worktreePath, baseSha, options = {}) {
  if (typeof worktreePath !== "string" || !worktreePath.startsWith("/") ||
      !SHA.test(baseSha)) return { ok: false, reason: "invalid_baseline" };
  try {
    const root = (await git(worktreePath,
      ["rev-parse", "--show-toplevel"], options.run)).toString("utf8").trim();
    const resolvePath = options.realpath ?? realpath;
    if (await resolvePath(root) !== await resolvePath(worktreePath)) {
      return { ok: false, reason: "foreign_worktree" };
    }
    const currentSha = (await git(worktreePath,
      ["rev-parse", "--verify", "HEAD"], options.run)).toString("ascii").trim();
    if (currentSha !== baseSha) return { ok: false, reason: "base_moved" };
    const status = await git(worktreePath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options.run);
    if (status.toString("utf8").split("\0").some((entry) =>
      (entry[0] === "?" && entry[1] === "?" && entry[2] === " ") ||
      entry.startsWith("!! "))) {
      return { ok: false, reason: "untracked_files" };
    }
    const patch = await git(worktreePath,
      ["diff", "--binary", "--no-ext-diff", "--no-textconv",
        "--no-renames", "HEAD", "--"], options.run);
    if (patch.length < 1) return { ok: false, reason: "no_change" };
    if (patch.length > PATCH_LIMIT_BYTES || patch.includes(0)) {
      return { ok: false, reason: "patch_not_bounded_text" };
    }
    const body = patch.toString("utf8");
    if (!Buffer.from(body, "utf8").equals(patch)) {
      return { ok: false, reason: "patch_not_bounded_text" };
    }
    if (hasLocalSecret(body)) return { ok: false,
      reason: "patch_secret_detected" };
    const publishFiles = await modifiedBlobs(worktreePath, options);
    return { ok: true, baseSha, patchBody: body,
      patchDigest: createHash("sha256").update(patch).digest("hex"),
      ...(publishFiles.ok ? { publishFiles: publishFiles.files } :
        { publishReason: publishFiles.reason }) };
  } catch {
    return { ok: false, reason: "patch_unavailable" };
  }
}
