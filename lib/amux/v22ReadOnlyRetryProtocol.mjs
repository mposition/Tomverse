import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, posix } from "node:path";

import {
  AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  amuxV22ReadOnlyApiLaunchScopeDigest,
  parseAmuxV22ReadOnlyApiExecutionFrame,
} from "./v22ReadOnlyApiProtocol.mjs";

export const AMUX_V22_READ_ONLY_RETRY_PROTOCOL_VERSION = 1;
export const AMUX_V22_READ_ONLY_RETRY_CAPABILITY = "read_only_retry_v1";
export const AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION =
  "amux-v22-read-only-retry-v1";
export const AMUX_V22_READ_ONLY_ALLOWED_TOOLS = Object.freeze([
  "Glob", "Grep", "Read",
]);

const TARGET_HOST = "amux-ubuntu";
const EXEC_START = Object.freeze([
  "/usr/bin/node", "/opt/tomverse-amux-v22/task-sidecar.mjs",
]);
const CHILD_PATH_ENV = Object.freeze({
  worker: "TOMVERSE_AMUX_V22_WORKER",
  binaryPath: "TOMVERSE_AMUX_V22_CLAUDE_BINARY",
  worktreePath: "TOMVERSE_AMUX_V22_WORKTREE",
  homePath: "TOMVERSE_AMUX_V22_HOME",
  claudeConfigDir: "TOMVERSE_AMUX_V22_CLAUDE_CONFIG_DIR",
});
export const AMUX_V22_SIDECAR_LAUNCH_ENV = CHILD_PATH_ENV;
const MAX_CUSTOMIZATION_BYTES = 256 * 1024;
const REMOTE_MANAGED_SETTINGS_PROOF = "unavailable_fail_closed";
const DENIED_CAPABILITIES = Object.freeze([
  "Bash", "Edit", "Write", "MCP", "browser", "network", "github_write",
  "external_action",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MODEL = /^claude-[A-Za-z0-9._-]{1,120}$/;
const MONEY = /^(?:0|[1-9][0-9]{0,15})$/;
const MAX_ADDITIONAL_MICROUSD = 3_400_000n;
const PRIOR_HELD_MICROUSD = 3_400_000n;
const MAX_EXPOSURE_MICROUSD = 6_800_000n;
const BINDING_KEYS = [
  "additionalCapMicroUsd", "briefDigest", "catalogApprovalId", "catalogVersion",
  "costReceiptDigest", "fixedArgvDigest", "launchBindingId", "launcherConfigDigest",
  "launcherPolicyVersion", "launchProofDigest", "launchScopeDigest", "modelId",
  "pricingVersion", "profileConfigDigest", "provider", "riskAcceptanceDigest", "role",
  "routeId", "routePolicyDigest", "safeStopEvidenceDigest", "toolPolicyDigest", "version",
  "worstExposureMicroUsd",
].sort().join(",");
const API_BINDING_KEYS = [
  "additionalCapMicroUsd", "apiExecutionFrame", "apiExecutionFrameDigest",
  "briefDigest", "catalogApprovalId", "catalogVersion", "costReceiptDigest",
  "executorKind", "launchBindingId", "launcherConfigDigest", "launchProofDigest",
  "launchScopeDigest", "modelId", "pricingVersion", "provider",
  "riskAcceptanceDigest", "role", "routeId", "routePolicyDigest",
  "safeStopEvidenceDigest", "version", "worstExposureMicroUsd",
].sort().join(",");

const exactKeys = (value, keys) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
const boundedText = value => typeof value === "string" && value.length >= 1 &&
  value.length <= 128 && !/[\0\r\n]/.test(value);
const canonicalJson = value => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};
const recoveryDigest = (kind, value) => createHash("sha256")
  .update(`amux-v22-task-recovery-${kind}-v1\n`)
  .update(canonicalJson(value)).digest("hex");

const canonicalAbsolutePath = value => typeof value === "string" && value.length >= 2 &&
  value.length <= 1_024 && !/[\0\r\n]/.test(value) && posix.isAbsolute(value) &&
  posix.normalize(value) === value && !value.endsWith("/");

export function amuxV22SidecarLaunchConfigFromEnvironment(environment) {
  if (!environment || typeof environment !== "object")
    throw new TypeError("invalid sidecar launch environment");
  const config = Object.fromEntries(Object.entries(CHILD_PATH_ENV).map(([key, name]) =>
    [key, environment[name]]));
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.worker) ||
      [config.binaryPath, config.worktreePath, config.homePath, config.claudeConfigDir]
        .some(value => !canonicalAbsolutePath(value)))
    throw new TypeError("invalid sidecar launch environment");
  return Object.freeze(config);
}

export function amuxV22ReadOnlyActualLauncherConfigDigest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !DIGEST.test(input.profileConfigDigest) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.worker) ||
      [input.binaryPath, input.worktreePath, input.homePath, input.claudeConfigDir]
        .some(value => !canonicalAbsolutePath(value)) ||
      [input.nodeArtifactDigest, input.sidecarArtifactDigest, input.cliArtifactDigest,
        input.localCustomizationDigest]
        .concat([input.worktreeIdentityDigest, input.homeIdentityDigest,
          input.claudeConfigIdentityDigest])
        .some(value => !DIGEST.test(value)))
    throw new TypeError("invalid actual launcher config");
  return recoveryDigest("read-only-launcher-config", {
    version: 2,
    launcherPolicyVersion: AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION,
    targetHost: TARGET_HOST,
    worker: input.worker,
    serviceExecStart: [...EXEC_START],
    child: {
      binaryPath: input.binaryPath,
      cwd: input.worktreePath,
      cwdIdentityDigest: input.worktreeIdentityDigest,
      environment: { HOME: input.homePath, PATH: "/usr/bin:/bin", LANG: "C.UTF-8",
        CLAUDE_CONFIG_DIR: input.claudeConfigDir },
      homeIdentityDigest: input.homeIdentityDigest,
      claudeConfigIdentityDigest: input.claudeConfigIdentityDigest,
    },
    artifacts: {
      node: { path: EXEC_START[0], digest: input.nodeArtifactDigest },
      sidecar: { path: EXEC_START[1], digest: input.sidecarArtifactDigest },
      cli: { path: input.binaryPath, digest: input.cliArtifactDigest },
    },
    customization: {
      localDigest: input.localCustomizationDigest,
      remoteManagedSettingsProof: REMOTE_MANAGED_SETTINGS_PROOF,
    },
    profileConfigDigest: input.profileConfigDigest,
  });
}

function customizationPaths(config) {
  return {
    json: [
      posix.join(config.claudeConfigDir, "settings.json"),
      posix.join(config.claudeConfigDir, ".claude.json"),
      `${config.claudeConfigDir}.json`,
      posix.join(config.homePath, ".claude.json"),
      posix.join(config.worktreePath, ".claude", "settings.json"),
      posix.join(config.worktreePath, ".claude", "settings.local.json"),
      posix.join(config.worktreePath, ".mcp.json"),
      posix.join(config.claudeConfigDir, "remote-settings.json"),
      "/etc/claude-code/managed-settings.json",
      "/etc/claude-code/managed-mcp.json",
    ],
    forbiddenFiles: ["/etc/claude-code/managed-CLAUDE.md"],
    directories: [
      posix.join(config.claudeConfigDir, "commands"),
      posix.join(config.claudeConfigDir, "agents"),
      posix.join(config.claudeConfigDir, "skills"),
      posix.join(config.claudeConfigDir, "hooks"),
      posix.join(config.claudeConfigDir, "plugins"),
      posix.join(config.worktreePath, ".claude", "commands"),
      posix.join(config.worktreePath, ".claude", "agents"),
      posix.join(config.worktreePath, ".claude", "skills"),
      posix.join(config.worktreePath, ".claude", "hooks"),
      posix.join(config.worktreePath, ".claude", "plugins"),
    ],
  };
}

async function protectedDirectoryIdentity(path, uid, options) {
  if (!canonicalAbsolutePath(path) ||
      !await protectedPath(path, [0, uid], "directory", options))
    throw new Error("launcher directory unverified");
  const info = await (options.lstat ?? lstat)(path);
  if (!info.isDirectory() || info.isSymbolicLink() || ![0, uid].includes(info.uid) ||
      (info.mode & 0o022) !== 0 || !Number.isSafeInteger(info.dev) ||
      !Number.isSafeInteger(info.ino)) throw new Error("launcher directory unverified");
  return recoveryDigest("read-only-launch-directory-identity", {
    path, device: String(info.dev), inode: String(info.ino), uid: info.uid,
    mode: info.mode & 0o777,
  });
}

async function protectedPath(path, allowedUids, leaf, options) {
  const stat = options.lstat ?? lstat;
  let current = path;
  for (let depth = 0; depth < 32; depth += 1) {
    const info = await stat(current);
    if (info.isSymbolicLink() || !allowedUids.includes(info.uid) || (info.mode & 0o022) !== 0)
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

async function rootProtectedAnchorIdentity(path, options) {
  const stat = options.lstat ?? lstat;
  let current = dirname(path);
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const info = await stat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 ||
          (info.mode & 0o022) !== 0 || !Number.isSafeInteger(info.dev) ||
          !Number.isSafeInteger(info.ino) ||
          !await protectedPath(current, [0], "directory", options))
        throw new Error("customization parent unverified");
      return recoveryDigest("read-only-customization-parent", {
        path: current, device: String(info.dev), inode: String(info.ino),
        mode: info.mode & 0o777, ctimeMs: info.ctimeMs,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("customization parent unverified");
      current = parent;
    }
  }
  throw new Error("customization parent unverified");
}

const absent = error => error?.code === "ENOENT";

async function customizationFileState(path, options, allowPresent = true) {
  const stat = options.lstat ?? lstat;
  const anchorBefore = await rootProtectedAnchorIdentity(path, options);
  let before;
  try { before = await stat(path); }
  catch (error) {
    if (!absent(error)) throw error;
    const anchorAfter = await rootProtectedAnchorIdentity(path, options);
    if (anchorAfter !== anchorBefore) throw new Error("customization parent changed");
    try { await stat(path); throw new Error("customization source appeared"); }
    catch (finalError) { if (!absent(finalError)) throw finalError; }
    return recoveryDigest("read-only-customization-source", { path, state: "absent" });
  }
  if (!allowPresent || !before.isFile() || before.isSymbolicLink() || before.uid !== 0 ||
      before.nlink !== 1 || (before.mode & 0o022) !== 0 || before.size < 2 ||
      before.size > MAX_CUSTOMIZATION_BYTES || !Number.isSafeInteger(before.dev) ||
      !Number.isSafeInteger(before.ino)) throw new Error("unsafe customization source");
  const handle = await (options.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== before.uid || opened.dev !== before.dev ||
        opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1 ||
        opened.ctimeMs !== before.ctimeMs || (opened.mode & 0o022) !== 0)
      throw new Error("unsafe customization source");
    buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead < 1) throw new Error("customization source truncated");
      offset += bytesRead;
    }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !Object.keys(parsed).every(key => key === "$schema") ||
        (Object.hasOwn(parsed, "$schema") &&
          parsed.$schema !== "https://json.schemastore.org/claude-code-settings.json"))
      throw new Error("customization source is not closed");
    const after = await handle.stat();
    const anchorAfter = await rootProtectedAnchorIdentity(path, options);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.ctimeMs !== opened.ctimeMs || anchorAfter !== anchorBefore)
      throw new Error("customization source changed");
    return recoveryDigest("read-only-customization-source", {
      path, state: "present", device: String(opened.dev), inode: String(opened.ino),
      mode: opened.mode & 0o777, contentSha256: createHash("sha256").update(buffer).digest("hex"),
    });
  } finally { buffer?.fill(0); await handle.close(); }
}

async function customizationDirectoryState(path, options) {
  const stat = options.lstat ?? lstat;
  const anchorBefore = await rootProtectedAnchorIdentity(path, options);
  let before;
  try { before = await stat(path); }
  catch (error) {
    if (!absent(error)) throw error;
    const anchorAfter = await rootProtectedAnchorIdentity(path, options);
    if (anchorAfter !== anchorBefore) throw new Error("customization parent changed");
    try { await stat(path); throw new Error("customization directory appeared"); }
    catch (finalError) { if (!absent(finalError)) throw finalError; }
    return recoveryDigest("read-only-customization-directory", { path, state: "absent" });
  }
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== 0 ||
      (before.mode & 0o022) !== 0 || !Number.isSafeInteger(before.dev) ||
      !Number.isSafeInteger(before.ino) ||
      !await protectedPath(path, [0], "directory", options))
    throw new Error("unsafe customization directory");
  const entries = await (options.readdir ?? readdir)(path);
  if (!Array.isArray(entries) || entries.length !== 0)
    throw new Error("customization directory is not empty");
  const after = await stat(path);
  const anchorAfter = await rootProtectedAnchorIdentity(path, options);
  if (after.dev !== before.dev || after.ino !== before.ino ||
      after.ctimeMs !== before.ctimeMs || anchorAfter !== anchorBefore)
    throw new Error("customization directory changed");
  return recoveryDigest("read-only-customization-directory", {
    path, state: "empty", device: String(before.dev), inode: String(before.ino),
    mode: before.mode & 0o777,
  });
}

/** This local measurement is necessary but deliberately not sufficient for a
 * launch. Server-managed policy can arrive over the authenticated provider
 * connection and cannot be attested by this host-only reader. */
export async function inspectAmuxV22ReadOnlyLocalCustomizations(config, options = {}) {
  try {
    const parsed = amuxV22SidecarLaunchConfigFromEnvironment(Object.fromEntries(
      Object.entries(CHILD_PATH_ENV).map(([key, name]) => [name, config?.[key]])));
    const paths = customizationPaths(parsed);
    const sources = [];
    for (const path of paths.json)
      sources.push(await customizationFileState(path, options));
    for (const path of paths.forbiddenFiles)
      sources.push(await customizationFileState(path, options, false));
    for (const path of paths.directories)
      sources.push(await customizationDirectoryState(path, options));
    return { current: true, localCustomizationDigest:
      recoveryDigest("read-only-local-customizations", { version: 1, sources }) };
  } catch { return { current: false }; }
}

async function protectedArtifactDigest(path, limit, options) {
  if (!canonicalAbsolutePath(path) || !await protectedPath(path, [0], "file", options))
    throw new Error("launcher artifact unverified");
  const stat = options.lstat ?? lstat;
  const before = await stat(path);
  if (before.uid !== 0 || (before.mode & 0o111) === 0 || before.size < 1 || before.size > limit)
    throw new Error("launcher artifact unverified");
  const handle = await (options.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== before.uid || opened.dev !== before.dev ||
        opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1 ||
        (opened.mode & 0o022) !== 0) throw new Error("launcher artifact unverified");
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0,
        Math.min(buffer.length, opened.size - offset), offset);
      if (bytesRead < 1) throw new Error("launcher artifact unverified");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.ctimeMs !== opened.ctimeMs) throw new Error("launcher artifact changed");
    return hash.digest("hex");
  } finally { buffer.fill(0); await handle.close(); }
}

/** Measure only the non-secret child launch boundary. No path, environment
 * value or artifact bytes are returned; callers may persist only the digest. */
export async function inspectAmuxV22ReadOnlyLauncherConfig(config, profileConfigDigest,
  options = {}) {
  try {
    const parsed = amuxV22SidecarLaunchConfigFromEnvironment(Object.fromEntries(
      Object.entries(CHILD_PATH_ENV).map(([key, name]) => [name, config?.[key]])));
    const uid = options.uid ?? process.getuid?.();
    if (!Number.isSafeInteger(uid) || uid < 1) return { current: false };
    const directoryIdentity = async () => ({
      worktreeIdentityDigest: await protectedDirectoryIdentity(parsed.worktreePath, uid, options),
      homeIdentityDigest: await protectedDirectoryIdentity(parsed.homePath, uid, options),
      claudeConfigIdentityDigest: await protectedDirectoryIdentity(
        parsed.claudeConfigDir, uid, options),
    });
    const identities = await directoryIdentity();
    const localCustomizations = await inspectAmuxV22ReadOnlyLocalCustomizations(parsed, options);
    if (localCustomizations.current !== true) return { current: false };
    const nodeArtifactDigest = await protectedArtifactDigest(EXEC_START[0],
      256 * 1024 * 1024, options);
    const sidecarArtifactDigest = await protectedArtifactDigest(EXEC_START[1],
      16 * 1024 * 1024, options);
    const cliArtifactDigest = await protectedArtifactDigest(parsed.binaryPath,
      64 * 1024 * 1024, options);
    const finalIdentities = await directoryIdentity();
    const finalLocalCustomizations = await inspectAmuxV22ReadOnlyLocalCustomizations(
      parsed, options);
    if (canonicalJson(finalIdentities) !== canonicalJson(identities) ||
        finalLocalCustomizations.current !== true ||
        finalLocalCustomizations.localCustomizationDigest !==
          localCustomizations.localCustomizationDigest) return { current: false };
    amuxV22ReadOnlyActualLauncherConfigDigest({
      ...parsed, profileConfigDigest, nodeArtifactDigest, sidecarArtifactDigest,
      cliArtifactDigest, ...identities,
      localCustomizationDigest: localCustomizations.localCustomizationDigest,
    });
    // `--safe-mode` still applies remotely delivered managed policy hooks.
    // There is no trusted host-only proof of that remote source in this v1
    // protocol, so a read-only retry cannot safely reach the CLI yet.
    return { current: false };
  } catch { return { current: false }; }
}

export function amuxV22ReadOnlyLauncherDigests(profileConfigDigest, actualLauncherConfigDigest) {
  if (!DIGEST.test(profileConfigDigest)) throw new TypeError("invalid profile config digest");
  const launcherConfigDigest = actualLauncherConfigDigest ?? recoveryDigest("read-only-launcher-config", {
    version: 1,
    launcherPolicyVersion: AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION,
    targetHost: TARGET_HOST,
    execStart: [...EXEC_START],
    profileConfigDigest,
  });
  if (!DIGEST.test(launcherConfigDigest)) throw new TypeError("invalid launcher config digest");
  const fixedArgvDigest = recoveryDigest("read-only-fixed-argv", {
    version: 1,
    role: "investigate",
    permissionMode: "dontAsk",
    allowedTools: [...AMUX_V22_READ_ONLY_ALLOWED_TOOLS],
    maxTurns: 8,
    outputFormat: "json",
  });
  const toolPolicyDigest = recoveryDigest("read-only-tool-policy", {
    version: 1,
    allowedTools: [...AMUX_V22_READ_ONLY_ALLOWED_TOOLS],
    deniedCapabilities: [...DENIED_CAPABILITIES],
  });
  return { launcherConfigDigest, fixedArgvDigest, toolPolicyDigest };
}

export function amuxV22ReadOnlyLaunchScope(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !DIGEST.test(input.profileConfigDigest)) throw new TypeError("invalid read-only launch scope");
  const digests = amuxV22ReadOnlyLauncherDigests(input.profileConfigDigest,
    input.launcherConfigDigest);
  return {
    version: AMUX_V22_READ_ONLY_RETRY_PROTOCOL_VERSION,
    launcherPolicyVersion: AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION,
    launcherConfigDigest: digests.launcherConfigDigest,
    fixedArgvDigest: digests.fixedArgvDigest,
    toolPolicyDigest: digests.toolPolicyDigest,
    profileConfigDigest: input.profileConfigDigest,
    role: "investigate",
    allowedTools: [...AMUX_V22_READ_ONLY_ALLOWED_TOOLS],
  };
}

export const amuxV22ReadOnlyLaunchScopeDigest = scope =>
  recoveryDigest("read-only-launch-scope", scope);

export function validateAmuxV22ReadOnlyRetryBinding(input) {
  if (input?.executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND) {
    if (!exactKeys(input, API_BINDING_KEYS) ||
        input.version !== AMUX_V22_READ_ONLY_RETRY_PROTOCOL_VERSION ||
        input.provider !== "anthropic" || input.role !== "investigate" ||
        !UUID.test(input.launchBindingId) || !MODEL.test(input.modelId) ||
        !ID.test(input.routeId) || !ID.test(input.catalogApprovalId) ||
        !boundedText(input.catalogVersion) || !boundedText(input.pricingVersion) ||
        [input.riskAcceptanceDigest, input.safeStopEvidenceDigest,
          input.launchProofDigest, input.launchScopeDigest,
          input.launcherConfigDigest, input.apiExecutionFrameDigest,
          input.briefDigest, input.routePolicyDigest, input.costReceiptDigest]
          .some(value => !DIGEST.test(value)))
      return { ok: false, reason: "binding_value" };
    if (!MONEY.test(input.additionalCapMicroUsd) ||
        !MONEY.test(input.worstExposureMicroUsd))
      return { ok: false, reason: "binding_cost" };
    const additional = BigInt(input.additionalCapMicroUsd);
    const exposure = BigInt(input.worstExposureMicroUsd);
    if (additional < 1n || additional > MAX_ADDITIONAL_MICROUSD ||
        exposure !== PRIOR_HELD_MICROUSD + additional ||
        exposure > MAX_EXPOSURE_MICROUSD)
      return { ok: false, reason: "binding_cost" };
    try {
      const frame = parseAmuxV22ReadOnlyApiExecutionFrame(input.apiExecutionFrame);
      const frameDigest = amuxV22ReadOnlyApiExecutionFrameDigest(frame);
      const scope = { version: 1, executorKind: AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
        launcherConfigDigest: input.launcherConfigDigest,
        apiExecutionFrameDigest: frameDigest };
      if (input.apiExecutionFrameDigest !== frameDigest ||
          input.launchScopeDigest !== amuxV22ReadOnlyApiLaunchScopeDigest(scope) ||
          frame.provider !== input.provider || frame.modelId !== input.modelId ||
          frame.routeId !== input.routeId ||
          frame.routePolicyDigest !== input.routePolicyDigest ||
          frame.catalogApprovalId !== input.catalogApprovalId ||
          frame.catalogVersion !== input.catalogVersion ||
          frame.pricingVersion !== input.pricingVersion ||
          frame.maximumCostMicroUsd !== Number(additional))
        return { ok: false, reason: "binding_scope" };
    } catch { return { ok: false, reason: "binding_scope" }; }
    return { ok: true };
  }
  if (!exactKeys(input, BINDING_KEYS)) return { ok: false, reason: "binding_shape" };
  if (input.version !== AMUX_V22_READ_ONLY_RETRY_PROTOCOL_VERSION ||
      input.launcherPolicyVersion !== AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION ||
      input.provider !== "anthropic" || input.role !== "investigate" ||
      !UUID.test(input.launchBindingId) || !MODEL.test(input.modelId) ||
      !ID.test(input.routeId) || !ID.test(input.catalogApprovalId) ||
      !boundedText(input.catalogVersion) || !boundedText(input.pricingVersion) ||
      [input.riskAcceptanceDigest, input.safeStopEvidenceDigest, input.launchProofDigest,
        input.launchScopeDigest, input.launcherConfigDigest, input.fixedArgvDigest,
        input.toolPolicyDigest, input.profileConfigDigest, input.briefDigest,
        input.routePolicyDigest, input.costReceiptDigest].some(value => !DIGEST.test(value))) {
    return { ok: false, reason: "binding_value" };
  }
  if (!MONEY.test(input.additionalCapMicroUsd) || !MONEY.test(input.worstExposureMicroUsd))
    return { ok: false, reason: "binding_cost" };
  const additional = BigInt(input.additionalCapMicroUsd);
  const exposure = BigInt(input.worstExposureMicroUsd);
  if (additional < 1n || additional > MAX_ADDITIONAL_MICROUSD ||
      exposure !== PRIOR_HELD_MICROUSD + additional || exposure > MAX_EXPOSURE_MICROUSD)
    return { ok: false, reason: "binding_cost" };
  let scope;
  try { scope = amuxV22ReadOnlyLaunchScope(input); }
  catch { return { ok: false, reason: "binding_scope" }; }
  for (const key of ["launcherConfigDigest", "fixedArgvDigest", "toolPolicyDigest"])
    if (input[key] !== scope[key]) return { ok: false, reason: "binding_scope" };
  if (input.launchScopeDigest !== amuxV22ReadOnlyLaunchScopeDigest(scope))
    return { ok: false, reason: "binding_scope" };
  return { ok: true };
}

export function amuxV22ReadOnlyClaudeArgs(request) {
  const validation = validateAmuxV22ReadOnlyRetryBinding(request?.readOnlyRetry);
  if (!validation.ok || Object.hasOwn(request.readOnlyRetry, "executorKind") ||
      request.role !== "investigate" ||
      request.modelId !== request.readOnlyRetry.modelId ||
      request.budgetMicrousd !== Number(request.readOnlyRetry.additionalCapMicroUsd))
    throw new TypeError("invalid read-only retry execution binding");
  const tools = AMUX_V22_READ_ONLY_ALLOWED_TOOLS.join(",");
  return ["-p", "--output-format", "json", "--no-session-persistence",
    "--no-chrome", "--strict-mcp-config", "--restricted",
    "--permission-prompts", "none", "--permission-mode", "dontAsk",
    // No dollar budget (owner decision 2026-10-25): turns and tools bound it.
    "--model", request.modelId, "--max-turns", "8",
    "--tools", tools, "--allowedTools", tools];
}

export const AMUX_V22_READ_ONLY_EXEC_START = EXEC_START;
