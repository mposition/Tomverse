import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { createAmuxV22ReadOnlyApiBroker,
  createAmuxV22ReadOnlyApiSnapshotManifest } from "./v22ReadOnlyApiBroker.mjs";
import { createAmuxV22ReadOnlyApiExecutor } from "./v22ReadOnlyApiExecutor.mjs";
import {
  AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  amuxV22ReadOnlyApiRepositoryScopeDigest,
  parseAmuxV22ReadOnlyApiExecutionFrame,
} from "./v22ReadOnlyApiProtocol.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROFILE_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_HOST_LIFETIME_MS = 30 * 60 * 1_000;
const SYSTEMCTL = "/usr/bin/systemctl";
const API_EXECUTOR_USER = "tomverse-amux-v22-api";
const API_EXECUTOR_GROUP = "amux-v22-ipc";
const API_UNIT_PREFIX = "amux-v22-read-only-api-sidecar@";
const API_UNIT_SUFFIX = ".service";
const LEGACY_SIDECAR_UNIT_PREFIX = "tomverse-amux-v22-sidecar@";
const API_UNIT_FRAGMENT =
  "/etc/systemd/system/amux-v22-read-only-api-sidecar@.service";
const API_NODE_ARTIFACT = "/usr/bin/node";
const API_EXECUTOR_ARTIFACT =
  "/opt/tomverse-amux-v22/read-only-api-sidecar.mjs";
const API_REPOSITORY_ROOT =
  "/srv/tomverse-amux-v22-read-only-api/repository";
const API_CONFIG_ROOT = "/etc/tomverse-amux-v22/read-only-api";
const API_UNIT_FRAGMENT_SHA256 =
  "138b4a7eb58a3a6139b5a381127241f06efe3494223b050779ecb48c789c146d";
const SYSTEMCTL_PROPERTIES = Object.freeze([
  "Id", "LoadState", "ActiveState", "SubState", "MainPID", "InvocationID",
  "User", "Group", "ExecStart", "EnvironmentFiles", "FragmentPath",
  "DropInPaths", "Restart", "RuntimeMaxUSec",
]);
const INACTIVE_UNIT_PROPERTIES = Object.freeze([
  "Id", "LoadState", "ActiveState", "SubState", "MainPID", "Job",
]);
const PROFILE_ENV_KEYS = Object.freeze([
  "TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_OPERATIONAL_GATES",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_DEDICATED",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_SOURCE_REVISION",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_FILE",
]);
const QUOTED_JSON_ENV_KEYS = new Set([
  "TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON",
]);
const RUNTIME_ENV_KEYS = Object.freeze([
  ...PROFILE_ENV_KEYS,
  "TOMVERSE_AMUX_V22_WORKER",
  "TOMVERSE_AMUX_V22_SIDECAR_SOCKET",
  "TOMVERSE_AMUX_V22_SIDECAR_STATE_DIR",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_ROOT",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_HOST_ENV_FILE",
]);
const execFileAsync = promisify(execFile);
const FORBIDDEN_ENV = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_ADMIN_API_KEY", "ANTHROPIC_BASE_URL", "ENGINEERING_AGENT_ANTHROPIC_API_KEY",
  "FEEDBACK_AUTOFIX_ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  "PERPLEXITY_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR",
  "DATABASE_URL", "DIRECT_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL",
  "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING", "PGHOST", "PGPASSWORD",
  "AMUX_V4_KEY_STORE_ACCESS_KEY_ID", "AMUX_V4_KEY_STORE_SECRET_ACCESS_KEY",
  "AMUX_V4_CONTENT_MASTER_KEY_B64", "AMUX_V4_CONTENT_DIGEST_KEY_B64",
  "AMUX_DM_DIGEST_KEYS", "GITHUB_APP_PRIVATE_KEY", "NODE_OPTIONS", "NODE_PATH",
  "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
  "TOMVERSE_AMUX_V22_CLAUDE_BINARY", "TOMVERSE_AMUX_V22_CLAUDE_CONFIG_DIR",
  "TOMVERSE_AMUX_V22_WORKTREE", "TOMVERSE_AMUX_SYNC_SECRET", "TOMVERSE_INTERNAL_URL",
  "GITHUB_TOKEN", "GH_TOKEN", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "SSLKEYLOGFILE", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  "GIT_ASKPASS", "SSH_ASKPASS", "KRB5CCNAME", "DOCKER_CONFIG"]);
const SENSITIVE_ENV_NAME = /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|PASSWORD|SECRET|DATABASE_URL|POSTGRES|CLAUDE_CONFIG|GITHUB|GH_TOKEN|CREDENTIAL|COOKIE|SESSION|(?:^|_)KEY(?:_|$)|(?:^|_)TOKEN(?:_|$)|^AWS_|^AZURE_|^GOOGLE_)/i;
const DYNAMIC_LOADER_ENV_NAME = /^(?:LD_|DYLD_)/u;
const ALLOWED_SENSITIVE_METADATA_ENV = new Set([
  "TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_DEDICATED",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE",
  "TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_FILE",
]);

const canonicalJson = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

const digestValue = (domain, value) => createHash("sha256")
  .update(`${domain}\n`, "utf8").update(canonicalJson(value), "utf8").digest("hex");

const exactKeys = (value, keys) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
const CREDENTIAL_PROFILE_KEYS = ["allowedProviderHost", "credentialProfileId",
  "keyMode", "keyOwner", "keyPath", "provider", "retentionClass", "shared",
  "version"].sort().join(",");

export function amuxV22ReadOnlyApiCredentialMetadataDigest(value) {
  if (!exactKeys(value, CREDENTIAL_PROFILE_KEYS) || value.version !== 1 ||
      !PROFILE_ID.test(value.credentialProfileId) || value.provider !== "anthropic" ||
      value.allowedProviderHost !== "api.anthropic.com" ||
      value.keyOwner !== API_EXECUTOR_USER || value.keyMode !== "0600" ||
      value.keyPath !== `${API_CONFIG_ROOT}/${value.credentialProfileId}.key` ||
      value.retentionClass !== "operator-managed-dedicated-recovery" ||
      value.shared !== false)
    throw new TypeError("invalid dedicated credential metadata");
  return digestValue("amux-v22-read-only-api-credential-metadata-v1", value);
}

function forbiddenHostEnvironment(environment) {
  return Object.keys(environment).some(name => FORBIDDEN_ENV.includes(name) ||
    DYNAMIC_LOADER_ENV_NAME.test(name) ||
    (SENSITIVE_ENV_NAME.test(name) && !ALLOWED_SENSITIVE_METADATA_ENV.has(name)));
}

export function amuxV22ReadOnlyApiLauncherConfigDigest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !WORKER.test(input.worker) ||
      [input.apiExecutionFrameDigest, input.credentialMetadataDigest,
        input.executorArtifactDigest, input.settingsDigest,
        input.repositoryScopeDigest, input.brokerPolicyDigest,
        input.toolSchemaDigest, input.snapshotDigest, input.gitProofDigest,
        input.serviceConfigDigest]
        .some(value => !DIGEST.test(value)) ||
      typeof input.credentialProfileId !== "string" ||
      input.credentialProfileId.length < 1 || input.credentialProfileId.length > 128 ||
      /[\0\r\n]/.test(input.credentialProfileId))
    throw new TypeError("invalid read-only API launcher metadata");
  return createHash("sha256")
    .update("amux-v22-read-only-api-launcher-config-v1\n")
    .update(canonicalJson({ version: 1, executorKind: "read_only_api_retry_v1",
      worker: input.worker, apiExecutionFrameDigest: input.apiExecutionFrameDigest,
      credentialProfileId: input.credentialProfileId,
      credentialMetadataDigest: input.credentialMetadataDigest,
      executorArtifactDigest: input.executorArtifactDigest,
      settingsDigest: input.settingsDigest,
      repositoryScopeDigest: input.repositoryScopeDigest,
      brokerPolicyDigest: input.brokerPolicyDigest,
      toolSchemaDigest: input.toolSchemaDigest,
      gitProofDigest: input.gitProofDigest,
      snapshotDigest: input.snapshotDigest,
      serviceConfigDigest: input.serviceConfigDigest }))
    .digest("hex");
}

async function rootProtectedPath(path, dependencies = {}, leaf = "any") {
  if (dependencies.testOnly === true &&
      typeof dependencies.rootProtectedPath === "function")
    return dependencies.rootProtectedPath(path, leaf);
  const stat = dependencies.lstat ?? lstat;
  let current = path;
  for (let depth = 0; depth < 32; depth += 1) {
    const info = await stat(current);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      return false;
    if (current === path) {
      if (leaf === "file" && (!info.isFile() || info.nlink !== 1)) return false;
      if (leaf === "directory" && !info.isDirectory()) return false;
    } else if (!info.isDirectory()) return false;
    if (current === "/") return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

const fileIdentity = (path, info) => ({ path, device: String(info.dev),
  inode: String(info.ino), uid: info.uid, mode: info.mode & 0o777,
  size: info.size, ctimeMs: info.ctimeMs });

async function stableRegularFile(path, { maxBytes, uid, mode, executable = false,
  readBytes = true } = {}, dependencies = {}) {
  const stat = dependencies.lstat ?? lstat;
  const openFile = dependencies.open ?? open;
  if (!isAbsolute(path) || path.includes("\0") ||
      !await rootProtectedPath(dirname(path), dependencies, "directory"))
    throw new TypeError("protected host file boundary violated");
  const before = await stat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.uid !== uid || (before.mode & 0o022) !== 0 ||
      (mode !== undefined && (before.mode & 0o777) !== mode) ||
      (executable && (before.mode & 0o111) === 0) || before.size < 1 ||
      !Number.isSafeInteger(before.size) || before.size > maxBytes)
    throw new TypeError("protected host file boundary violated");
  const handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const chunks = [];
  const hash = createHash("sha256");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid || opened.mode !== before.mode ||
        opened.size !== before.size || opened.ctimeMs !== before.ctimeMs ||
        opened.nlink !== 1)
      throw new TypeError("protected host file changed");
    const buffer = Buffer.alloc(Math.min(64 * 1024, opened.size));
    try {
      let offset = 0;
      while (offset < opened.size) {
        const { bytesRead } = await handle.read(buffer, 0,
          Math.min(buffer.length, opened.size - offset), offset);
        if (bytesRead < 1) throw new TypeError("protected host file truncated");
        const part = buffer.subarray(0, bytesRead);
        hash.update(part);
        if (readBytes) chunks.push(Buffer.from(part));
        offset += bytesRead;
      }
    } finally { buffer.fill(0); }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.ctimeMs !== opened.ctimeMs)
      throw new TypeError("protected host file changed");
    return { bytes: readBytes ? Buffer.concat(chunks) : null,
      digest: hash.digest("hex"), identity: fileIdentity(path, opened) };
  } finally {
    chunks.forEach(chunk => chunk.fill(0));
    await handle.close();
  }
}

function parseProfileEnvironment(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 65_536)
    throw new TypeError("invalid read-only API environment file");
  const values = {};
  for (const line of source.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=([^\0\r\n]*)$/u.exec(line);
    if (!match || !PROFILE_ENV_KEYS.includes(match[1]) ||
        Object.hasOwn(values, match[1]))
      throw new TypeError("invalid read-only API environment file");
    const raw = match[2];
    if (QUOTED_JSON_ENV_KEYS.has(match[1])) {
      if (raw.length < 3 || raw[0] !== "'" || raw.at(-1) !== "'" ||
          raw.slice(1, -1).includes("'") || raw.slice(1, -1).includes("\\"))
        throw new TypeError("invalid read-only API environment file");
      values[match[1]] = raw.slice(1, -1);
    } else {
      if (!raw || /[\s'"\\]/u.test(raw))
        throw new TypeError("invalid read-only API environment file");
      values[match[1]] = raw;
    }
  }
  if (Object.keys(values).sort().join(",") !== [...PROFILE_ENV_KEYS].sort().join(","))
    throw new TypeError("invalid read-only API environment file");
  return values;
}

function runtimePaths(worker) {
  return Object.freeze({
    unit: `${API_UNIT_PREFIX}${worker}${API_UNIT_SUFFIX}`,
    environmentFile: `/etc/tomverse-amux-v22/read-only-api@${worker}.env`,
    socketPath: `/run/tomverse-amux-v22-read-only-api-${worker}/task.sock`,
    stateDir: `/var/lib/tomverse-amux-v22-read-only-api/${worker}`,
  });
}

function selectedRuntimeEnvironment(environment) {
  const selected = {};
  for (const name of RUNTIME_ENV_KEYS) {
    if (typeof environment[name] !== "string")
      throw new TypeError("read-only API runtime environment incomplete");
    selected[name] = environment[name];
  }
  return selected;
}

function assertClosedProcessEnvironment(environment) {
  if (!environment || typeof environment !== "object" ||
      Array.isArray(environment) || forbiddenHostEnvironment(environment))
    throw new TypeError("read-only API process environment refused");
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || typeof value !== "string" ||
        value.includes("\0") ||
        (name.startsWith("TOMVERSE_") && !RUNTIME_ENV_KEYS.includes(name)))
      throw new TypeError("read-only API process environment refused");
  }
  return selectedRuntimeEnvironment(environment);
}

function parseSystemctlShow(source, properties = SYSTEMCTL_PROPERTIES) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 65_536)
    throw new TypeError("read-only API unit state unavailable");
  const result = {};
  for (const line of source.split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator) : "";
    if (!properties.includes(key) || Object.hasOwn(result, key))
      throw new TypeError("read-only API unit state unavailable");
    result[key] = line.slice(separator + 1);
  }
  if (Object.keys(result).sort().join(",") !==
      [...properties].sort().join(","))
    throw new TypeError("read-only API unit state unavailable");
  return result;
}

async function readUnitState(unit, options = {}) {
  if (options.testOnly === true && typeof options.showUnit === "function") {
    const value = await options.showUnit(unit);
    return typeof value === "string" ? parseSystemctlShow(value) : value;
  }
  const { stdout } = await execFileAsync(SYSTEMCTL, ["show", unit, "--all", "--no-pager",
    ...SYSTEMCTL_PROPERTIES.map(name => `--property=${name}`)], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 65_536, windowsHide: true,
    env: { LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" },
  });
  return parseSystemctlShow(stdout);
}

async function readInactiveCliUnitState(worker, options = {}) {
  const unit = `${LEGACY_SIDECAR_UNIT_PREFIX}${worker}${API_UNIT_SUFFIX}`;
  if (options.testOnly === true && typeof options.showInactiveCliUnit === "function") {
    const value = await options.showInactiveCliUnit(unit);
    return typeof value === "string"
      ? parseSystemctlShow(value, INACTIVE_UNIT_PROPERTIES) : value;
  }
  const { stdout } = await execFileAsync(SYSTEMCTL, ["show", unit, "--all", "--no-pager",
    ...INACTIVE_UNIT_PROPERTIES.map(name => `--property=${name}`)], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 16_384, windowsHide: true,
    env: { LANG: "C", LC_ALL: "C", SYSTEMD_COLORS: "0" },
  });
  return parseSystemctlShow(stdout, INACTIVE_UNIT_PROPERTIES);
}

function validateInactiveCliUnitState(state, worker) {
  const unit = `${LEGACY_SIDECAR_UNIT_PREFIX}${worker}${API_UNIT_SUFFIX}`;
  if (!state || state.Id !== unit ||
      !["loaded", "not-found"].includes(state.LoadState) ||
      state.ActiveState !== "inactive" || state.SubState !== "dead" ||
      state.MainPID !== "0" || !["", "0", "[0, /]"].includes(state.Job))
    throw new TypeError("selected CLI sidecar is not safely stopped");
  return state;
}

function expectedEnvironmentFile(value, path) {
  return value === path || value === `${path} (ignore_errors=no)` ||
    value === `{ path=${path} ; ignore_errors=no ; }`;
}

function validateUnitState(state, worker) {
  const paths = runtimePaths(worker);
  const pid = Number(state?.MainPID);
  const expectedExec = `{ path=${API_NODE_ARTIFACT} ; argv[]=${API_NODE_ARTIFACT} ${API_EXECUTOR_ARTIFACT} ; ignore_errors=no ;`;
  if (!state || state.Id !== paths.unit || state.LoadState !== "loaded" ||
      state.ActiveState !== "active" || state.SubState !== "running" ||
      !Number.isSafeInteger(pid) || pid < 2 ||
      !/^[a-f0-9]{32}$/u.test(state.InvocationID) ||
      state.User !== API_EXECUTOR_USER || state.Group !== API_EXECUTOR_GROUP ||
      state.FragmentPath !== API_UNIT_FRAGMENT || state.DropInPaths !== "" ||
      state.Restart !== "no" || typeof state.ExecStart !== "string" ||
      !state.ExecStart.startsWith(expectedExec) ||
      !["30min", "1800000000"].includes(state.RuntimeMaxUSec) ||
      !expectedEnvironmentFile(state.EnvironmentFiles, paths.environmentFile))
    throw new TypeError("read-only API unit state drift");
  return pid;
}

async function readBoundedProcFile(path, maxBytes, options = {}) {
  const handle = await (options.open ?? open)(path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const chunks = [];
  let total = 0;
  try {
    const buffer = Buffer.alloc(16 * 1024);
    try {
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) throw new TypeError("read-only API process state too large");
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
    } finally { buffer.fill(0); }
    return Buffer.concat(chunks, total);
  } finally {
    chunks.forEach(chunk => chunk.fill(0));
    await handle.close();
  }
}

function parseNullDelimited(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.at(-1) !== 0)
    throw new TypeError(`invalid read-only API ${label}`);
  return new TextDecoder("utf-8", { fatal: true })
    .decode(bytes.subarray(0, -1)).split("\0");
}

function parseProcessEnvironment(bytes) {
  const environment = Object.create(null);
  for (const entry of parseNullDelimited(bytes, "process environment")) {
    const separator = entry.indexOf("=");
    const name = separator > 0 ? entry.slice(0, separator) : "";
    if (!name || Object.hasOwn(environment, name))
      throw new TypeError("invalid read-only API process environment");
    environment[name] = entry.slice(separator + 1);
  }
  return environment;
}

function parseProcessStatus(source) {
  if (typeof source !== "string") throw new TypeError("invalid read-only API process status");
  const fields = new Map(source.split("\n").map(line => {
    const separator = line.indexOf(":");
    return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1).trim()] : [];
  }).filter(value => value.length === 2));
  const ids = name => {
    const values = fields.get(name)?.split(/\s+/u).map(Number);
    if (!values || values.length !== 4 || values.some(value =>
      !Number.isSafeInteger(value) || value < 1) || !values.every(value => value === values[0]))
      throw new TypeError("invalid read-only API process identity");
    return values[0];
  };
  const capEff = fields.get("CapEff");
  if (fields.get("NoNewPrivs") !== "1" || !/^0+$/u.test(capEff ?? ""))
    throw new TypeError("read-only API process privilege drift");
  const uid = ids("Uid");
  const gid = ids("Gid");
  const groupSource = fields.get("Groups");
  const groupTokens = groupSource?.split(/\s+/u);
  if (!groupSource || !groupTokens || groupTokens.length !== 1 ||
      !/^[1-9][0-9]*$/u.test(groupTokens[0]))
    throw new TypeError("read-only API process group drift");
  const groups = groupTokens.map(Number);
  if (groups.length !== 1 ||
      !Number.isSafeInteger(groups[0]) || groups[0] < 1 || groups[0] !== gid)
    throw new TypeError("read-only API process group drift");
  return { uid, gid, groups };
}

async function readProcessState(pid, options = {}) {
  if (options.testOnly === true && typeof options.readProcessState === "function")
    return options.readProcessState(pid);
  const root = `/proc/${pid}`;
  const [statusBytes, commandBytes, environmentBytes, executable] = await Promise.all([
    readBoundedProcFile(`${root}/status`, 16 * 1024, options),
    readBoundedProcFile(`${root}/cmdline`, 4 * 1024, options),
    readBoundedProcFile(`${root}/environ`, 65_536, options),
    (options.readlink ?? readlink)(`${root}/exe`),
  ]);
  try {
    const identity = parseProcessStatus(
      new TextDecoder("utf-8", { fatal: true }).decode(statusBytes));
    return { ...identity, executable,
      argv: parseNullDelimited(commandBytes, "process command"),
      environment: parseProcessEnvironment(environmentBytes) };
  } finally {
    statusBytes.fill(0); commandBytes.fill(0); environmentBytes.fill(0);
  }
}

function validateProcessState(state) {
  if (!state || !Number.isSafeInteger(state.uid) || state.uid < 1 ||
      !Number.isSafeInteger(state.gid) || state.gid < 1 ||
      !Array.isArray(state.groups) || state.groups.length !== 1 ||
      !Number.isSafeInteger(state.groups[0]) || state.groups[0] !== state.gid ||
      state.executable !== API_NODE_ARTIFACT || !Array.isArray(state.argv) ||
      state.argv.length !== 2 || state.argv[0] !== API_NODE_ARTIFACT ||
      state.argv[1] !== API_EXECUTOR_ARTIFACT)
    throw new TypeError("read-only API process state drift");
  return assertClosedProcessEnvironment(state.environment);
}

async function inspectEmptyApiStateDirectory(path, uid, options = {}) {
  if (options.testOnly === true && typeof options.inspectApiStateDirectory === "function")
    return options.inspectApiStateDirectory(path, uid);
  const stat = options.lstat ?? lstat;
  const resolveReal = options.realpath ?? realpath;
  const list = options.readdir ?? readdir;
  const [info, canonical, entries] = await Promise.all([
    stat(path), resolveReal(path), list(path),
  ]);
  if (canonical !== path || !info.isDirectory() || info.isSymbolicLink() ||
      info.uid !== uid || (info.mode & 0o777) !== 0o700 || entries.length !== 0)
    throw new TypeError("read-only API sidecar has other work");
  return digestValue("amux-v22-read-only-api-empty-state-dir-v1",
    fileIdentity(path, info));
}

async function inspectDedicatedKeyFile(path, repositoryRoot, uid, dependencies = {}) {
  const stat = dependencies.lstat ?? lstat;
  const resolveReal = dependencies.realpath ?? realpath;
  const openFile = dependencies.open ?? open;
  if (typeof path !== "string" || !isAbsolute(path))
    throw new TypeError("invalid dedicated credential source");
  const absolute = resolve(path);
  const [fileReal, rootReal] = await Promise.all([
    resolveReal(absolute), resolveReal(repositoryRoot),
  ]);
  const relation = relative(rootReal, fileReal);
  if (fileReal !== absolute || relation === "" ||
      (!relation.startsWith("..") && !isAbsolute(relation)) ||
      !await rootProtectedPath(dirname(absolute), dependencies, "directory"))
    throw new TypeError("dedicated credential boundary violated");
  const before = await stat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.uid !== uid || (before.mode & 0o777) !== 0o600 ||
      before.size < 16 || before.size > 8_192)
    throw new TypeError("dedicated credential boundary violated");
  const handle = await openFile(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid || opened.mode !== before.mode ||
        opened.size !== before.size || opened.ctimeMs !== before.ctimeMs || opened.nlink !== 1)
      throw new TypeError("dedicated credential changed");
    return { handle, info: opened,
      identityDigest: digestValue("amux-v22-read-only-api-key-identity-v1",
        fileIdentity(absolute, opened)) };
  } catch (error) { await handle.close(); throw error; }
}

async function measureProtectedApiHostState(environment, frame, snapshotManifest,
  keyIdentityDigest, dependencies = {}) {
  const worker = environment.TOMVERSE_AMUX_V22_WORKER;
  const paths = runtimePaths(worker);
  if (environment.TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_ROOT !==
        API_REPOSITORY_ROOT ||
      environment.TOMVERSE_AMUX_V22_SIDECAR_SOCKET !== paths.socketPath ||
      environment.TOMVERSE_AMUX_V22_SIDECAR_STATE_DIR !== paths.stateDir ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_HOST_ENV_FILE !==
        paths.environmentFile)
    throw new TypeError("read-only API fixed host path drift");
  const envFile = await stableRegularFile(paths.environmentFile,
    { maxBytes: 65_536, uid: 0, mode: 0o644 }, dependencies);
  let fileEnvironment;
  try {
    fileEnvironment = parseProfileEnvironment(
      new TextDecoder("utf-8", { fatal: true }).decode(envFile.bytes));
  } finally { envFile.bytes?.fill(0); }
  for (const name of PROFILE_ENV_KEYS)
    if (fileEnvironment[name] !== environment[name])
      throw new TypeError("read-only API environment drift");
  const expectedProfilePath =
    `${API_CONFIG_ROOT}/${frame.credentialProfileId}.profile.json`;
  const expectedKeyPath = `${API_CONFIG_ROOT}/${frame.credentialProfileId}.key`;
  if (environment.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_FILE !==
        expectedProfilePath ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE !== expectedKeyPath)
    throw new TypeError("read-only API credential profile drift");
  const profileFile = await stableRegularFile(expectedProfilePath,
    { maxBytes: 8_192, uid: 0, mode: 0o644 }, dependencies);
  let profile;
  try {
    profile = JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(profileFile.bytes));
  } finally { profileFile.bytes?.fill(0); }
  const credentialMetadataDigest =
    amuxV22ReadOnlyApiCredentialMetadataDigest(profile);
  if (profile.credentialProfileId !== frame.credentialProfileId ||
      credentialMetadataDigest !== frame.credentialMetadataDigest)
    throw new TypeError("read-only API credential metadata drift");
  const unitFile = await stableRegularFile(API_UNIT_FRAGMENT,
    { maxBytes: 64 * 1024, uid: 0, mode: 0o644, readBytes: false }, dependencies);
  if (unitFile.digest !== API_UNIT_FRAGMENT_SHA256)
    throw new TypeError("read-only API unit artifact drift");
  const nodeArtifact = await stableRegularFile(API_NODE_ARTIFACT,
    { maxBytes: 256 * 1024 * 1024, uid: 0, executable: true, readBytes: false },
    dependencies);
  const executorArtifact = await stableRegularFile(API_EXECUTOR_ARTIFACT,
    { maxBytes: 32 * 1024 * 1024, uid: 0, mode: 0o555, readBytes: false },
    dependencies);
  if (executorArtifact.digest !== frame.executorArtifactDigest)
    throw new TypeError("read-only API executor artifact drift");
  if (!await rootProtectedPath(API_REPOSITORY_ROOT, dependencies, "directory"))
    throw new TypeError("read-only API repository root drift");
  const repositoryInfo = await (dependencies.lstat ?? lstat)(API_REPOSITORY_ROOT);
  const repositoryIdentityDigest = digestValue(
    "amux-v22-read-only-api-repository-identity-v1",
    fileIdentity(API_REPOSITORY_ROOT, repositoryInfo));
  const selected = selectedRuntimeEnvironment(environment);
  return digestValue("amux-v22-read-only-api-service-config-v1", {
    version: 1, worker, unit: paths.unit,
    unitFileDigest: unitFile.digest,
    nodeArtifactDigest: nodeArtifact.digest,
    executorArtifactDigest: executorArtifact.digest,
    environmentDigest: digestValue("amux-v22-read-only-api-environment-v1", selected),
    credentialMetadataDigest, credentialProfileFileDigest: profileFile.digest,
    credentialFileIdentityDigest: keyIdentityDigest,
    repositoryIdentityDigest, gitProofDigest: snapshotManifest.gitProofDigest,
    snapshotDigest: snapshotManifest.snapshotDigest,
  });
}

async function readDedicatedKey(path, repositoryRoot, dependencies = {}) {
  const uid = dependencies.uid ?? process.getuid?.();
  const inspected = await inspectDedicatedKeyFile(path, repositoryRoot, uid, dependencies);
  const handle = inspected.handle;
  let bytes;
  try {
    const opened = inspected.info;
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead < 1) throw new TypeError("dedicated credential truncated");
      offset += bytesRead;
    }
    const key = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.ctimeMs !== opened.ctimeMs ||
        key.length < 16 || key.length > 8_192 || /[\0\r\n\t ]/.test(key))
      throw new TypeError("dedicated credential invalid");
    return { apiKey: key, identityDigest: inspected.identityDigest };
  } finally { bytes?.fill(0); await handle.close(); }
}

/** Builds the non-root runtime from a closed environment. No key/path/source
 * bytes are returned in capability, receipt or launcher proof metadata. */
export async function createAmuxV22ReadOnlyApiHost(environment, dependencies = {}) {
  if (!environment || typeof environment !== "object" ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED !== "true" ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_OPERATIONAL_GATES !== "true" ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_DEDICATED !== "true" ||
      forbiddenHostEnvironment(environment))
    throw new TypeError("read-only API executor disabled");
  if (dependencies.testOnly !== true) assertClosedProcessEnvironment(environment);
  const worker = environment.TOMVERSE_AMUX_V22_WORKER;
  const repositoryRoot = environment.TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_ROOT;
  const sourceRevision = environment.TOMVERSE_AMUX_V22_READ_ONLY_API_SOURCE_REVISION;
  if (!WORKER.test(worker) || typeof repositoryRoot !== "string" ||
      !isAbsolute(repositoryRoot) || !REVISION.test(sourceRevision))
    throw new TypeError("invalid read-only API host configuration");
  const clock = dependencies.testOnly === true &&
    typeof dependencies.clock === "function" ? dependencies.clock : Date.now;
  const startedAtMs = clock();
  const hostDeadlineAtMs = dependencies.testOnly === true
    ? dependencies.hostDeadlineAtMs
    : startedAtMs + MAX_HOST_LIFETIME_MS;
  if (!Number.isSafeInteger(hostDeadlineAtMs) || hostDeadlineAtMs <= startedAtMs ||
      hostDeadlineAtMs - startedAtMs > MAX_HOST_LIFETIME_MS)
    throw new TypeError("invalid read-only API host deadline");
  let allowedPrefixes, frame;
  try {
    allowedPrefixes = JSON.parse(
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON);
    frame = parseAmuxV22ReadOnlyApiExecutionFrame(JSON.parse(
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON),
    { now: dependencies.now });
  } catch { throw new TypeError("invalid read-only API host configuration"); }
  if (!Array.isArray(allowedPrefixes) || allowedPrefixes.length < 1 ||
      allowedPrefixes.length > 32 ||
      allowedPrefixes.some(value => typeof value !== "string"))
    throw new TypeError("invalid read-only API repository scope");
  const repositoryScopeDigest = amuxV22ReadOnlyApiRepositoryScopeDigest({
    sourceRevision, allowedPrefixes,
  });
  if (frame.repositoryScopeDigest !== repositoryScopeDigest ||
      frame.settingsDigest !== AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST ||
      frame.brokerPolicyDigest !== AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST ||
      frame.toolSchemaDigest !== AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST)
    throw new TypeError("read-only API frame drift");
  const snapshotManifest = await createAmuxV22ReadOnlyApiSnapshotManifest({
    repositoryRoot, sourceRevision, allowedPrefixes,
  }, dependencies.brokerDependencies);
  const broker = createAmuxV22ReadOnlyApiBroker({ repositoryRoot, sourceRevision,
    allowedPrefixes, repositoryScopeDigest,
    brokerPolicyDigest: frame.brokerPolicyDigest,
    toolSchemaDigest: frame.toolSchemaDigest, snapshotManifest },
  dependencies.brokerDependencies);
  const credential = await readDedicatedKey(
    environment.TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE, repositoryRoot, dependencies);
  const serviceConfigDigest = dependencies.testOnly === true &&
    DIGEST.test(dependencies.serviceConfigDigest)
    ? dependencies.serviceConfigDigest
    : await measureProtectedApiHostState(environment, frame, snapshotManifest,
      credential.identityDigest, dependencies);
  const runtime = { environment,
    operationalGatesSatisfied: true,
    credential: { verified: true, dedicated: true, apiKey: credential.apiKey,
      profileId: frame.credentialProfileId,
      metadataDigest: frame.credentialMetadataDigest },
    executorArtifactDigest: frame.executorArtifactDigest,
    settingsDigest: frame.settingsDigest, repositoryScopeDigest,
    brokerPolicyDigest: frame.brokerPolicyDigest,
    toolSchemaDigest: frame.toolSchemaDigest, broker, hostDeadlineAtMs };
  if (dependencies.testOnly === true) Object.assign(runtime, { testOnly: true,
    fetcher: dependencies.fetcher, clock: dependencies.clock,
    setTimer: dependencies.setTimer, clearTimer: dependencies.clearTimer });
  const executor = createAmuxV22ReadOnlyApiExecutor(runtime);
  const apiExecutionFrameDigest = amuxV22ReadOnlyApiExecutionFrameDigest(frame);
  const launcherConfigDigest = amuxV22ReadOnlyApiLauncherConfigDigest({ worker,
    apiExecutionFrameDigest, credentialProfileId: frame.credentialProfileId,
    credentialMetadataDigest: frame.credentialMetadataDigest,
    executorArtifactDigest: frame.executorArtifactDigest,
    settingsDigest: frame.settingsDigest, repositoryScopeDigest,
    brokerPolicyDigest: frame.brokerPolicyDigest,
    toolSchemaDigest: frame.toolSchemaDigest,
    gitProofDigest: snapshotManifest.gitProofDigest,
    snapshotDigest: snapshotManifest.snapshotDigest,
    serviceConfigDigest });
  return Object.freeze({ worker, frame, executor, apiExecutionFrameDigest,
    launcherConfigDigest, hostDeadlineAtMs,
    capabilities: () => executor.capabilities(frame, { now: dependencies.now }) });
}

/** Reads the running fixed unit as root without reading credential bytes or
 * making a provider request. Only content-free proof metadata is returned. */
export async function readAmuxV22ReadOnlyApiLauncherState(worker, rawFrame,
  options = {}) {
  const liveRoot = process.platform === "linux" && process.getuid?.() === 0;
  const synthetic = !liveRoot && options.testOnly === true &&
    options.syntheticPlatform === true;
  if (!WORKER.test(worker) || (!liveRoot && !synthetic))
    throw new TypeError("root Linux API launcher inspection required");
  const runtimeOptions = synthetic ? options : {};
  const frame = parseAmuxV22ReadOnlyApiExecutionFrame(rawFrame,
    { now: synthetic ? options.now : undefined });
  const paths = runtimePaths(worker);
  const [unitBefore, cliUnitBefore] = await Promise.all([
    readUnitState(paths.unit, runtimeOptions),
    readInactiveCliUnitState(worker, runtimeOptions),
  ]);
  const pid = validateUnitState(unitBefore, worker);
  validateInactiveCliUnitState(cliUnitBefore, worker);
  const processBefore = await readProcessState(pid, runtimeOptions);
  const environment = validateProcessState(processBefore);
  if (environment.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED !== "true" ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_OPERATIONAL_GATES !== "true" ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_DEDICATED !== "true" ||
      environment.TOMVERSE_AMUX_V22_WORKER !== worker ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_ROOT !==
        API_REPOSITORY_ROOT ||
      environment.TOMVERSE_AMUX_V22_SIDECAR_SOCKET !== paths.socketPath ||
      environment.TOMVERSE_AMUX_V22_SIDECAR_STATE_DIR !== paths.stateDir ||
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_HOST_ENV_FILE !==
        paths.environmentFile)
    throw new TypeError("read-only API runtime environment drift");
  const emptyStateBefore = await inspectEmptyApiStateDirectory(
    paths.stateDir, processBefore.uid, runtimeOptions);
  let allowedPrefixes, processFrame;
  try {
    allowedPrefixes = JSON.parse(
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_ALLOWED_PREFIXES_JSON);
    processFrame = parseAmuxV22ReadOnlyApiExecutionFrame(JSON.parse(
      environment.TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTION_FRAME_JSON),
    { now: synthetic ? options.now : undefined });
  } catch { throw new TypeError("read-only API runtime frame drift"); }
  const sourceRevision =
    environment.TOMVERSE_AMUX_V22_READ_ONLY_API_SOURCE_REVISION;
  if (!REVISION.test(sourceRevision) || !Array.isArray(allowedPrefixes) ||
      allowedPrefixes.length < 1 || allowedPrefixes.length > 32 ||
      allowedPrefixes.some(value => typeof value !== "string") ||
      amuxV22ReadOnlyApiExecutionFrameDigest(processFrame) !==
        amuxV22ReadOnlyApiExecutionFrameDigest(frame) ||
      frame.repositoryScopeDigest !== amuxV22ReadOnlyApiRepositoryScopeDigest({
        sourceRevision, allowedPrefixes,
      }) || frame.settingsDigest !== AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST ||
      frame.brokerPolicyDigest !== AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST ||
      frame.toolSchemaDigest !== AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST)
    throw new TypeError("read-only API runtime frame drift");
  const createSnapshot = synthetic && typeof options.createSnapshotManifest === "function"
    ? options.createSnapshotManifest : createAmuxV22ReadOnlyApiSnapshotManifest;
  const snapshotManifest = await createSnapshot({ repositoryRoot: API_REPOSITORY_ROOT,
    sourceRevision, allowedPrefixes }, runtimeOptions.brokerDependencies);
  if (!snapshotManifest || !DIGEST.test(snapshotManifest.gitProofDigest) ||
      !DIGEST.test(snapshotManifest.snapshotDigest))
    throw new TypeError("read-only API repository proof unavailable");
  const inspectKey = synthetic && typeof options.inspectDedicatedCredential === "function"
    ? options.inspectDedicatedCredential : inspectDedicatedKeyFile;
  const inspectedKey = await inspectKey(
    environment.TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE,
    API_REPOSITORY_ROOT, processBefore.uid, runtimeOptions);
  if (!inspectedKey || !DIGEST.test(inspectedKey.identityDigest)) {
    await inspectedKey?.handle?.close();
    throw new TypeError("read-only API credential proof unavailable");
  }
  let serviceConfigDigest;
  try {
    const measure = synthetic && typeof options.measureProtectedHostState === "function"
      ? options.measureProtectedHostState : measureProtectedApiHostState;
    serviceConfigDigest = await measure(environment, frame, snapshotManifest,
      inspectedKey.identityDigest, runtimeOptions);
  } finally { await inspectedKey.handle?.close(); }
  if (!DIGEST.test(serviceConfigDigest))
    throw new TypeError("read-only API service proof unavailable");
  const [unitAfter, cliUnitAfter, processAfter, emptyStateAfter] = await Promise.all([
    readUnitState(paths.unit, runtimeOptions),
    readInactiveCliUnitState(worker, runtimeOptions),
    readProcessState(pid, runtimeOptions),
    inspectEmptyApiStateDirectory(paths.stateDir, processBefore.uid, runtimeOptions),
  ]);
  if (validateUnitState(unitAfter, worker) !== pid ||
      canonicalJson(validateInactiveCliUnitState(cliUnitAfter, worker)) !==
        canonicalJson(cliUnitBefore) ||
      canonicalJson(unitAfter) !== canonicalJson(unitBefore) ||
      canonicalJson(validateProcessState(processAfter)) !== canonicalJson(environment) ||
      processAfter.uid !== processBefore.uid || processAfter.gid !== processBefore.gid ||
      canonicalJson(processAfter.groups) !== canonicalJson(processBefore.groups) ||
      emptyStateAfter !== emptyStateBefore)
    throw new TypeError("read-only API launcher changed during inspection");
  const keyAfter = await inspectKey(
    environment.TOMVERSE_AMUX_V22_READ_ONLY_API_KEY_FILE,
    API_REPOSITORY_ROOT, processBefore.uid, runtimeOptions);
  try {
    if (keyAfter?.identityDigest !== inspectedKey.identityDigest)
      throw new TypeError("read-only API credential changed during inspection");
  } finally { await keyAfter?.handle?.close(); }
  return Object.freeze({ worker, enabled: true, operationalGatesSatisfied: true,
    credentialDedicated: true,
    apiExecutionFrameDigest: amuxV22ReadOnlyApiExecutionFrameDigest(frame),
    credentialProfileId: frame.credentialProfileId,
    credentialMetadataDigest: frame.credentialMetadataDigest,
    executorArtifactDigest: frame.executorArtifactDigest,
    settingsDigest: frame.settingsDigest,
    repositoryScopeDigest: frame.repositoryScopeDigest,
    brokerPolicyDigest: frame.brokerPolicyDigest,
    toolSchemaDigest: frame.toolSchemaDigest,
    gitProofDigest: snapshotManifest.gitProofDigest,
    snapshotDigest: snapshotManifest.snapshotDigest,
    serviceConfigDigest });
}

/** Root preflight adapter. The default reader measures the fixed live unit;
 * tests may still inject a closed synthetic state reader. */
export async function inspectAmuxV22ReadOnlyApiLauncher(worker, frame, options = {}) {
  if (!WORKER.test(worker)) return { current: false };
  try {
    const parsed = parseAmuxV22ReadOnlyApiExecutionFrame(frame, { now: options.now });
    const state = await (options.readApiLauncherState ??
      (name => readAmuxV22ReadOnlyApiLauncherState(name, parsed, options)))(worker);
    const frameDigest = amuxV22ReadOnlyApiExecutionFrameDigest(parsed);
    if (!state || state.enabled !== true || state.operationalGatesSatisfied !== true ||
        state.credentialDedicated !== true || state.worker !== worker ||
        state.apiExecutionFrameDigest !== frameDigest ||
        state.credentialProfileId !== parsed.credentialProfileId ||
        state.credentialMetadataDigest !== parsed.credentialMetadataDigest ||
        state.executorArtifactDigest !== parsed.executorArtifactDigest ||
        state.settingsDigest !== parsed.settingsDigest ||
        state.repositoryScopeDigest !== parsed.repositoryScopeDigest ||
        state.brokerPolicyDigest !== parsed.brokerPolicyDigest ||
        state.toolSchemaDigest !== parsed.toolSchemaDigest ||
        !DIGEST.test(state.gitProofDigest) ||
        !DIGEST.test(state.snapshotDigest) ||
        !DIGEST.test(state.serviceConfigDigest))
      return { current: false };
    return { current: true, launcherConfigDigest:
      amuxV22ReadOnlyApiLauncherConfigDigest(state) };
  } catch { return { current: false }; }
}
