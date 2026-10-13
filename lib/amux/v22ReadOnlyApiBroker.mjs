import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";

import {
  AMUX_V22_READ_ONLY_API_BROKER_POLICY,
  AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  amuxV22ReadOnlyApiRepositoryScopeDigest,
} from "./v22ReadOnlyApiProtocol.mjs";

const DENIED_SEGMENT = /^(?:\.git|\.env.*|\.ssh|\.claude|\.codex)$/i;
const DENIED_NAME = /(?:credential|credentials|secret|secrets|id_rsa|id_ed25519|\.npmrc|\.netrc)/i;
const SECRET_BYTES = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/,
  /\bsk-(?:proj|live)-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:^|\n)\s*(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|DATABASE_URL)\s*=/i,
  /\b(?:password|secret|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{12,}/i,
];

const bytewise = (left, right) => Buffer.compare(Buffer.from(left, "utf8"),
  Buffer.from(right, "utf8"));
const exactKeys = (value, keys) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const snapshots = new WeakMap();
class PackedGitObjectRequiredError extends Error {}
const GIT_OBJECT_MAX_BYTES = 2 * 1024 * 1024;
const GIT_COMPRESSED_MAX_BYTES = GIT_OBJECT_MAX_BYTES + 64 * 1024;
const GIT_COMMIT_MAX_BYTES = 64 * 1024;
const GIT_CHILD_TIMEOUT_MS = 750;
const GIT_CHILD_STDERR_MAX_BYTES = 16 * 1024;
const GIT_BINARY_MAX_BYTES = 64 * 1024 * 1024;
const GIT_CONFIG_MAX_BYTES = 16 * 1024;
const GIT_PACKED_REFS_MAX_BYTES = 2 * 1024 * 1024;
const GIT_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const FIXED_GIT_BINARY = process.platform === "win32" ?
  "C:\\Program Files\\Git\\mingw64\\bin\\git.exe" : "/usr/bin/git";
const FIXED_GIT_COMMON_ARGS = Object.freeze([
  "--no-pager", "--no-replace-objects", "--literal-pathspecs",
  "-c", `core.hooksPath=${GIT_NULL_DEVICE}`,
  "-c", "core.fsmonitor=false",
  "-c", "credential.helper=",
  "-c", "protocol.allow=never",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "submodule.recurse=false",
]);
const FIXED_GIT_ENVIRONMENT = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: GIT_NULL_DEVICE,
  GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
  GIT_CONFIG_COUNT: "0",
  GIT_NO_LAZY_FETCH: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
});
const FIXED_GIT_POLICY = Object.freeze({
  version: 1,
  binary: FIXED_GIT_BINARY,
  commonArgs: FIXED_GIT_COMMON_ARGS,
  environment: FIXED_GIT_ENVIRONMENT,
  dynamicEnvironment: Object.freeze({
    GIT_DIR: "<repository-root>/.git/logs",
    GIT_COMMON_DIR: "<repository-root>/.git/logs",
    GIT_OBJECT_DIRECTORY: "<repository-root>/.git/objects",
  }),
  repositoryLocalConfig: "strict-core-plus-remote-origin-verified-but-not-loaded-by-child",
  childGitDir: "configless-reflog-directory-pre-and-post-verified",
  operations: Object.freeze({
    verifyCommit: Object.freeze(["rev-parse", "--verify", "<revision>^{commit}"]),
    verifyTree: Object.freeze(["rev-parse", "--verify", "<revision>^{tree}"]),
    listTree: Object.freeze(["ls-tree", "-r", "-t", "-z", "-l", "--full-tree",
      "<revision>", "--", "<allowed-prefixes>"]),
    readBlobs: Object.freeze(["cat-file", "--batch"]),
  }),
  childTimeoutMs: GIT_CHILD_TIMEOUT_MS,
  stderrMaxBytes: GIT_CHILD_STDERR_MAX_BYTES,
  maxConcurrentChildren: 1,
  inheritedEnvironment: false,
  shell: false,
  network: false,
  writes: false,
  replaceObjects: false,
  lazyFetch: false,
  alternates: false,
});
const GIT_PROOF_POLICY = Object.freeze({
  version: 2,
  storage: "native-loose-with-fixed-git-packed-fallback",
  head: "detached-or-one-loose-head-ref",
  objectTypes: Object.freeze(["commit", "tree", "blob"]),
  fileModes: Object.freeze(["100644", "100755"]),
  childProcesses: "fixed-git-packed-fallback-only",
  packedObjects: true,
  alternates: false,
  maxObjectBytes: GIT_OBJECT_MAX_BYTES,
  maxCommitBytes: GIT_COMMIT_MAX_BYTES,
  fixedGit: FIXED_GIT_POLICY,
});
let activeGitChildren = 0;

export class AmuxV22ReadOnlyApiBrokerError extends Error {
  constructor(code) {
    super(code);
    this.name = "AmuxV22ReadOnlyApiBrokerError";
    this.code = code;
  }
}

const refuse = code => { throw new AmuxV22ReadOnlyApiBrokerError(code); };

const canonicalRelativePath = value => {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
      value.includes("\0") || value.includes("\\") || isAbsolute(value) ||
      value.startsWith("/") || value.endsWith("/")) refuse("path_refused");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." ||
      DENIED_SEGMENT.test(part) || DENIED_NAME.test(part))) refuse("path_refused");
  return parts.join("/");
};

const withinPrefix = (path, prefixes) => prefixes.some(prefix =>
  path === prefix || path.startsWith(`${prefix}/`));

const textBytes = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.includes(0)) refuse("content_refused");
  for (const pattern of SECRET_BYTES) {
    if (pattern.test(bytes.toString("utf8"))) refuse("content_refused");
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return refuse("content_refused"); }
};

const globRegex = pattern => {
  canonicalRelativePath(pattern.replaceAll("*", "x").replaceAll("?", "x"));
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
};

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino &&
  left.ctimeMs === right.ctimeMs && left.size === right.size;
const canonicalJson = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

const samePath = (left, right) => process.platform === "win32" ?
  resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

async function assertPlainDirectory(fs, path) {
  const before = await fs.lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink() ||
      !samePath(await fs.realpath(path), path)) refuse("snapshot_invalid");
  return before;
}

async function assertDirectoryChain(fs, root, target) {
  const back = relative(root, target);
  if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back))
    refuse("snapshot_invalid");
  let current = root;
  await assertPlainDirectory(fs, current);
  if (!back) return;
  for (const part of back.split(sep)) {
    if (!part || part === "." || part === "..") refuse("snapshot_invalid");
    current = join(current, part);
    await assertPlainDirectory(fs, current);
  }
}

async function readStableFile(fs, root, path, maxBytes) {
  await assertDirectoryChain(fs, root, dirname(path));
  const before = await fs.lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size < 1 || before.size > maxBytes || !samePath(await fs.realpath(path), path))
    refuse("snapshot_invalid");
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(opened, before))
      refuse("snapshot_invalid");
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead < 1) refuse("snapshot_invalid");
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await fs.lstat(path);
    if (!sameIdentity(after, opened) || !sameIdentity(pathAfter, opened))
      refuse("snapshot_invalid");
    await assertDirectoryChain(fs, root, dirname(path));
    return bytes;
  } finally { await handle.close(); }
}

function parseMinimalGitConfig(bytes, revisionLength) {
  const text = strictUtf8(bytes);
  const entries = new Map();
  let section = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([a-z]+)\]$/iu.exec(line);
    const remoteOriginMatch = /^\[remote "origin"\]$/iu.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      if (!["core", "extensions"].includes(section)) refuse("snapshot_invalid");
      continue;
    }
    if (remoteOriginMatch) {
      section = "remote.origin";
      continue;
    }
    const entry = /^([a-z][a-z0-9-]*)\s*=\s*([^"'\\#;\s][^"'\\#;]*)$/iu.exec(line);
    if (!section || !entry) refuse("snapshot_invalid");
    const key = `${section}.${entry[1].toLowerCase()}`;
    const value = entry[2].trim().toLowerCase();
    const boolean = ["true", "false"].includes(value);
    const allowed = key === "core.repositoryformatversion" ? ["0", "1"].includes(value) :
      key === "core.bare" ? value === "false" :
      ["core.filemode", "core.logallrefupdates", "core.ignorecase", "core.symlinks",
        "core.precomposeunicode"].includes(key) ? boolean :
      key === "extensions.objectformat" ? value === "sha256" :
      key === "remote.origin.url" ?
        /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._~!$&'()*+,=:@%\/-]*)?$/iu.test(value) :
      key === "remote.origin.fetch" ?
        value === "+refs/heads/*:refs/remotes/origin/*" : false;
    if (!allowed || entries.has(key)) refuse("snapshot_invalid");
    entries.set(key, value);
  }
  if (!entries.has("core.repositoryformatversion") || entries.get("core.bare") !== "false" ||
      !entries.has("core.filemode") || !entries.has("core.logallrefupdates"))
    refuse("snapshot_invalid");
  if (revisionLength === 40 && (entries.get("core.repositoryformatversion") !== "0" ||
      entries.has("extensions.objectformat"))) refuse("snapshot_invalid");
  if (revisionLength === 64 && (entries.get("core.repositoryformatversion") !== "1" ||
      entries.get("extensions.objectformat") !== "sha256")) refuse("snapshot_invalid");
}

async function safeGitConfigRecord(gitRoot, revisionLength, fs) {
  const bytes = await readStableFile(fs, gitRoot, join(gitRoot, "config"),
    GIT_CONFIG_MAX_BYTES);
  parseMinimalGitConfig(bytes, revisionLength);
  return Object.freeze({ digest: sha256(bytes), size: bytes.length });
}

async function assertNoGitAlternates(gitRoot, fs) {
  for (const name of ["alternates", "http-alternates"]) {
    try {
      await fs.lstat(join(gitRoot, "objects", "info", name));
      refuse("snapshot_invalid");
    } catch (error) {
      if (error instanceof AmuxV22ReadOnlyApiBrokerError || error?.code !== "ENOENT") throw error;
    }
  }
}

async function assertConfiglessGitDirectory(path, fs) {
  await assertPlainDirectory(fs, path);
  for (const name of ["config", "config.worktree", "commondir"]) {
    try {
      await fs.lstat(join(path, name));
      refuse("snapshot_invalid");
    } catch (error) {
      if (error instanceof AmuxV22ReadOnlyApiBrokerError || error?.code !== "ENOENT") throw error;
    }
  }
}

const fixedGitEnvironment = proof => Object.freeze({
  ...FIXED_GIT_ENVIRONMENT,
  GIT_DIR: proof.childGitDir,
  GIT_COMMON_DIR: proof.childGitDir,
  GIT_OBJECT_DIRECTORY: proof.objectDirectory,
});

async function fixedGitBinaryRecord(fs) {
  const path = FIXED_GIT_BINARY;
  const before = await fs.lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 ||
      before.size > GIT_BINARY_MAX_BYTES || !samePath(await fs.realpath(path), path) ||
      (process.platform !== "win32" &&
        (before.uid !== 0 || (before.mode & 0o022) !== 0))) refuse("snapshot_invalid");
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(opened, before)) refuse("snapshot_invalid");
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(chunk.length, opened.size - offset);
      const result = await handle.read(chunk, 0, length, offset);
      if (result.bytesRead !== length) refuse("snapshot_invalid");
      hash.update(chunk.subarray(0, length));
      offset += length;
    }
    const after = await handle.stat();
    if (!sameIdentity(after, opened)) refuse("snapshot_invalid");
    return Object.freeze({ path, digest: hash.digest("hex"), dev: opened.dev,
      ino: opened.ino, ctimeMs: opened.ctimeMs, size: opened.size,
      mode: opened.mode, uid: opened.uid });
  } finally { chunk.fill(0); await handle.close(); }
}

async function assertFixedGitBinary(fs, record) {
  const info = await fs.lstat(record.path);
  if (!info.isFile() || info.isSymbolicLink() || !sameIdentity(info, record) ||
      info.mode !== record.mode || info.uid !== record.uid ||
      !samePath(await fs.realpath(record.path), record.path) ||
      (process.platform !== "win32" &&
        (info.uid !== 0 || (info.mode & 0o022) !== 0))) refuse("snapshot_invalid");
}

function fixedGitArgs(operation, values) {
  if (!REVISION.test(values.sourceRevision)) refuse("snapshot_invalid");
  const prefix = [...FIXED_GIT_COMMON_ARGS];
  if (operation === "verifyCommit")
    return [...prefix, "rev-parse", "--verify", `${values.sourceRevision}^{commit}`];
  if (operation === "verifyTree")
    return [...prefix, "rev-parse", "--verify", `${values.sourceRevision}^{tree}`];
  if (operation === "listTree") {
    if (!Array.isArray(values.allowedPrefixes) || values.allowedPrefixes.some(path =>
      canonicalRelativePath(path) !== path)) refuse("snapshot_invalid");
    return [...prefix, "ls-tree", "-r", "-t", "-z", "-l", "--full-tree",
      values.sourceRevision, "--", ...values.allowedPrefixes];
  }
  if (operation === "readBlobs") return [...prefix, "cat-file", "--batch"];
  return refuse("snapshot_invalid");
}

async function runFixedGit(root, fs, proof, operation, values, input, outputLimit) {
  if (activeGitChildren >= FIXED_GIT_POLICY.maxConcurrentChildren)
    refuse("snapshot_invalid");
  await assertFixedGitBinary(fs, proof.binary);
  const config = await safeGitConfigRecord(proof.gitRoot, values.sourceRevision.length, fs);
  if (config.digest !== proof.config.digest || config.size !== proof.config.size)
    refuse("snapshot_invalid");
  await assertNoGitAlternates(proof.gitRoot, fs);
  await assertConfiglessGitDirectory(proof.childGitDir, fs);
  const args = fixedGitArgs(operation, values);
  const environment = fixedGitEnvironment(proof);
  activeGitChildren += 1;
  let output;
  try {
    output = await new Promise((resolvePromise, rejectPromise) => {
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const chunks = [];
      let failure = null;
      let settled = false;
      const child = spawn(proof.binary.path, args, {
        cwd: root,
        env: { ...environment },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };
      const timer = setTimeout(() => {
        failure = new Error("git_timeout");
        child.kill("SIGKILL");
      }, GIT_CHILD_TIMEOUT_MS);
      child.once("error", error => finish(error));
      child.stdout.on("data", chunk => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > outputLimit) {
          failure = new Error("git_output_limit");
          child.kill("SIGKILL");
        } else chunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > GIT_CHILD_STDERR_MAX_BYTES) {
          failure = new Error("git_stderr_limit");
          child.kill("SIGKILL");
        }
      });
      child.once("close", code => {
        if (failure || code !== 0) finish(failure ?? new Error("git_refused"));
        else finish(null, Buffer.concat(chunks, stdoutBytes));
      });
      child.stdin.once("error", error => {
        failure = error;
        child.kill("SIGKILL");
      });
      child.stdin.end(input ?? undefined);
    });
  } catch { return refuse("snapshot_invalid"); }
  finally { activeGitChildren -= 1; }
  await assertFixedGitBinary(fs, proof.binary);
  const configAfter = await safeGitConfigRecord(proof.gitRoot,
    values.sourceRevision.length, fs);
  if (configAfter.digest !== proof.config.digest || configAfter.size !== proof.config.size)
    refuse("snapshot_invalid");
  await assertNoGitAlternates(proof.gitRoot, fs);
  await assertConfiglessGitDirectory(proof.childGitDir, fs);
  return output;
}

function strictUtf8(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return refuse("snapshot_invalid"); }
}

async function readHeadCommit(gitRoot, revisionLength, fs) {
  const head = strictUtf8(await readStableFile(fs, gitRoot, join(gitRoot, "HEAD"), 512));
  const direct = /^([a-f0-9]+)\r?\n?$/u.exec(head);
  if (direct) {
    if (direct[1].length !== revisionLength) refuse("snapshot_invalid");
    return direct[1];
  }
  const symbolic = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)\r?\n?$/u.exec(head);
  if (!symbolic || symbolic[1].length > 256 || symbolic[1].split("/").some(part =>
    !part || part === "." || part === ".." || part.endsWith(".lock")))
    refuse("snapshot_invalid");
  const refPath = join(gitRoot, ...symbolic[1].split("/"));
  try {
    const ref = /^([a-f0-9]+)\r?\n?$/u.exec(strictUtf8(
      await readStableFile(fs, gitRoot, refPath, 256)));
    if (!ref || ref[1].length !== revisionLength) refuse("snapshot_invalid");
    return ref[1];
  } catch (error) {
    if (error instanceof AmuxV22ReadOnlyApiBrokerError || error?.code !== "ENOENT") throw error;
  }
  const packed = strictUtf8(await readStableFile(fs, gitRoot,
    join(gitRoot, "packed-refs"), GIT_PACKED_REFS_MAX_BYTES));
  let found = null;
  for (const line of packed.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("^")) {
      if (!new RegExp(`^\\^[a-f0-9]{${revisionLength}}$`, "u").test(line))
        refuse("snapshot_invalid");
      continue;
    }
    const entry = /^([a-f0-9]+) (refs\/[A-Za-z0-9._/-]+)$/u.exec(line);
    if (!entry || entry[1].length !== revisionLength || entry[2].split("/").some(part =>
      !part || part === "." || part === ".." || part.endsWith(".lock")))
      refuse("snapshot_invalid");
    if (entry[2] === symbolic[1]) {
      if (found !== null) refuse("snapshot_invalid");
      found = entry[1];
    }
  }
  if (found === null) refuse("snapshot_invalid");
  return found;
}

async function readLooseObject(gitRoot, objectId, fs, cache) {
  if (!REVISION.test(objectId)) refuse("snapshot_invalid");
  if (cache.has(objectId)) return cache.get(objectId);
  const objectsRoot = join(gitRoot, "objects");
  await assertPlainDirectory(fs, objectsRoot);
  const objectPath = join(objectsRoot, objectId.slice(0, 2), objectId.slice(2));
  let compressed;
  try {
    compressed = await readStableFile(fs, objectsRoot, objectPath,
      GIT_COMPRESSED_MAX_BYTES);
  } catch (error) {
    if (error?.code === "ENOENT") throw new PackedGitObjectRequiredError();
    throw error;
  }
  let inflated;
  try { inflated = inflateSync(compressed, { maxOutputLength: GIT_OBJECT_MAX_BYTES }); }
  catch { compressed.fill(0); return refuse("snapshot_invalid"); }
  compressed.fill(0);
  const nul = inflated.indexOf(0);
  const header = nul > 0 && nul <= 96 ? strictUtf8(inflated.subarray(0, nul)) : "";
  const match = /^(commit|tree|blob) ([0-9]+)$/u.exec(header);
  const content = nul > 0 ? inflated.subarray(nul + 1) : Buffer.alloc(0);
  const algorithm = objectId.length === 40 ? "sha1" : "sha256";
  if (!match || Number(match[2]) !== content.length ||
      createHash(algorithm).update(inflated).digest("hex") !== objectId)
    refuse("snapshot_invalid");
  const object = Object.freeze({ type: match[1], content });
  cache.set(objectId, object);
  return object;
}

function parseTreeEntries(content, objectIdLength) {
  const entries = new Map();
  const objectBytes = objectIdLength / 2;
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    const nul = space > offset ? content.indexOf(0, space + 1) : -1;
    if (space < 0 || nul < 0 || nul + 1 + objectBytes > content.length)
      refuse("snapshot_invalid");
    const mode = content.subarray(offset, space).toString("ascii");
    const name = strictUtf8(content.subarray(space + 1, nul));
    if (!name || name === "." || name === ".." || name.includes("/") ||
        entries.has(name)) refuse("snapshot_invalid");
    const objectId = content.subarray(nul + 1, nul + 1 + objectBytes).toString("hex");
    if (!REVISION.test(objectId) || objectId.length !== objectIdLength)
      refuse("snapshot_invalid");
    entries.set(name, Object.freeze({ mode, objectId }));
    offset = nul + 1 + objectBytes;
  }
  return entries;
}

async function proveLooseGitSnapshot(root, sourceRevision, prefixes, repositoryScopeDigest, fs) {
  const gitRoot = join(root, ".git");
  await assertPlainDirectory(fs, gitRoot);
  if (await readHeadCommit(gitRoot, sourceRevision.length, fs) !== sourceRevision)
    refuse("snapshot_invalid");
  const cache = new Map();
  const commit = await readLooseObject(gitRoot, sourceRevision, fs, cache);
  if (commit.type !== "commit" || commit.content.length > GIT_COMMIT_MAX_BYTES)
    refuse("snapshot_invalid");
  const treeLine = new RegExp(`^tree ([a-f0-9]{${sourceRevision.length}})\\n`, "u")
    .exec(strictUtf8(commit.content));
  if (!treeLine) refuse("snapshot_invalid");
  const sourceTreeObjectId = treeLine[1];
  const files = new Map();
  const directories = new Map();
  const parsedTrees = new Map();
  let treeBytes = 0;
  let blobBytes = 0;
  const loadTree = async objectId => {
    if (parsedTrees.has(objectId)) return parsedTrees.get(objectId);
    const object = await readLooseObject(gitRoot, objectId, fs, cache);
    if (object.type !== "tree") refuse("snapshot_invalid");
    treeBytes += object.content.length;
    if (!Number.isSafeInteger(treeBytes) || treeBytes > GIT_OBJECT_MAX_BYTES)
      refuse("snapshot_invalid");
    const entries = parseTreeEntries(object.content, sourceRevision.length);
    parsedTrees.set(objectId, entries);
    return entries;
  };
  const walk = async (path, objectId, depth) => {
    canonicalRelativePath(path);
    if (depth > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxDepth)
      refuse("snapshot_invalid");
    const prior = directories.get(path);
    if (prior) {
      if (prior.objectId !== objectId) refuse("snapshot_invalid");
      return;
    }
    directories.set(path, Object.freeze({ path, objectId }));
    const entries = await loadTree(objectId);
    for (const [name, entry] of entries) {
      const child = `${path}/${name}`;
      canonicalRelativePath(child);
      if (entry.mode === "40000") await walk(child, entry.objectId, depth + 1);
      else {
        if (!["100644", "100755"].includes(entry.mode) || files.has(child))
          refuse("snapshot_invalid");
        const object = await readLooseObject(gitRoot, entry.objectId, fs, cache);
        if (object.type !== "blob" ||
            object.content.length > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxReadBytes)
          refuse("snapshot_invalid");
        blobBytes += object.content.length;
        if (files.size >= AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxFiles ||
            !Number.isSafeInteger(blobBytes) ||
            blobBytes > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxScannedBytes)
          refuse("snapshot_invalid");
        files.set(child, Object.freeze({ path: child, objectId: entry.objectId,
          size: object.content.length }));
      }
    }
  };
  for (const prefix of prefixes) {
    let objectId = sourceTreeObjectId;
    for (const part of prefix.split("/")) {
      const entry = (await loadTree(objectId)).get(part);
      if (!entry || entry.mode !== "40000") refuse("snapshot_invalid");
      objectId = entry.objectId;
    }
    await walk(prefix, objectId, 0);
  }
  if (files.size < 1) refuse("snapshot_invalid");
  const tree = Object.freeze({ files, directories });
  const gitProofDigest = sha256(Buffer.from(
    `amux-v22-read-only-api-git-proof-v1\n${canonicalJson({
      version: 1, repositoryRoot: root, repositoryScopeDigest, sourceRevision,
      sourceTreeObjectId, proofPolicy: GIT_PROOF_POLICY,
    })}`, "utf8"));
  return Object.freeze({ mode: "native-loose-v1", sourceTreeObjectId, tree, gitProofDigest });
}

function singleObjectId(bytes) {
  const value = strictUtf8(bytes).trim();
  if (!REVISION.test(value)) refuse("snapshot_invalid");
  return value;
}

function parseFixedGitTree(bytes, prefixes, revisionLength) {
  const text = strictUtf8(bytes);
  const files = new Map();
  const directories = new Map();
  for (const row of text.split("\0")) {
    if (!row) continue;
    const separator = row.indexOf("\t");
    const match = /^([0-7]{6}) (blob|tree) ([a-f0-9]+) +(-|[0-9]+)$/u
      .exec(separator < 0 ? "" : row.slice(0, separator));
    const path = separator < 0 ? "" : canonicalRelativePath(row.slice(separator + 1));
    if (!match || match[3].length !== revisionLength || !withinPrefix(path, prefixes))
      refuse("snapshot_invalid");
    if (match[2] === "tree") {
      if (match[1] !== "040000" || match[4] !== "-" || directories.has(path))
        refuse("snapshot_invalid");
      directories.set(path, Object.freeze({ path, objectId: match[3] }));
      continue;
    }
    if (!["100644", "100755"].includes(match[1]) || match[4] === "-" || files.has(path))
      refuse("snapshot_invalid");
    const size = Number(match[4]);
    if (!Number.isSafeInteger(size) || size < 0 ||
        size > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxReadBytes)
      refuse("snapshot_invalid");
    files.set(path, Object.freeze({ path, objectId: match[3], size }));
  }
  if (prefixes.some(prefix => !directories.has(prefix)) || files.size < 1 ||
      files.size > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxFiles)
    refuse("snapshot_invalid");
  return Object.freeze({ files, directories });
}

function verifyFixedGitBlobBatch(output, files, revisionLength) {
  const objects = [...new Map([...files.values()].map(file => [file.objectId, file])).values()];
  let offset = 0;
  let totalBytes = 0;
  try {
    for (const expected of objects) {
      const newline = output.indexOf(0x0a, offset);
      if (newline < offset || newline - offset > 160) refuse("snapshot_invalid");
      const header = strictUtf8(output.subarray(offset, newline));
      const match = /^([a-f0-9]+) blob ([0-9]+)$/u.exec(header);
      if (!match || match[1] !== expected.objectId ||
          Number(match[2]) !== expected.size) refuse("snapshot_invalid");
      const contentStart = newline + 1;
      const contentEnd = contentStart + expected.size;
      if (contentEnd >= output.length || output[contentEnd] !== 0x0a)
        refuse("snapshot_invalid");
      const content = output.subarray(contentStart, contentEnd);
      const algorithm = revisionLength === 40 ? "sha1" : "sha256";
      const objectId = createHash(algorithm).update(`blob ${content.length}\0`, "utf8")
        .update(content).digest("hex");
      if (objectId !== expected.objectId) refuse("snapshot_invalid");
      totalBytes += content.length;
      if (!Number.isSafeInteger(totalBytes) ||
          totalBytes > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxScannedBytes)
        refuse("snapshot_invalid");
      offset = contentEnd + 1;
    }
    if (offset !== output.length) refuse("snapshot_invalid");
  } finally { output.fill(0); }
}

async function provePackedGitSnapshot(root, sourceRevision, prefixes,
  repositoryScopeDigest, fs) {
  const gitRoot = join(root, ".git");
  await assertPlainDirectory(fs, gitRoot);
  if (await readHeadCommit(gitRoot, sourceRevision.length, fs) !== sourceRevision)
    refuse("snapshot_invalid");
  await assertNoGitAlternates(gitRoot, fs);
  const proof = Object.freeze({ gitRoot, childGitDir: join(gitRoot, "logs"),
    objectDirectory: join(gitRoot, "objects"), binary: await fixedGitBinaryRecord(fs),
    config: await safeGitConfigRecord(gitRoot, sourceRevision.length, fs) });
  await assertConfiglessGitDirectory(proof.childGitDir, fs);
  const values = { sourceRevision, allowedPrefixes: prefixes };
  const verifiedCommit = singleObjectId(await runFixedGit(root, fs, proof,
    "verifyCommit", values, null, 256));
  const sourceTreeObjectId = singleObjectId(await runFixedGit(root, fs, proof,
    "verifyTree", values, null, 256));
  if (verifiedCommit !== sourceRevision || sourceTreeObjectId.length !== sourceRevision.length)
    refuse("snapshot_invalid");
  const tree = parseFixedGitTree(await runFixedGit(root, fs, proof,
    "listTree", values, null, GIT_OBJECT_MAX_BYTES), prefixes, sourceRevision.length);
  const objects = [...new Map([...tree.files.values()].map(file =>
    [file.objectId, file])).values()];
  const input = Buffer.from(`${objects.map(file => file.objectId).join("\n")}\n`, "ascii");
  const outputLimit = AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxScannedBytes +
    (objects.length * 160) + objects.length;
  verifyFixedGitBlobBatch(await runFixedGit(root, fs, proof,
    "readBlobs", values, input, outputLimit), tree.files, sourceRevision.length);
  const gitProofDigest = sha256(Buffer.from(
    `amux-v22-read-only-api-git-proof-v1\n${canonicalJson({
      version: 2, mode: "fixed-git-packed-v1", repositoryRoot: root,
      repositoryScopeDigest, sourceRevision, sourceTreeObjectId,
      binaryDigest: proof.binary.digest, configDigest: proof.config.digest,
      binaryIdentity: { dev: String(proof.binary.dev), ino: String(proof.binary.ino),
        mode: proof.binary.mode, uid: proof.binary.uid, size: proof.binary.size },
      environmentDigest: sha256(Buffer.from(canonicalJson(fixedGitEnvironment(proof)), "utf8")),
      proofPolicy: GIT_PROOF_POLICY,
    })}`, "utf8"));
  return Object.freeze({ mode: "fixed-git-packed-v1", sourceTreeObjectId,
    tree, gitProofDigest });
}

async function proveGitSnapshot(root, sourceRevision, prefixes, repositoryScopeDigest, fs) {
  try { return await proveLooseGitSnapshot(root, sourceRevision, prefixes,
    repositoryScopeDigest, fs); }
  catch (error) {
    if (!(error instanceof PackedGitObjectRequiredError)) throw error;
    return provePackedGitSnapshot(root, sourceRevision, prefixes,
      repositoryScopeDigest, fs);
  }
}

async function verifyGitSnapshot(root, sourceRevision, prefixes, repositoryScopeDigest, fs, git) {
  let current;
  try { current = await proveGitSnapshot(root, sourceRevision, prefixes,
    repositoryScopeDigest, fs); }
  catch { return refuse("snapshot_changed"); }
  if (current.sourceTreeObjectId !== git.sourceTreeObjectId ||
      current.gitProofDigest !== git.gitProofDigest ||
      [...current.tree.files].map(([path, file]) => `${path}:${file.objectId}:${file.size}`).join("\0") !==
        [...git.tree.files].map(([path, file]) => `${path}:${file.objectId}:${file.size}`).join("\0") ||
      [...current.tree.directories].map(([path, directory]) =>
        `${path}:${directory.objectId}`).join("\0") !==
        [...git.tree.directories].map(([path, directory]) =>
          `${path}:${directory.objectId}`).join("\0")) refuse("snapshot_changed");
}

export async function createAmuxV22ReadOnlyApiSnapshotManifest(config, dependencies = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).sort().join(",") !==
        "allowedPrefixes,repositoryRoot,sourceRevision" ||
      typeof config.repositoryRoot !== "string" || !isAbsolute(config.repositoryRoot) ||
      config.repositoryRoot.includes("\0") || !REVISION.test(config.sourceRevision) ||
      !Array.isArray(config.allowedPrefixes)) throw new TypeError("read_only_api_frame_invalid");
  const repositoryScopeDigest = amuxV22ReadOnlyApiRepositoryScopeDigest({
    sourceRevision: config.sourceRevision,
    allowedPrefixes: config.allowedPrefixes,
  });
  const root = resolve(config.repositoryRoot);
  if (root !== config.repositoryRoot && root.toLowerCase() !== config.repositoryRoot.toLowerCase())
    throw new TypeError("read_only_api_frame_invalid");
  const fs = {
    lstat: dependencies.lstat ?? lstat,
    open: dependencies.open ?? open,
    readdir: dependencies.readdir ?? readdir,
    realpath: dependencies.realpath ?? realpath,
  };
  const gitFs = { lstat, open, realpath };
  if (resolve(await fs.realpath(root)) !== root) refuse("snapshot_invalid");
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) refuse("snapshot_invalid");
  const git = await proveGitSnapshot(root, config.sourceRevision,
    config.allowedPrefixes, repositoryScopeDigest, gitFs)
    .catch(() => refuse("snapshot_invalid"));

  let scannedBytes = 0;
  let fileCount = 0;
  const fileRecords = new Map();
  const directoryRecords = new Map();
  const scan = async (canonical, absolute, depth) => {
    if (directoryRecords.has(canonical)) return;
    if (depth > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxDepth) refuse("snapshot_invalid");
    const before = await fs.lstat(absolute);
    if (!before.isDirectory() || before.isSymbolicLink() ||
        resolve(await fs.realpath(absolute)) !== absolute) refuse("snapshot_invalid");
    if (!git.tree.directories.has(canonical)) refuse("snapshot_invalid");
    directoryRecords.set(canonical, { path: canonical, dev: before.dev, ino: before.ino,
      ctimeMs: before.ctimeMs, size: before.size });
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    entries.sort((left, right) => bytewise(left.name, right.name));
    for (const entry of entries) {
      if (DENIED_SEGMENT.test(entry.name) || DENIED_NAME.test(entry.name)) continue;
      const childCanonical = `${canonical}/${entry.name}`;
      canonicalRelativePath(childCanonical);
      const childAbsolute = join(absolute, entry.name);
      const info = await fs.lstat(childAbsolute);
      if (info.isSymbolicLink()) refuse("snapshot_invalid");
      if (info.isDirectory()) await scan(childCanonical, childAbsolute, depth + 1);
      else if (info.isFile()) {
        const expected = git.tree.files.get(childCanonical);
        fileCount += 1;
        if (!expected || fileCount > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxFiles ||
            info.size !== expected.size || info.size < 0 ||
            info.size > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxReadBytes)
          refuse("snapshot_invalid");
        scannedBytes += info.size;
        if (!Number.isSafeInteger(scannedBytes) ||
            scannedBytes > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxScannedBytes)
          refuse("snapshot_invalid");
        const handle = await fs.open(childAbsolute, constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0));
        let bytes;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.isSymbolicLink?.() || opened.nlink !== 1 ||
              !sameIdentity(opened, info)) refuse("snapshot_invalid");
          bytes = Buffer.alloc(opened.size);
          let offset = 0;
          while (offset < bytes.length) {
            const result = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (result.bytesRead < 1) refuse("snapshot_invalid");
            offset += result.bytesRead;
          }
          const after = await handle.stat();
          if (!sameIdentity(after, opened)) refuse("snapshot_invalid");
          const objectId = createHash(config.sourceRevision.length === 40 ? "sha1" : "sha256")
            .update(`blob ${bytes.length}\0`, "utf8").update(bytes).digest("hex");
          if (objectId !== expected.objectId) refuse("snapshot_invalid");
          fileRecords.set(childCanonical, { path: childCanonical, size: opened.size,
            digest: sha256(bytes), objectId, dev: opened.dev, ino: opened.ino,
            ctimeMs: opened.ctimeMs });
        } finally { bytes?.fill(0); await handle.close(); }
      } else refuse("snapshot_invalid");
    }
    const after = await fs.lstat(absolute);
    if (!sameIdentity(after, before) || !after.isDirectory() || after.isSymbolicLink())
      refuse("snapshot_invalid");
  };
  for (const prefix of config.allowedPrefixes) {
    const absolute = resolve(root, ...prefix.split("/"));
    await scan(prefix, absolute, 0);
  }
  const rootAfter = await fs.lstat(root);
  if (!sameIdentity(rootAfter, rootInfo) || !rootAfter.isDirectory() ||
      rootAfter.isSymbolicLink()) refuse("snapshot_invalid");
  if ([...fileRecords.keys()].sort(bytewise).join("\0") !==
        [...git.tree.files.keys()].sort(bytewise).join("\0") ||
      [...directoryRecords.keys()].sort(bytewise).join("\0") !==
        [...git.tree.directories.keys()].sort(bytewise).join("\0"))
    refuse("snapshot_invalid");
  await verifyGitSnapshot(root, config.sourceRevision, config.allowedPrefixes,
    repositoryScopeDigest, gitFs, git);
  const files = [...fileRecords.values()].sort((left, right) => bytewise(left.path, right.path))
    .map(({ path, size, digest, objectId }) =>
      Object.freeze({ path, size, digest, objectId }));
  const directories = [...directoryRecords.keys()].sort(bytewise);
  const snapshotBody = { version: 1, sourceRevision: config.sourceRevision,
    sourceTreeObjectId: git.sourceTreeObjectId, repositoryScopeDigest,
    gitProofDigest: git.gitProofDigest, directories, files };
  const snapshotDigest = sha256(Buffer.from(
    `amux-v22-read-only-api-snapshot-v1\n${JSON.stringify(snapshotBody)}`, "utf8"));
  const manifest = Object.freeze({ ...snapshotBody,
    directories: Object.freeze(directories), files: Object.freeze(files), snapshotDigest });
  snapshots.set(manifest, { root, rootInfo, prefixes: [...config.allowedPrefixes], fs, gitFs,
    git, fileRecords, directoryRecords });
  return manifest;
}

export function createAmuxV22ReadOnlyApiBroker(config, dependencies = {}) {
  const snapshot = config && typeof config === "object" ?
    snapshots.get(config.snapshotManifest) : undefined;
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof config.repositoryRoot !== "string" || !isAbsolute(config.repositoryRoot) ||
      config.repositoryRoot.includes("\0") ||
      typeof config.sourceRevision !== "string" ||
      !Array.isArray(config.allowedPrefixes) ||
      !snapshot || snapshot.root.toLowerCase() !== resolve(config.repositoryRoot).toLowerCase() ||
      config.snapshotManifest.sourceRevision !== config.sourceRevision ||
      config.snapshotManifest.repositoryScopeDigest !== config.repositoryScopeDigest ||
      snapshot.prefixes.join("\0") !== config.allowedPrefixes.join("\0") ||
      config.repositoryScopeDigest !== amuxV22ReadOnlyApiRepositoryScopeDigest({
        sourceRevision: config.sourceRevision,
        allowedPrefixes: config.allowedPrefixes,
      }) || config.brokerPolicyDigest !== AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST ||
      config.toolSchemaDigest !== AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST)
    throw new TypeError("read_only_api_frame_invalid");

  const root = resolve(config.repositoryRoot);
  if (root !== config.repositoryRoot && root.toLowerCase() !== config.repositoryRoot.toLowerCase())
    throw new TypeError("read_only_api_frame_invalid");
  const prefixes = [...config.allowedPrefixes];
  const fs = snapshot.fs;
  const clock = dependencies.clock ?? (() => Date.now());

  const verifySnapshotBoundary = async () => {
    const rootInfo = await fs.lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
        !sameIdentity(rootInfo, snapshot.rootInfo) || resolve(await fs.realpath(root)) !== root)
      refuse("snapshot_changed");
    await verifyGitSnapshot(root, config.sourceRevision, prefixes,
      config.repositoryScopeDigest, snapshot.gitFs, snapshot.git)
      .catch(() => refuse("snapshot_changed"));
  };

  const operation = () => {
    const deadline = clock() + AMUX_V22_READ_ONLY_API_BROKER_POLICY.timeoutMs;
    let resultBytes = 0;
    let scannedBytes = 0;
    let files = 0;
    const check = () => {
      if (clock() > deadline) refuse("broker_timeout");
    };
    const addResult = value => {
      resultBytes += Buffer.byteLength(value, "utf8");
      if (resultBytes > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxResultBytes)
        refuse("result_limit");
    };
    const addScanned = value => {
      scannedBytes += value;
      if (!Number.isSafeInteger(scannedBytes) ||
          scannedBytes > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxScannedBytes)
        refuse("scan_limit");
    };

    const resolveApproved = relativePath => {
      const canonical = canonicalRelativePath(relativePath);
      if (!withinPrefix(canonical, prefixes)) refuse("path_refused");
      const absolute = resolve(root, ...canonical.split("/"));
      const back = relative(root, absolute);
      if (!back || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back))
        refuse("path_refused");
      return { canonical, absolute };
    };

    const verifyAncestors = async ({ canonical, absolute }, leafKind) => {
      check();
      const rootReal = await fs.realpath(root);
      if (resolve(rootReal) !== root) refuse("root_changed");
      const parts = canonical.split("/");
      let current = root;
      const identities = [];
      for (let index = 0; index < parts.length; index += 1) {
        current = join(current, parts[index]);
        const info = await fs.lstat(current);
        if (info.isSymbolicLink()) refuse("path_refused");
        if (index < parts.length - 1 && !info.isDirectory()) refuse("path_refused");
        if (index === parts.length - 1 &&
            ((leafKind === "file" && !info.isFile()) ||
             (leafKind === "directory" && !info.isDirectory()))) refuse("path_refused");
        identities.push({ path: current, dev: info.dev, ino: info.ino,
          ctimeMs: info.ctimeMs, size: info.size,
          kind: info.isDirectory() ? "directory" : "file" });
      }
      const real = await fs.realpath(absolute);
      if (resolve(real) !== absolute) refuse("path_refused");
      return identities;
    };

    const recheckAncestors = async identities => {
      check();
      const rootReal = await fs.realpath(root);
      if (resolve(rootReal) !== root) refuse("root_changed");
      for (const expected of identities) {
        const info = await fs.lstat(expected.path);
        const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
        if (info.isSymbolicLink() || kind !== expected.kind || info.dev !== expected.dev ||
            info.ino !== expected.ino || info.ctimeMs !== expected.ctimeMs ||
            (kind === "file" && info.size !== expected.size)) refuse("path_changed");
      }
    };

    const readApprovedFile = async (relativePath, requireText = true) => {
      const target = resolveApproved(relativePath);
      const identities = await verifyAncestors(target, "file");
      const before = await fs.lstat(target.absolute);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
          before.size < 0 || before.size > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxReadBytes)
        refuse("file_refused");
      const handle = await fs.open(target.absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.size !== before.size ||
            opened.dev !== before.dev || opened.ino !== before.ino ||
            opened.ctimeMs !== before.ctimeMs) refuse("file_changed");
        addScanned(opened.size);
        bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          check();
          const result = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (result.bytesRead < 1) refuse("file_changed");
          offset += result.bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== opened.size || after.dev !== opened.dev ||
            after.ino !== opened.ino || after.ctimeMs !== opened.ctimeMs)
          refuse("file_changed");
        const expected = snapshot.fileRecords.get(target.canonical);
        if (!expected || !sameIdentity(opened, expected) || expected.digest !== sha256(bytes))
          refuse("snapshot_changed");
        await recheckAncestors(identities);
        return { path: target.canonical, text: requireText ? textBytes(bytes) : null };
      } finally {
        bytes?.fill(0);
        await handle.close();
      }
    };

    const enumerate = async relativePath => {
      const start = resolveApproved(relativePath);
      const startIdentities = await verifyAncestors(start, "directory");
      const found = [];
      const foundDirectories = [];
      const walk = async (canonical, absolute, depth) => {
        check();
        if (depth > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxDepth)
          refuse("depth_limit");
        const before = await fs.lstat(absolute);
        const real = await fs.realpath(absolute);
        if (!before.isDirectory() || before.isSymbolicLink() || resolve(real) !== absolute)
          refuse("path_refused");
        const expectedDirectory = snapshot.directoryRecords.get(canonical);
        if (!expectedDirectory || !sameIdentity(before, expectedDirectory))
          refuse("snapshot_changed");
        foundDirectories.push(canonical);
        const entries = await fs.readdir(absolute, { withFileTypes: true });
        entries.sort((left, right) => bytewise(left.name, right.name));
        for (const entry of entries) {
          check();
          addScanned(Buffer.byteLength(entry.name, "utf8"));
          if (DENIED_SEGMENT.test(entry.name) || DENIED_NAME.test(entry.name)) continue;
          const childCanonical = `${canonical}/${entry.name}`;
          canonicalRelativePath(childCanonical);
          const childAbsolute = join(absolute, entry.name);
          const info = await fs.lstat(childAbsolute);
          if (info.isSymbolicLink()) refuse("path_refused");
          if (info.isDirectory()) await walk(childCanonical, childAbsolute, depth + 1);
          else if (info.isFile()) {
            files += 1;
            if (files > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxFiles)
              refuse("file_limit");
            found.push(childCanonical);
          } else refuse("path_refused");
        }
        const after = await fs.lstat(absolute);
        if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev ||
            after.ino !== before.ino || after.ctimeMs !== before.ctimeMs)
          refuse("path_changed");
      };
      await walk(start.canonical, start.absolute, 0);
      await recheckAncestors(startIdentities);
      const sorted = found.sort(bytewise);
      const expectedFiles = [...snapshot.fileRecords.keys()].filter(path =>
        path.startsWith(`${start.canonical}/`)).sort(bytewise);
      const expectedDirectories = [...snapshot.directoryRecords.keys()].filter(path =>
        path === start.canonical || path.startsWith(`${start.canonical}/`)).sort(bytewise);
      if (sorted.join("\0") !== expectedFiles.join("\0") ||
          foundDirectories.sort(bytewise).join("\0") !== expectedDirectories.join("\0"))
        refuse("snapshot_changed");
      return sorted;
    };

    const readTool = async input => {
      if (!exactKeys(input, Object.hasOwn(input ?? {}, "offset") ?
        (Object.hasOwn(input, "limit") ? "limit,offset,path" : "offset,path") :
        (Object.hasOwn(input ?? {}, "limit") ? "limit,path" : "path")))
        refuse("tool_input_refused");
      const offset = input.offset ?? 1;
      const limit = input.limit ?? AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxLines;
      if (!Number.isSafeInteger(offset) || offset < 1 || offset > 1_000_000 ||
          !Number.isSafeInteger(limit) || limit < 1 ||
          limit > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxLines)
        refuse("tool_input_refused");
      const file = await readApprovedFile(input.path);
      const lines = file.text.split(/\r?\n/u).slice(offset - 1, offset - 1 + limit);
      const answer = JSON.stringify({ path: file.path, startLine: offset,
        endLine: offset + Math.max(0, lines.length - 1), content: lines.join("\n") });
      addResult(answer);
      textBytes(Buffer.from(answer, "utf8"));
      return answer;
    };

    const grepTool = async input => {
      if (!exactKeys(input, "path,pattern") || typeof input.pattern !== "string" ||
          input.pattern.length < 1 || input.pattern.length > 256 ||
          input.pattern.includes("\0")) refuse("tool_input_refused");
      const target = resolveApproved(input.path);
      const info = await fs.lstat(target.absolute);
      let paths;
      if (info.isSymbolicLink()) refuse("path_refused");
      if (info.isFile()) paths = [target.canonical];
      else if (info.isDirectory()) paths = await enumerate(target.canonical);
      else refuse("path_refused");
      const matches = [];
      for (const path of paths) {
        const file = await readApprovedFile(path);
        const lines = file.text.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          check();
          if (!lines[index].includes(input.pattern)) continue;
          matches.push({ path, line: index + 1, text: lines[index] });
          if (matches.length > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxMatches)
            refuse("match_limit");
        }
      }
      const answer = JSON.stringify({ matches });
      addResult(answer);
      textBytes(Buffer.from(answer, "utf8"));
      return answer;
    };

    const globTool = async input => {
      if (!exactKeys(input, "pattern") || typeof input.pattern !== "string" ||
          input.pattern.length < 1 || input.pattern.length > 256 ||
          input.pattern.includes("\0")) refuse("tool_input_refused");
      const matcher = globRegex(input.pattern);
      const paths = [];
      for (const prefix of prefixes) paths.push(...await enumerate(prefix));
      const unique = [...new Set(paths)].sort(bytewise).filter(path => matcher.test(path));
      for (const path of paths) await readApprovedFile(path, false);
      if (unique.length > AMUX_V22_READ_ONLY_API_BROKER_POLICY.maxMatches)
        refuse("match_limit");
      const answer = JSON.stringify({ paths: unique });
      addResult(answer);
      textBytes(Buffer.from(answer, "utf8"));
      return answer;
    };

    return async (name, input) => {
      await verifySnapshotBoundary();
      check();
      let result;
      if (name === "Read") result = await readTool(input);
      else if (name === "Grep") result = await grepTool(input);
      else if (name === "Glob") result = await globTool(input);
      else return refuse("tool_refused");
      await verifySnapshotBoundary();
      return result;
    };
  };

  return Object.freeze({
    sourceRevision: config.sourceRevision,
    repositoryScopeDigest: config.repositoryScopeDigest,
    snapshotDigest: config.snapshotManifest.snapshotDigest,
    execute: async (name, input) => operation()(name, input),
  });
}
