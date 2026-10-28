import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";
import { AMUX_CONTRACT_PATHS, classifyAmuxExecutionPath } from
  "./executionGradeCore.ts";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const PATCH_LIMIT_BYTES = 65_536;
const OUTPUT_LIMIT_BYTES = PATCH_LIMIT_BYTES + 4_096;
const MAX_PUBLISH_FILE_BYTES = 48 * 1024;
// Leave ample room in the app's 64 KiB settlement body for the receipt echo.
const MAX_CHANGED_PATHS_JSON_BYTES = 24 * 1024;
const ignoredContractPathspecs = [...new Set(AMUX_CONTRACT_PATHS.flatMap((path) => {
  if (path.endsWith("/")) return [`:(icase,literal)${path}`];
  // Git glob pathspecs treat brackets as patterns, including Next route names.
  if (/[?*[\]\\]/.test(path)) {
    return [`:(icase,literal)${path.slice(0, path.lastIndexOf("/") + 1)}`];
  }
  return [`:(icase,glob)${path}*`, `:(icase,glob)${path}*/**`];
}))];
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

async function git(worktreePath, args, run = execFileAsync,
  maxBuffer = OUTPUT_LIMIT_BYTES, timeout = 5_000) {
  const { stdout } = await run("/usr/bin/git", [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-C", worktreePath, ...args,
  ], { env: gitEnvironment(), encoding: "buffer",
    maxBuffer, timeout, windowsHide: true });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

/** Move a clean worker checkout to the commit the Task's publication run was
 * pinned to, before the CLI starts. Settlement accepts a patch only on that
 * base, and the patch and its v52 review commit are built on HEAD. A dirty
 * checkout or a base that cannot be fetched fails the attempt before the CLI
 * runs; nothing is reset or deleted to make it fit. */
export async function syncAmuxV22WorktreeBase(worktreePath, baseSha,
  options = {}) {
  if (typeof worktreePath !== "string" || !worktreePath.startsWith("/") ||
      !SHA.test(baseSha ?? ""))
    return { ok: false, reason: "invalid_input" };
  const run = options.run;
  const present = async () => {
    try {
      await git(worktreePath, ["cat-file", "-e", `${baseSha}^{commit}`], run);
      return true;
    } catch { return false; }
  };
  try {
    // A path inside some other repository would move that repository's HEAD.
    const root = (await git(worktreePath, ["rev-parse", "--show-toplevel"],
      run)).toString("utf8").trim();
    const resolvePath = options.realpath ?? realpath;
    if (await resolvePath(root) !== await resolvePath(worktreePath))
      return { ok: false, reason: "foreign_worktree" };
    const status = await git(worktreePath, ["status", "--porcelain=v1", "-z",
      "--untracked-files=all"], run);
    if (status.length !== 0) return { ok: false, reason: "worktree_dirty" };
    // The base was develop's head when the attempt started, so fetching
    // develop brings it; an exact-object fetch covers a develop that moved on
    // by a force push.
    for (const ref of ["refs/heads/develop", baseSha]) {
      if (await present()) break;
      try {
        await git(worktreePath, ["fetch", "--no-tags", "--quiet", "origin", ref],
          run, OUTPUT_LIMIT_BYTES, 120_000);
      } catch { /* the presence check below decides */ }
    }
    if (!(await present())) return { ok: false, reason: "base_unavailable" };
    // An ignored local file in the way of a tracked path fails the checkout
    // instead of being overwritten.
    await git(worktreePath, ["checkout", "--quiet", "--no-overwrite-ignore",
      "--detach", baseSha], run);
    const head = (await git(worktreePath, ["rev-parse", "--verify", "HEAD"],
      run)).toString("ascii").trim();
    return head === baseSha ? { ok: true, baseSha } :
      { ok: false, reason: "base_checkout_unverified" };
  } catch { return { ok: false, reason: "base_checkout_unavailable" }; }
}

/** Complete local path inventory, independent of the bounded publish patch.
 * A missing or undecodable list is never evidence that no contract file moved. */
export async function captureAmuxV52ChangedPaths(worktreePath, baseSha, options = {}) {
  if (typeof worktreePath !== "string" || !worktreePath.startsWith("/") ||
      !SHA.test(baseSha)) return { ok: false, reason: "invalid_baseline" };
  try {
    const root = (await git(worktreePath, ["rev-parse", "--show-toplevel"],
      options.run)).toString("utf8").trim();
    const resolvePath = options.realpath ?? realpath;
    if (await resolvePath(root) !== await resolvePath(worktreePath))
      return { ok: false, reason: "foreign_worktree" };
    const head = (await git(worktreePath, ["rev-parse", "--verify", "HEAD"],
      options.run)).toString("ascii").trim();
    if (head !== baseSha) return { ok: false, reason: "base_moved" };
    const limit = 32 * 1024;
    const [changed, untracked, ignoredContract] = await Promise.all([
      git(worktreePath, ["diff", "--name-only", "-z", "--no-ext-diff",
        "--no-textconv", "--no-renames", baseSha, "--"], options.run, limit),
      git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"],
        options.run, limit),
      git(worktreePath, ["ls-files", "--others", "--ignored",
        "--exclude-standard", "-z", "--", ...ignoredContractPathspecs],
      options.run, limit),
    ]);
    const decode = (buffer) => {
      if (buffer.length === 0) return [];
      const value = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      if (!value.endsWith("\0")) throw new TypeError("unterminated names");
      return value.slice(0, -1).split("\0");
    };
    const ignored = decode(ignoredContract).filter((path) =>
      classifyAmuxExecutionPath(path) !== "ordinary");
    const files = [...new Set([...decode(changed), ...decode(untracked),
      ...ignored])].sort();
    if (files.length > 4_096 ||
        Buffer.byteLength(JSON.stringify(files), "utf8") >
          MAX_CHANGED_PATHS_JSON_BYTES)
      return { ok: false, reason: "changed_paths_unavailable" };
    const classes = files.map(classifyAmuxExecutionPath);
    if (classes.includes("invalid")) return { ok: false, reason: "invalid_path" };
    return { ok: true, baseSha, files,
      contractPaths: files.filter((_, index) => classes[index] === "contract") };
  } catch { return { ok: false, reason: "changed_paths_unavailable" }; }
}

/** Build the exact local commit reviewed by the launcher. HEAD never moves;
 * the attempt's edits are discarded after the commit object is verified. */
export async function captureAmuxV52ReviewCommit(worktreePath, baseSha,
  attemptId, changedPaths, patchBody, options = {}) {
  if (typeof worktreePath !== "string" || !worktreePath.startsWith("/") ||
      !SHA.test(baseSha) ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,40}$/i.test(attemptId) ||
      !Array.isArray(changedPaths) || changedPaths.length === 0 ||
      typeof patchBody !== "string")
    return { ok: false, reason: "review_commit_invalid_input" };
  try {
    const root = (await git(worktreePath, ["rev-parse", "--show-toplevel"],
      options.run)).toString("utf8").trim();
    const resolvePath = options.realpath ?? realpath;
    if (await resolvePath(root) !== await resolvePath(worktreePath))
      return { ok: false, reason: "foreign_worktree" };
    const head = (await git(worktreePath, ["rev-parse", "--verify", "HEAD"],
      options.run)).toString("ascii").trim();
    if (head !== baseSha)
      return { ok: false, reason: "base_moved" };
    let result;
    try {
      if (changedPaths.some((path) =>
        classifyAmuxExecutionPath(path) === "invalid"))
        return { ok: false, reason: "review_commit_invalid_input" };
      await git(worktreePath, ["add", "-A", "--",
        ...changedPaths.map((path) => `:(literal)${path}`)], options.run);
      result = await (async () => {
        const staged = await git(worktreePath, ["diff", "--cached", "--binary",
          "--no-ext-diff", "--no-textconv", "--no-renames", baseSha, "--"],
        options.run);
        if (!staged.equals(Buffer.from(patchBody, "utf8")))
          return { ok: false, reason: "review_patch_mismatch" };
        const tree = (await git(worktreePath, ["write-tree"], options.run))
          .toString("ascii").trim();
        if (!SHA.test(tree))
          return { ok: false, reason: "review_tree_unavailable" };
        const commitSha = (await git(worktreePath, [
          "-c", "user.name=Tomverse AMUX", "-c", "user.email=amux@tomverse.app",
          "-c", "commit.gpgsign=false", "commit-tree", tree, "-p", baseSha,
          "-m", `AMUX Task ${attemptId}`,
        ], options.run)).toString("ascii").trim();
        if (!SHA.test(commitSha))
          return { ok: false, reason: "review_commit_unavailable" };
        const names = await git(worktreePath, ["diff-tree", "--no-commit-id",
          "--name-only", "--no-renames", "-r", "-z", commitSha],
        options.run, 32 * 1024);
        const encoded = new TextDecoder("utf-8", { fatal: true }).decode(names);
        if (!encoded.endsWith("\0"))
          return { ok: false, reason: "review_commit_paths_unavailable" };
        const committed = encoded.slice(0, -1).split("\0").sort();
        if (JSON.stringify(committed) !== JSON.stringify([...changedPaths].sort()))
          return { ok: false, reason: "review_commit_paths_mismatch" };
        const reviewRef = `refs/amux-v52-review/${attemptId}`;
        await git(worktreePath, ["update-ref", reviewRef, commitSha,
          "0".repeat(40)], options.run);
        return { ok: true, baseSha, commitSha, reviewRef };
      })();
    } catch {
      result = { ok: false, reason: "review_commit_unavailable" };
    }
    // The review ref keeps the commit while the sidecar transfers patch bytes.
    // Every post-stage failure must leave a clean base and index.
    try {
      await git(worktreePath, ["reset", "--hard", baseSha], options.run);
      const status = await git(worktreePath, ["status", "--porcelain=v1", "-z",
        "--untracked-files=all"], options.run);
      if (status.length !== 0)
        return { ok: false, reason: "review_cleanup_unavailable" };
    } catch { return { ok: false, reason: "review_cleanup_unavailable" }; }
    return result;
  } catch { return { ok: false, reason: "review_commit_unavailable" }; }
}

/** Drop only a fenced attempt's changes from its initially clean worktree. */
export async function discardAmuxV52AttemptChanges(worktreePath, baseSha,
  options = {}) {
  if (typeof worktreePath !== "string" || !worktreePath.startsWith("/") ||
      !SHA.test(baseSha)) return false;
  try {
    const root = (await git(worktreePath, ["rev-parse", "--show-toplevel"],
      options.run)).toString("utf8").trim();
    const resolvePath = options.realpath ?? realpath;
    if (await resolvePath(root) !== await resolvePath(worktreePath)) return false;
    const head = (await git(worktreePath, ["rev-parse", "--verify", "HEAD"],
      options.run)).toString("ascii").trim();
    if (head !== baseSha) return false;
    const ignoredContract = await git(worktreePath,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z",
        "--", ...ignoredContractPathspecs], options.run, 32 * 1024);
    const encoded = new TextDecoder("utf-8", { fatal: true })
      .decode(ignoredContract);
    if (encoded && !encoded.endsWith("\0")) return false;
    const ignoredNames = encoded ? encoded.slice(0, -1).split("\0") : [];
    if (ignoredNames.some((path) =>
      classifyAmuxExecutionPath(path) === "invalid")) return false;
    const ignoredPaths = ignoredNames.filter((path) =>
      classifyAmuxExecutionPath(path) === "contract");
    await git(worktreePath, ["reset", "--hard", baseSha], options.run);
    await git(worktreePath, ["clean", "-fd", "--"], options.run);
    for (let index = 0; index < ignoredPaths.length; index += 64)
      await git(worktreePath, ["clean", "-fdx", "--",
        ...ignoredPaths.slice(index, index + 64).map((path) =>
          `:(literal)${path}`)], options.run);
    const [status, remainingIgnoredContract] = await Promise.all([
      git(worktreePath, ["status", "--porcelain=v1", "-z",
        "--untracked-files=all"], options.run),
      git(worktreePath, ["ls-files", "--others", "--ignored",
        "--exclude-standard", "-z", "--", ...ignoredContractPathspecs],
      options.run),
    ]);
    const remaining = new TextDecoder("utf-8", { fatal: true })
      .decode(remainingIgnoredContract);
    if (remaining && !remaining.endsWith("\0")) return false;
    return status.length === 0 && (!remaining || remaining.slice(0, -1)
      .split("\0").every((path) =>
        classifyAmuxExecutionPath(path) === "ordinary"));
  } catch { return false; }
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
    if (status !== "M" && !(options.allowUntracked && status === "A") ||
        !SAFE_PATH.test(path) || seen.has(path))
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
    if (options.guardIgnoredContract === true) {
      const ignoredContract = await git(worktreePath,
        ["ls-files", "--others", "--ignored", "--exclude-standard", "-z",
          "--", ...ignoredContractPathspecs], options.run, 32 * 1024);
      const ignoredNames = new TextDecoder("utf-8", { fatal: true })
        .decode(ignoredContract);
      if (ignoredNames && !ignoredNames.endsWith("\0"))
        return { ok: false, reason: "baseline_unavailable" };
      if (ignoredNames && ignoredNames.slice(0, -1).split("\0").some((path) =>
        classifyAmuxExecutionPath(path) !== "ordinary"))
        return { ok: false, reason: "dirty_worktree" };
    }
    return { ok: true, baseSha };
  } catch {
    return { ok: false, reason: "baseline_unavailable" };
  }
}

/**
 * A patch is only a candidate. Legacy attempts refuse untracked files. V52
 * uses intent-to-add for bounded new paths, then clears those index entries.
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
    const hasUntracked = status.toString("utf8").split("\0").some((entry) =>
      (entry[0] === "?" && entry[1] === "?" && entry[2] === " ") ||
      entry.startsWith("!! "));
    if (hasUntracked && !options.allowUntracked) {
      return { ok: false, reason: "untracked_files" };
    }
    let intentPaths = [];
    try {
      if (hasUntracked) {
        const names = await git(worktreePath,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          options.run, 32 * 1024);
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(names);
        if (!decoded.endsWith("\0"))
          return { ok: false, reason: "untracked_files" };
        const untrackedPaths = decoded.slice(0, -1).split("\0");
        if (untrackedPaths.some((path) => !SAFE_PATH.test(path)))
          return { ok: false, reason: "untracked_files" };
        intentPaths = untrackedPaths;
        await git(worktreePath, ["add", "-N", "--",
          ...intentPaths.map((path) => `:(literal)${path}`)], options.run);
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
    } finally {
      if (intentPaths.length) await git(worktreePath, ["reset", "--",
        ...intentPaths.map((path) => `:(literal)${path}`)], options.run);
    }
  } catch {
    return { ok: false, reason: "patch_unavailable" };
  }
}
