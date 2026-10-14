import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { promisify } from "node:util";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { amuxV22RecoveryDigest } from "./v22TaskRecoveryCore.ts";
import { AMUX_V22_READ_ONLY_EXEC_START,
  AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION,
  AMUX_V22_SIDECAR_LAUNCH_ENV,
  amuxV22ReadOnlyLaunchScope, amuxV22ReadOnlyLauncherDigests,
  amuxV22ReadOnlyLaunchScopeDigest, amuxV22SidecarLaunchConfigFromEnvironment,
  inspectAmuxV22ReadOnlyLauncherConfig } from
  "./v22ReadOnlyRetryProtocol.mjs";
import { inspectAmuxV22ReadOnlyApiLauncher,
  readAmuxV22ReadOnlyApiLauncherState } from "./v22ReadOnlyApiHost.mjs";
import { AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
  amuxV22ReadOnlyApiActualLaunchScope,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  amuxV22ReadOnlyApiLaunchScopeDigest,
  matchAmuxV22ReadOnlyApiLaunchScopes,
  parseAmuxV22ReadOnlyApiExecutionFrame } from "./v22ReadOnlyApiProtocol.mjs";

export const AMUX_V22_RECOVERY_CONTROLLER_SECRET_ENV =
  "TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET";
export const AMUX_V22_LEGACY_SAFE_STOP_ENV =
  "TOMVERSE_AMUX_V22_LEGACY_SAFE_STOP_ENABLED";
export const AMUX_V22_RECOVERY_PROFILE_PATH =
  "/etc/tomverse-amux-v22/recovery-profiles.json";
export const AMUX_V22_RECOVERY_INTENT_DIR =
  "/var/lib/tomverse-amux-v22/recovery-stop-intents";

const SYSTEMCTL = "/usr/bin/systemctl";
const TARGET_HOST = "amux-ubuntu";
const UNIT_PREFIX = "tomverse-amux-v22-sidecar@";
const UNIT_SUFFIX = ".service";
const PROFILE_LIMIT = 128;
const MEMBER_LIMIT = 16;
const PROFILE_BYTES = 65_536;
const JOURNAL_BYTES = 2_048;
const LAUNCH_JOURNAL_BYTES = 2_048;
const READ_ONLY_RETRY_TASK_ID = "c48886b9-86f8-4631-8db8-c0b288a707af";
const READ_ONLY_RETRY_PRIOR_ATTEMPT_ID = "97858395-3d66-42fa-9bfb-0e5a6cba39d8";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const INVOCATION_ID = /^[a-f0-9]{32}$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REQUEST_KEYS = ["inspectionId", "priorAttemptId", "priorAttemptTaskRevision",
  "profileConfigDigest", "profileWorkerNames", "requestDigest", "requestKind", "requestedAt",
  "sourceEvidenceDigest", "sourceEvidenceId", "targetHost", "targetUnit", "taskId", "taskRevision",
  "workerGeneration", "workerInstanceId", "workerName", "workerProfileAlias"].sort().join(",");
const LAUNCH_REQUEST_KEYS = ["additionalCapMicroUsd", "briefDigest", "catalogApprovalId",
  "catalogVersion", "costReceiptDigest", "launchBindingId", "launchCheckId", "launchScope", "modelId",
  "pricingVersion", "priorAttemptId", "provider", "requestDigest", "requestKind", "riskAcceptanceDigest",
  "riskAcceptanceId", "routeId", "routePolicyDigest", "sourceEvidenceDigest", "sourceEvidenceId",
  "targetHost", "taskId", "taskRevision", "workerGeneration", "workerInstanceId", "workerName",
  "worstExposureMicroUsd"].sort().join(",");
const API_LAUNCH_REQUEST_KEYS = `${LAUNCH_REQUEST_KEYS},apiExecutionFrame`
  .split(",").sort().join(",");
const LAUNCH_SCOPE_KEYS = ["allowedTools", "fixedArgvDigest", "launcherConfigDigest",
  "launcherPolicyVersion", "profileConfigDigest", "role", "toolPolicyDigest", "version"]
  .sort().join(",");
const API_LAUNCH_SCOPE_KEYS = ["apiExecutionFrameDigest", "executorKind",
  "launcherConfigDigest", "version"].sort().join(",");
const UNVERIFIED_REPORT_REASONS = new Set(["safe_stop_identity_changed",
  "safe_stop_config_unverified", "safe_stop_profile_not_unique", "safe_stop_other_work_present",
  "safe_stop_journal_unverified", "safe_stop_process_present", "safe_stop_process_unknown",
  "safe_stop_kernel_proof_stale"]);
const SHOW_PROPERTIES = ["Id", "LoadState", "InvocationID", "ControlGroup", "MainPID", "KillMode",
  "Delegate", "Restart", "FragmentPath", "DropInPaths", "ActiveState", "SubState"];
const LAUNCH_SHOW_PROPERTIES = [...SHOW_PROPERTIES, "ExecStart", "EnvironmentFiles"];
const execFileAsync = promisify(execFile);
const FALSE_PROOF = Object.freeze({
  journalBindingDigest: "0".repeat(64), journalEntryDigest: "0".repeat(64),
  journalDisposition: "not_needed_already_gone", stopAcknowledgement: "not_issued",
  processState: "unknown", fixedUnit: false, rootOwnedConfig: false, profileUnique: false,
  noOtherWork: false, restartDisabled: false, journalBound: false, mainPidAbsent: false,
  controlGroupEmpty: false, kernelProofFresh: false,
});

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).sort().join(",") === keys;
const safeRevision = value => Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_644;
const safeGeneration = value => Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
const targetUnit = alias => `${UNIT_PREFIX}${alias}${UNIT_SUFFIX}`;
const boundedText = value => typeof value === "string" && value.length >= 1 &&
  value.length <= 128 && !/[\0\r\n]/.test(value);

export function parseAmuxV22SafeStopRequest(raw) {
  if (!exactKeys(raw, REQUEST_KEYS) || raw.requestKind !== "safe_stop" ||
      !UUID.test(raw.inspectionId) || !DIGEST.test(raw.requestDigest) || !ID.test(raw.taskId) ||
      !safeRevision(raw.taskRevision) || !UUID.test(raw.priorAttemptId) ||
      !safeRevision(raw.priorAttemptTaskRevision) || !MACHINE_ID.test(raw.workerName) ||
      !UUID.test(raw.workerInstanceId) || !safeGeneration(raw.workerGeneration) ||
      raw.targetHost !== TARGET_HOST || !UUID.test(raw.sourceEvidenceId) ||
      !DIGEST.test(raw.sourceEvidenceDigest) || !MACHINE_ID.test(raw.workerProfileAlias) ||
      !Array.isArray(raw.profileWorkerNames) || raw.profileWorkerNames.length < 1 ||
      raw.profileWorkerNames.length > MEMBER_LIMIT ||
      raw.profileWorkerNames.some(name => !MACHINE_ID.test(name)) ||
      new Set(raw.profileWorkerNames).size !== raw.profileWorkerNames.length ||
      [...raw.profileWorkerNames].sort().some((name, index) => name !== raw.profileWorkerNames[index]) ||
      !raw.profileWorkerNames.includes(raw.workerName) || raw.targetUnit !== targetUnit(raw.workerProfileAlias) ||
      !DIGEST.test(raw.profileConfigDigest) || typeof raw.requestedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.requestedAt))) throw new TypeError("invalid safe stop request");
  return raw;
}

export function parseAmuxV22ReadOnlyLaunchCheckRequest(raw) {
  const api = raw?.launchScope?.executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND;
  if (!exactKeys(raw, api ? API_LAUNCH_REQUEST_KEYS : LAUNCH_REQUEST_KEYS) ||
      raw.requestKind !== "read_only_launch_check" ||
      !UUID.test(raw.launchCheckId) || !DIGEST.test(raw.requestDigest) ||
      raw.taskId !== READ_ONLY_RETRY_TASK_ID || !safeRevision(raw.taskRevision) ||
      raw.priorAttemptId !== READ_ONLY_RETRY_PRIOR_ATTEMPT_ID || !MACHINE_ID.test(raw.workerName) ||
      !UUID.test(raw.workerInstanceId) || !safeGeneration(raw.workerGeneration) ||
      raw.targetHost !== TARGET_HOST || !UUID.test(raw.sourceEvidenceId) ||
      !DIGEST.test(raw.sourceEvidenceDigest) || !UUID.test(raw.riskAcceptanceId) ||
      !DIGEST.test(raw.riskAcceptanceDigest) || !UUID.test(raw.launchBindingId) ||
      !DIGEST.test(raw.briefDigest) || raw.provider !== "anthropic" ||
      !/^claude-[A-Za-z0-9._-]{1,120}$/.test(raw.modelId) || !ID.test(raw.routeId) ||
      !DIGEST.test(raw.routePolicyDigest) || !ID.test(raw.catalogApprovalId) ||
      !boundedText(raw.catalogVersion) || !boundedText(raw.pricingVersion) ||
      !DIGEST.test(raw.costReceiptDigest) || !/^[1-9][0-9]{0,15}$/.test(raw.additionalCapMicroUsd) ||
      !/^[1-9][0-9]{0,15}$/.test(raw.worstExposureMicroUsd) ||
      BigInt(raw.additionalCapMicroUsd) > 3_400_000n ||
      BigInt(raw.worstExposureMicroUsd) !== 3_400_000n + BigInt(raw.additionalCapMicroUsd) ||
      BigInt(raw.worstExposureMicroUsd) > 6_800_000n ||
      !raw.launchScope || typeof raw.launchScope !== "object" || Array.isArray(raw.launchScope))
    throw new TypeError("invalid read-only launch check request");
  if (api) {
    let frame;
    try { frame = parseAmuxV22ReadOnlyApiExecutionFrame(raw.apiExecutionFrame); }
    catch { throw new TypeError("invalid read-only API launch check request"); }
    if (!exactKeys(raw.launchScope, API_LAUNCH_SCOPE_KEYS) ||
        raw.launchScope.version !== 1 ||
        !DIGEST.test(raw.launchScope.launcherConfigDigest) ||
        raw.launchScope.apiExecutionFrameDigest !==
          amuxV22ReadOnlyApiExecutionFrameDigest(frame) ||
        frame.provider !== raw.provider || frame.modelId !== raw.modelId ||
        frame.routeId !== raw.routeId ||
        frame.routePolicyDigest !== raw.routePolicyDigest ||
        frame.catalogApprovalId !== raw.catalogApprovalId ||
        frame.catalogVersion !== raw.catalogVersion ||
        frame.pricingVersion !== raw.pricingVersion ||
        frame.maximumCostMicroUsd !== Number(raw.additionalCapMicroUsd))
      throw new TypeError("invalid read-only API launch check request");
  } else if (Object.hasOwn(raw, "apiExecutionFrame")) {
    throw new TypeError("invalid read-only launch check request");
  }
  return raw;
}

/** Canonical operator-owned mapping. Unit names are always derived and never
 * accepted from this file or from a queued request. */
export function parseAmuxV22RecoveryProfiles(raw) {
  if (!exactKeys(raw, "profiles,version") || raw.version !== 1 || !Array.isArray(raw.profiles) ||
      raw.profiles.length < 1 || raw.profiles.length > PROFILE_LIMIT)
    throw new TypeError("invalid recovery profiles");
  const aliases = new Set(); const workers = new Set();
  const profiles = raw.profiles.map((profile, index) => {
    if (!exactKeys(profile, "alias,workerNames") || !MACHINE_ID.test(profile.alias) ||
        !Array.isArray(profile.workerNames) || profile.workerNames.length < 1 ||
        profile.workerNames.length > MEMBER_LIMIT ||
        profile.workerNames.some(name => !MACHINE_ID.test(name)) ||
        new Set(profile.workerNames).size !== profile.workerNames.length)
      throw new TypeError("invalid recovery profiles");
    if (aliases.has(profile.alias) || (index > 0 && raw.profiles[index - 1]?.alias >= profile.alias) ||
        [...profile.workerNames].sort().some((name, at) => name !== profile.workerNames[at]) ||
        profile.workerNames.some(name => workers.has(name))) {
      const error = new TypeError("recovery profile not unique"); error.code = "PROFILE_NOT_UNIQUE"; throw error;
    }
    aliases.add(profile.alias); profile.workerNames.forEach(name => workers.add(name));
    return { alias: profile.alias, workerNames: [...profile.workerNames] };
  });
  const value = { version: 1, profiles };
  return { value, digest: amuxV22RecoveryDigest("worker-profile-config", value) };
}

async function boundedOpenText(path, limit, options = {}) {
  const handle = await (options.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(limit + 1);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink?.() || info.nlink !== 1 || info.size < 1 || info.size > limit)
      throw new Error("file boundary");
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size || bytesRead > limit) throw new Error("file boundary");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { buffer.fill(0); await handle.close(); }
}

async function boundedReadText(path, limit, options = {}) {
  const handle = await (options.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(limit + 1);
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("file boundary");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { buffer.fill(0); await handle.close(); }
}

function parseProcessEnvironment(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 65_536 ||
      !value.endsWith("\0")) throw new Error("process environment boundary");
  const environment = {}; const names = new Set();
  const selected = new Set(Object.values(AMUX_V22_SIDECAR_LAUNCH_ENV));
  for (const entry of value.slice(0, -1).split("\0")) {
    const at = entry.indexOf("=");
    if (at < 1) throw new Error("process environment boundary");
    const name = entry.slice(0, at);
    if (names.has(name)) throw new Error("process environment boundary");
    names.add(name);
    if (selected.has(name)) environment[name] = entry.slice(at + 1);
  }
  return environment;
}

function parseProcessUid(value) {
  if (typeof value !== "string" || value.length > 16_384) throw new Error("process uid boundary");
  const rows = value.split("\n").filter(row => row.startsWith("Uid:\t"));
  if (rows.length !== 1) throw new Error("process uid boundary");
  const values = rows[0].slice(5).trim().split(/\s+/);
  if (values.length !== 4 || values.some(item => !/^[1-9][0-9]{0,9}$/.test(item)) ||
      new Set(values).size !== 1) throw new Error("process uid boundary");
  const uid = Number(values[0]);
  if (!Number.isSafeInteger(uid)) throw new Error("process uid boundary");
  return uid;
}

function environmentFilePaths(value) {
  if (typeof value !== "string" || value.length > 4_096 || /[\0\r\n]/.test(value))
    throw new Error("environment file boundary");
  if (value === "") return [];
  const matches = [...value.matchAll(/(?:^| )([^ ]+) \(ignore_errors=(?:yes|no)\)(?= |$)/g)];
  if (matches.map(match => match[0]).join("") !== value ||
      matches.length > 8) throw new Error("environment file boundary");
  return matches.map(match => match[1]);
}

async function protectedLaunchEnvironmentFiles(value, alias, options = {}) {
  const paths = environmentFilePaths(value);
  const prefix = "/etc/tomverse-amux-v22/";
  for (const path of paths) {
    if (path !== `${prefix}sidecar@${alias}.env` ||
        !await protectedRootPath(path, options, "file")) return false;
    const info = await (options.lstat ?? lstat)(path);
    if ((info.mode & 0o077) !== 0) return false;
  }
  return true;
}

async function readBootId(options = {}) {
  const value = (await boundedReadText("/proc/sys/kernel/random/boot_id", 128, options)).trim();
  if (!BOOT_ID.test(value)) throw new Error("boot identity unverified");
  return value;
}

async function protectedRootPath(path, options = {}, leaf = "any") {
  const stat = options.lstat ?? lstat;
  let current = path;
  for (let depth = 0; depth < 24; depth += 1) {
    const info = await stat(current);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) return false;
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

export async function readAmuxV22RecoveryProfiles(options = {}) {
  const path = options.path ?? AMUX_V22_RECOVERY_PROFILE_PATH;
  if (path !== AMUX_V22_RECOVERY_PROFILE_PATH ||
      !await protectedRootPath(path, options, "file")) throw new Error("profile config unverified");
  const info = await (options.lstat ?? lstat)(path);
  if ((info.mode & 0o777) !== 0o600 || info.size > PROFILE_BYTES) throw new Error("profile config unverified");
  return parseAmuxV22RecoveryProfiles(JSON.parse(await boundedOpenText(path, PROFILE_BYTES, options)));
}

function parseShow(stdout, unit, properties = SHOW_PROPERTIES) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > 16_384) throw new Error("show boundary");
  const rows = stdout.trimEnd().split("\n"); const result = {};
  for (const row of rows) {
    const at = row.indexOf("="); const key = row.slice(0, at);
    if (at < 1 || !properties.includes(key) || Object.hasOwn(result, key)) throw new Error("show invalid");
    result[key] = row.slice(at + 1).replace(/\r$/, "");
  }
  if (Object.keys(result).length !== properties.length || properties.some(key => !Object.hasOwn(result, key)) ||
      result.Id !== unit || result.LoadState !== "loaded") throw new Error("show invalid");
  return result;
}

function validControlGroup(group, unit) {
  const parts = group.split("/");
  return parts.length >= 3 && parts.length <= 8 && parts[0] === "" && parts[1] === "system.slice" &&
    parts.at(-1) === unit && parts.slice(2, -1).every(part =>
      /^(?:[A-Za-z0-9._-]|\\x[0-9a-f]{2})+\.slice$/.test(part));
}

async function rootOwnedUnitConfig(state, unit, options = {}) {
  const fragments = [`/etc/systemd/system/${unit}`,
    "/etc/systemd/system/tomverse-amux-v22-sidecar@.service"];
  if (!fragments.includes(state.FragmentPath)) return false;
  const drops = state.DropInPaths ? state.DropInPaths.split(" ").filter(Boolean) : [];
  if (drops.length > 16 || drops.some(path => ![
    `/etc/systemd/system/${unit}.d/`, "/etc/systemd/system/tomverse-amux-v22-sidecar@.service.d/",
  ].some(prefix => path.startsWith(prefix) && /^[A-Za-z0-9._-]+\.conf$/.test(path.slice(prefix.length))))) return false;
  for (const path of [state.FragmentPath, ...drops])
    if (!await protectedRootPath(path, options, "file")) return false;
  return true;
}

async function showUnit(unit, options = {}) {
  const run = options.run ?? execFileAsync;
  const { stdout } = await run(SYSTEMCTL, ["show", unit,
    `--property=${SHOW_PROPERTIES.join(",")}`, "--no-pager"], {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 2_000,
    maxBuffer: 16_384, windowsHide: true,
  });
  return parseShow(stdout, unit);
}

function fixedReadOnlyExecStart(value) {
  if (typeof value !== "string" || value.length > 4_096 ||
      !value.startsWith("{ ") || !value.endsWith(" }") || /[\r\n]/.test(value)) return false;
  const entries = value.slice(2, -2).split(" ; ");
  const parsed = {};
  for (const entry of entries) {
    const at = entry.indexOf("=");
    if (at < 1 || Object.hasOwn(parsed, entry.slice(0, at))) return false;
    parsed[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return Object.keys(parsed).sort().join(",") ===
      "argv[],code,ignore_errors,path,pid,start_time,status,stop_time" &&
    parsed.path === AMUX_V22_READ_ONLY_EXEC_START[0] &&
    parsed["argv[]"] === AMUX_V22_READ_ONLY_EXEC_START.join(" ") &&
    parsed.ignore_errors === "no" && /^[0-9]+$/.test(parsed.pid) &&
    ["start_time", "stop_time", "code", "status"].every(key =>
      parsed[key].length <= 256 && !/[\0\r\n]/.test(parsed[key]));
}

export async function inspectAmuxV22ReadOnlyLauncher(worker, options = {}) {
  if ((options.platform ?? process.platform) !== "linux" || !MACHINE_ID.test(worker))
    return { current: false };
  let profiles;
  try { profiles = await (options.readProfiles ?? readAmuxV22RecoveryProfiles)(options); }
  catch { return { current: false, failure: "profile_config_mismatch" }; }
  const profile = profiles.value.profiles.find(item => item.workerNames.includes(worker));
  if (!profile) return { current: false, failure: "worker_identity_changed",
    profileConfigDigest: profiles.digest };
  try {
    const unit = targetUnit(profile.alias);
    const run = options.run ?? execFileAsync;
    const { stdout } = await run(SYSTEMCTL, ["show", unit,
      `--property=${LAUNCH_SHOW_PROPERTIES.join(",")}`, "--no-pager"], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 2_000,
      maxBuffer: 16_384, windowsHide: true,
    });
    const state = parseShow(stdout, unit, LAUNCH_SHOW_PROPERTIES);
    const artifact = AMUX_V22_READ_ONLY_EXEC_START[1];
    const artifactInfo = await (options.lstat ?? lstat)(artifact);
    const structurallyCurrent = state.ActiveState === "active" && state.SubState === "running" &&
      INVOCATION_ID.test(state.InvocationID) && /^[1-9][0-9]{0,9}$/.test(state.MainPID) &&
      validControlGroup(state.ControlGroup, unit) && state.Restart === "no" &&
      state.KillMode === "control-group" && state.Delegate === "no" &&
      await rootOwnedUnitConfig(state, unit, options) &&
      await protectedLaunchEnvironmentFiles(state.EnvironmentFiles, profile.alias, options) &&
      fixedReadOnlyExecStart(state.ExecStart) &&
      artifactInfo.size >= 1 && artifactInfo.size <= 16 * 1024 * 1024 &&
      (artifactInfo.mode & 0o777) === 0o555 &&
      await protectedRootPath(artifact, options, "file");
    if (!structurallyCurrent) return { current: false, failure: "launcher_config_mismatch",
      profileConfigDigest: profiles.digest };
    const read = options.readText ?? ((path, limit) => boundedReadText(path, limit, options));
    const environment = parseProcessEnvironment(await read(
      `/proc/${state.MainPID}/environ`, 65_536));
    const uid = parseProcessUid(await read(`/proc/${state.MainPID}/status`, 16_384));
    const config = amuxV22SidecarLaunchConfigFromEnvironment(environment);
    if (config.worker !== worker) return { current: false, failure: "worker_identity_changed",
      profileConfigDigest: profiles.digest };
    const measured = await (options.inspectLauncherConfig ??
      inspectAmuxV22ReadOnlyLauncherConfig)(config, profiles.digest, { ...options, uid });
    const { stdout: finalStdout } = await run(SYSTEMCTL, ["show", unit,
      `--property=${LAUNCH_SHOW_PROPERTIES.join(",")}`, "--no-pager"], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 2_000,
      maxBuffer: 16_384, windowsHide: true,
    });
    const finalState = parseShow(finalStdout, unit, LAUNCH_SHOW_PROPERTIES);
    const finalProfiles = await (options.readProfiles ?? readAmuxV22RecoveryProfiles)(options);
    const finalProfile = finalProfiles.value.profiles.find(item => item.workerNames.includes(worker));
    const current = measured?.current === true && DIGEST.test(measured.launcherConfigDigest) &&
      JSON.stringify(finalState) === JSON.stringify(state) &&
      finalProfiles.digest === profiles.digest && finalProfile?.alias === profile.alias;
    return { current, failure: current ? null : "launcher_config_mismatch",
      profileConfigDigest: profiles.digest,
      ...(current ? { launcherConfigDigest: measured.launcherConfigDigest } : {}) };
  } catch { return { current: false, failure: "launcher_config_mismatch" }; }
}

export async function inspectAmuxV22SafeStopCgroupEmpty(group, unit, options = {}) {
  if (!validControlGroup(group, unit)) return false;
  const list = options.readdir ?? readdir;
  const read = options.readText ?? ((path, limit) => boundedReadText(path, limit, options));
  const root = `/sys/fs/cgroup${group}`;
  try {
    if (!await protectedRootPath(root, options, "directory")) return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return protectedRootPath(dirname(root), options, "directory");
  }
  const queue = [root]; let directories = 0;
  while (queue.length) {
    const path = queue.shift();
    if (++directories > 32) throw new Error("cgroup boundary");
    const text = await read(`${path}/cgroup.procs`, 4_096);
    if (text.trim() !== "") return false;
    const entries = await list(path, { withFileTypes: true });
    if (entries.length > 256) throw new Error("cgroup boundary");
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("cgroup symlink");
      if (entry.isDirectory()) {
        if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) throw new Error("cgroup child invalid");
        queue.push(`${path}/${entry.name}`);
      }
    }
  }
  return true;
}

export async function inspectAmuxV22SafeStopUnit(unit, options = {}) {
  const alias = typeof unit === "string" && unit.startsWith(UNIT_PREFIX) && unit.endsWith(UNIT_SUFFIX)
    ? unit.slice(UNIT_PREFIX.length, -UNIT_SUFFIX.length) : "";
  if ((options.platform ?? process.platform) !== "linux" || unit !== targetUnit(alias) ||
      !MACHINE_ID.test(alias)) throw new Error("fixed unit invalid");
  const state = await showUnit(unit, options);
  return { state, rootOwnedConfig: await rootOwnedUnitConfig(state, unit, options),
    fixedUnit: state.Id === unit,
    controlGroupBound: validControlGroup(state.ControlGroup, unit),
    restartDisabled: state.Restart === "no" && state.KillMode === "control-group" && state.Delegate === "no" };
}

const journalBasis = request => ({ taskId: request.taskId, priorAttemptId: request.priorAttemptId,
  workerProfileAlias: request.workerProfileAlias, targetUnit: request.targetUnit });
const journalEntry = (request, capture) => {
  const journalBindingDigest = amuxV22RecoveryDigest("stop-journal-binding", journalBasis(request));
  const basis = { version: 2, journalBindingDigest, ...journalBasis(request),
    targetHost: request.targetHost, profileConfigDigest: request.profileConfigDigest,
    bootId: capture.bootId, capturedControlGroup: capture.controlGroup,
    capturedInvocationId: capture.invocationId };
  return { ...basis, journalEntryDigest: amuxV22RecoveryDigest("stop-journal-entry", basis) };
};
const JOURNAL_KEYS = ["bootId", "capturedControlGroup", "capturedInvocationId", "journalBindingDigest",
  "journalEntryDigest", "priorAttemptId", "profileConfigDigest", "targetHost", "targetUnit", "taskId",
  "version", "workerProfileAlias"].sort().join(",");
function parseJournal(raw, request, bootId) {
  if (!exactKeys(raw, JOURNAL_KEYS) || raw.version !== 2 || raw.bootId !== bootId ||
      raw.targetHost !== request.targetHost || raw.profileConfigDigest !== request.profileConfigDigest ||
      !validControlGroup(raw.capturedControlGroup, request.targetUnit) ||
      !INVOCATION_ID.test(raw.capturedInvocationId)) throw new Error("journal unverified");
  const expected = journalEntry(request, { bootId, controlGroup: raw.capturedControlGroup,
    invocationId: raw.capturedInvocationId });
  if (Object.keys(expected).some(key => raw[key] !== expected[key])) throw new Error("journal unverified");
  return expected;
}

export async function bindAmuxV22StopIntent(request, capture, options = {}) {
  const bootId = capture?.bootId ?? options.bootId;
  if (!BOOT_ID.test(bootId) || (capture &&
      (!validControlGroup(capture.controlGroup, request.targetUnit) || !INVOCATION_ID.test(capture.invocationId))))
    throw new Error("journal unverified");
  const expected = capture ? journalEntry(request, capture) : null;
  const bindingDigest = amuxV22RecoveryDigest("stop-journal-binding", journalBasis(request));
  const directory = options.directory ?? AMUX_V22_RECOVERY_INTENT_DIR;
  if (directory !== AMUX_V22_RECOVERY_INTENT_DIR ||
      !await protectedRootPath(directory, options, "directory")) throw new Error("journal unverified");
  const directoryInfo = await (options.lstat ?? lstat)(directory);
  if ((directoryInfo.mode & 0o777) !== 0o700) throw new Error("journal unverified");
  const path = posix.join(directory, `${bindingDigest}.json`);
  let handle;
  if (!expected) {
    const info = await (options.lstat ?? lstat)(path).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > JOURNAL_BYTES)
      throw new Error("journal unverified");
    const existing = parseJournal(JSON.parse(await boundedOpenText(path, JOURNAL_BYTES, options)), request, bootId);
    return { entry: existing, disposition: "intent_reused", mayStop: false };
  }
  try {
    handle = await (options.open ?? open)(path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const bytes = Buffer.from(amuxCanonicalJson(expected));
    try {
      if (bytes.length > JOURNAL_BYTES) throw new Error("journal boundary");
      await handle.writeFile(bytes); await handle.sync();
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
          info.size !== bytes.length) throw new Error("journal unverified");
    } finally { bytes.fill(0); await handle.close(); handle = null; }
    const directoryHandle = await (options.open ?? open)(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return { entry: expected, disposition: "intent_recorded", mayStop: true };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code !== "EEXIST") throw new Error("journal unverified");
    const info = await (options.lstat ?? lstat)(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > JOURNAL_BYTES)
      throw new Error("journal unverified");
    const existing = parseJournal(JSON.parse(await boundedOpenText(path, JOURNAL_BYTES, options)), request, bootId);
    return { entry: existing, disposition: "intent_reused", mayStop: false };
  }
}

function reportFor(request, proof, reason) {
  return { inspectionId: request.inspectionId, evidenceId: randomUUID(), requestKind: "safe_stop",
    requestDigest: request.requestDigest, taskId: request.taskId, taskRevision: request.taskRevision,
    priorAttemptId: request.priorAttemptId, priorAttemptTaskRevision: request.priorAttemptTaskRevision,
    workerName: request.workerName, workerInstanceId: request.workerInstanceId,
    workerGeneration: request.workerGeneration, targetHost: request.targetHost,
    sourceEvidenceId: request.sourceEvidenceId, sourceEvidenceDigest: request.sourceEvidenceDigest,
    workerProfileAlias: request.workerProfileAlias, profileWorkerNames: request.profileWorkerNames,
    targetUnit: request.targetUnit, profileConfigDigest: request.profileConfigDigest,
    hostInvocationId: null, modelOutcome: "unknown", stopProof: proof,
    usage: { status: "unknown", projectedCostMicroUsd: null }, reason };
}

/** One request, one durable intent, at most one fixed stop. A reused or unknown
 * intent can only perform read-only show/cgroup verification. */
export async function executeAmuxV22SafeStop(requestValue, options = {}) {
  const request = parseAmuxV22SafeStopRequest(requestValue);
  const journalBindingDigest = amuxV22RecoveryDigest("stop-journal-binding", journalBasis(request));
  let proof = { ...FALSE_PROOF, fixedUnit: true, noOtherWork: true,
    journalBindingDigest };
  let profile;
  try {
    const profiles = await (options.readProfiles ?? readAmuxV22RecoveryProfiles)(options);
    profile = profiles.value.profiles.find(item => item.alias === request.workerProfileAlias);
    proof.rootOwnedConfig = true;
    proof.profileUnique = Boolean(profile) && profiles.digest === request.profileConfigDigest &&
      JSON.stringify(profile.workerNames) === JSON.stringify(request.profileWorkerNames) &&
      profile.workerNames.includes(request.workerName) && request.targetUnit === targetUnit(profile.alias);
  } catch (error) {
    if (error?.code !== "PROFILE_NOT_UNIQUE") return reportFor(request, proof, "safe_stop_config_unverified");
    proof.rootOwnedConfig = true; proof.profileUnique = false;
  }

  const bootReader = options.readBootId ?? readBootId;
  let bootId;
  try { bootId = await bootReader(options); }
  catch { return reportFor(request, proof, "safe_stop_journal_unverified"); }
  if (!BOOT_ID.test(bootId)) return reportFor(request, proof, "safe_stop_journal_unverified");

  let initial;
  try {
    initial = await (options.inspectUnit ?? inspectAmuxV22SafeStopUnit)(request.targetUnit, options);
    proof.fixedUnit = initial.fixedUnit; proof.rootOwnedConfig &&= initial.rootOwnedConfig;
    proof.restartDisabled = initial.restartDisabled;
    if (!proof.fixedUnit || !proof.rootOwnedConfig || !proof.restartDisabled)
      return reportFor(request, proof, "safe_stop_config_unverified");
  } catch { return reportFor(request, proof, "safe_stop_config_unverified"); }
  if (!proof.profileUnique) return reportFor(request, proof, "safe_stop_profile_not_unique");
  const initiallyActive = initial.state.ActiveState === "active";
  const capture = initiallyActive && initial.controlGroupBound &&
      INVOCATION_ID.test(initial.state.InvocationID) && /^[1-9][0-9]{0,9}$/.test(initial.state.MainPID)
    ? { bootId, controlGroup: initial.state.ControlGroup, invocationId: initial.state.InvocationID }
    : null;
  let intent;
  try {
    intent = await (options.bindIntent ?? bindAmuxV22StopIntent)(request, capture, { ...options, bootId });
    const entry = parseJournal(intent.entry, request, bootId);
    const recorded = intent.disposition === "intent_recorded" && intent.mayStop === true;
    const reused = intent.disposition === "intent_reused" && intent.mayStop === false;
    if (!recorded && !reused) throw new Error("journal unverified");
    if (recorded && (!capture || entry.capturedControlGroup !== capture.controlGroup ||
        entry.capturedInvocationId !== capture.invocationId)) throw new Error("journal unverified");
    intent = { ...intent, entry };
    proof.journalBindingDigest = entry.journalBindingDigest;
    proof.journalEntryDigest = entry.journalEntryDigest;
    proof.journalDisposition = intent.disposition;
    proof.journalBound = true;
    if (intent.disposition === "intent_reused") proof.stopAcknowledgement = "outcome_unknown";
  } catch { return reportFor(request, proof, "safe_stop_journal_unverified"); }

  const capturedStateMatches = state => state.Id === request.targetUnit &&
    (!state.InvocationID || state.InvocationID === intent.entry.capturedInvocationId) &&
    (!state.ControlGroup || state.ControlGroup === intent.entry.capturedControlGroup) &&
    (state.ActiveState !== "active" || (state.InvocationID === intent.entry.capturedInvocationId &&
      state.ControlGroup === intent.entry.capturedControlGroup));
  if (!capturedStateMatches(initial.state))
    return reportFor(request, proof, "safe_stop_identity_changed");
  if (intent.mayStop) {
    try {
      await (options.stopUnit ?? (async unit => {
        const run = options.run ?? execFileAsync;
        await run(SYSTEMCTL, ["stop", unit], { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
          // Longer than the fixed unit's 10 s stop limit, so a SIGKILL after that
          // limit is still acknowledged instead of reading as an unknown stop.
          encoding: "utf8", timeout: 12_000, maxBuffer: 4_096, windowsHide: true });
      }))(request.targetUnit);
      proof.stopAcknowledgement = "acknowledged";
    } catch { proof.stopAcknowledgement = "outcome_unknown"; }
  }

  const started = (options.now ?? performance.now.bind(performance))();
  try {
    const inspect = options.inspectUnit ?? inspectAmuxV22SafeStopUnit;
    const after = await inspect(request.targetUnit, options);
    const empty = await (options.cgroupEmpty ?? inspectAmuxV22SafeStopCgroupEmpty)(
      intent.entry.capturedControlGroup, request.targetUnit, options);
    const final = await inspect(request.targetUnit, options);
    const finalBootId = await bootReader(options);
    const elapsed = (options.now ?? performance.now.bind(performance))() - started;
    const identityStable = finalBootId === bootId && after.fixedUnit && final.fixedUnit &&
      capturedStateMatches(after.state) && capturedStateMatches(final.state);
    if (!identityStable) return reportFor(request, proof, "safe_stop_identity_changed");
    proof.rootOwnedConfig &&= after.rootOwnedConfig && final.rootOwnedConfig;
    proof.restartDisabled &&= after.restartDisabled && final.restartDisabled;
    proof.mainPidAbsent = after.state.MainPID === "0" && final.state.MainPID === "0";
    proof.controlGroupEmpty = empty;
    proof.kernelProofFresh = elapsed >= 0 && elapsed <= (options.proofFreshMs ?? 5_000);
    if (!proof.kernelProofFresh)
      return reportFor(request, { ...proof, processState: "unknown" }, "safe_stop_kernel_proof_stale");
    if (!proof.rootOwnedConfig || !proof.restartDisabled)
      return reportFor(request, { ...proof, processState: "unknown" }, "safe_stop_config_unverified");
    // A unit SIGKILLed past its stop limit ends "failed"; with MainPID 0 and an
    // empty control group the kernel still proves the process is gone (v47).
    const stopped = state => state.ActiveState === "inactive" || state.ActiveState === "failed";
    const inactive = stopped(after.state) && stopped(final.state);
    proof.processState = inactive && proof.mainPidAbsent && proof.controlGroupEmpty ? "gone" :
      (!proof.mainPidAbsent || !proof.controlGroupEmpty || after.state.ActiveState === "active" ? "present" : "unknown");
    return reportFor(request, proof, proof.processState === "gone" ? "safe_stop_process_gone" :
      proof.processState === "present" ? "safe_stop_process_present" : "safe_stop_process_unknown");
  } catch { return reportFor(request, { ...proof, processState: "unknown" }, "safe_stop_process_unknown"); }
}

function launchCheckReport(request, observation, launchScope = request.launchScope) {
  return { ...request, launchScope, launchProofId: randomUUID(), observation };
}

const readOnlyLaunchScopeDigest = scope =>
  scope?.executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND
    ? amuxV22ReadOnlyApiLaunchScopeDigest(scope)
    : amuxV22ReadOnlyLaunchScopeDigest(scope);
const launchJournalBasis = report => ({ version: 1,
  launchCheckId: report.launchCheckId, requestDigest: report.requestDigest,
  launchBindingId: report.launchBindingId,
  launchScopeDigest: readOnlyLaunchScopeDigest(report.launchScope),
  launcherConfigDigest: report.launchScope.launcherConfigDigest,
  ...(report.launchScope.executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ? {
    executorKind: report.launchScope.executorKind,
    apiExecutionFrameDigest: report.launchScope.apiExecutionFrameDigest,
  } : {
    launcherPolicyVersion: report.launchScope.launcherPolicyVersion,
    fixedArgvDigest: report.launchScope.fixedArgvDigest,
    toolPolicyDigest: report.launchScope.toolPolicyDigest,
    profileConfigDigest: report.launchScope.profileConfigDigest,
  }) });
const CLI_LAUNCH_JOURNAL_KEYS = ["entryDigest", "fixedArgvDigest", "launchBindingId",
  "launchCheckId", "launchProofId", "launchScopeDigest", "launcherConfigDigest",
  "launcherPolicyVersion", "observation", "profileConfigDigest", "requestDigest",
  "toolPolicyDigest", "version"].sort().join(",");
const API_LAUNCH_JOURNAL_KEYS = ["apiExecutionFrameDigest", "entryDigest", "executorKind",
  "launchBindingId", "launchCheckId", "launchProofId", "launchScopeDigest",
  "launcherConfigDigest", "observation", "requestDigest", "version"].sort().join(",");
function parseLaunchJournal(raw, report) {
  const keys = report.launchScope.executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND
    ? API_LAUNCH_JOURNAL_KEYS : CLI_LAUNCH_JOURNAL_KEYS;
  if (!exactKeys(raw, keys) || raw.version !== 1 ||
      !UUID.test(raw.launchProofId) || !["current", "worker_identity_changed",
        "launcher_config_mismatch", "profile_config_mismatch", "scope_mismatch"]
        .includes(raw.observation)) throw new Error("launch journal unverified");
  const basis = launchJournalBasis(report);
  const expected = { ...basis, launchProofId: raw.launchProofId,
    observation: raw.observation };
  const entryDigest = amuxV22RecoveryDigest("read-only-launch-journal", expected);
  if (Object.keys(basis).some(key => raw[key] !== basis[key]) ||
      raw.entryDigest !== entryDigest) throw new Error("launch journal unverified");
  return { ...expected, entryDigest };
}

/** Durable local identity for an idempotent preflight POST. It records only
 * versioned digests/IDs and the closed observation; no prompt, argv or path. */
export async function bindAmuxV22ReadOnlyLaunchProof(report, options = {}) {
  const basis = launchJournalBasis(report);
  const bindingDigest = amuxV22RecoveryDigest("read-only-launch-journal-binding", {
    launchCheckId: basis.launchCheckId, requestDigest: basis.requestDigest,
    launchBindingId: basis.launchBindingId });
  const entryBasis = { ...basis, launchProofId: report.launchProofId,
    observation: report.observation };
  const expected = { ...entryBasis,
    entryDigest: amuxV22RecoveryDigest("read-only-launch-journal", entryBasis) };
  const directory = options.directory ?? AMUX_V22_RECOVERY_INTENT_DIR;
  if (directory !== AMUX_V22_RECOVERY_INTENT_DIR ||
      !await protectedRootPath(directory, options, "directory"))
    throw new Error("launch journal unverified");
  const directoryInfo = await (options.lstat ?? lstat)(directory);
  if ((directoryInfo.mode & 0o777) !== 0o700)
    throw new Error("launch journal unverified");
  const path = posix.join(directory, `launch-${bindingDigest}.json`);
  let handle;
  try {
    handle = await (options.open ?? open)(path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const bytes = Buffer.from(amuxCanonicalJson(expected));
    try {
      if (bytes.length > LAUNCH_JOURNAL_BYTES) throw new Error("launch journal boundary");
      await handle.writeFile(bytes); await handle.sync();
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 ||
          (info.mode & 0o777) !== 0o600 || info.size !== bytes.length)
        throw new Error("launch journal unverified");
    } finally { bytes.fill(0); await handle.close(); handle = null; }
    const directoryHandle = await (options.open ?? open)(directory,
      constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return report;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code !== "EEXIST") throw new Error("launch journal unverified");
    const info = await (options.lstat ?? lstat)(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > LAUNCH_JOURNAL_BYTES)
      throw new Error("launch journal unverified");
    const existing = parseLaunchJournal(JSON.parse(await boundedOpenText(
      path, LAUNCH_JOURNAL_BYTES, options)), report);
    // A previously-current proof ID may be retried only after another current
    // live inspection. A mismatch is safe to replay but never upgraded.
    if (existing.observation === "current" && report.observation !== "current")
      throw new Error("launch journal stale");
    return { ...report, launchProofId: existing.launchProofId,
      observation: existing.observation };
  }
}

/** Read-only preflight only. It never starts, stops, restarts or invokes a
 * CLI. The app separately binds this observation to a final owner approval. */
export async function executeAmuxV22ReadOnlyLaunchCheck(requestValue, options = {}) {
  const request = parseAmuxV22ReadOnlyLaunchCheckRequest(requestValue);
  const finish = (observation, launchScope) => (options.bindLaunchProof ??
    bindAmuxV22ReadOnlyLaunchProof)(launchCheckReport(request, observation, launchScope), options);
  if (request.launchScope.executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND) {
    let frame;
    try { frame = parseAmuxV22ReadOnlyApiExecutionFrame(request.apiExecutionFrame); }
    catch { return finish("scope_mismatch"); }
    if (!exactKeys(request.launchScope, API_LAUNCH_SCOPE_KEYS) ||
        request.launchScope.apiExecutionFrameDigest !==
          amuxV22ReadOnlyApiExecutionFrameDigest(frame))
      return finish("scope_mismatch");
    const readApiLauncherState = options.readApiLauncherState ??
      (worker => readAmuxV22ReadOnlyApiLauncherState(worker, frame, options));
    const live = await (options.inspectApiLauncher ?? inspectAmuxV22ReadOnlyApiLauncher)(
      request.workerName, frame, { ...options, readApiLauncherState });
    if (live?.current !== true || !DIGEST.test(live.launcherConfigDigest))
      return finish("launcher_config_mismatch");
    const actualScope = amuxV22ReadOnlyApiActualLaunchScope(
      request.launchScope, live.launcherConfigDigest);
    if (!matchAmuxV22ReadOnlyApiLaunchScopes(request.launchScope, actualScope))
      return finish("scope_mismatch");
    return finish("current", actualScope);
  }
  if (!exactKeys(request.launchScope, LAUNCH_SCOPE_KEYS))
    return finish("scope_mismatch");
  let expectedScope;
  try { expectedScope = amuxV22ReadOnlyLaunchScope(request.launchScope); }
  catch { return finish("scope_mismatch"); }
  if (amuxCanonicalJson(request.launchScope) !== amuxCanonicalJson(expectedScope) ||
      request.launchScope.launcherPolicyVersion !== AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION)
    return finish("scope_mismatch");
  const expectedDigests = amuxV22ReadOnlyLauncherDigests(request.launchScope.profileConfigDigest);
  if (["launcherConfigDigest", "fixedArgvDigest", "toolPolicyDigest"]
    .some(key => request.launchScope[key] !== expectedDigests[key]))
    return finish("scope_mismatch");
  const live = await (options.inspectLauncher ?? inspectAmuxV22ReadOnlyLauncher)(
    request.workerName, options);
  if (live?.profileConfigDigest &&
      live.profileConfigDigest !== request.launchScope.profileConfigDigest)
    return finish("profile_config_mismatch");
  if (live?.current !== true) return finish(
    ["worker_identity_changed", "profile_config_mismatch"].includes(live?.failure)
      ? live.failure : "launcher_config_mismatch");
  if (!DIGEST.test(live.launcherConfigDigest)) return finish("launcher_config_mismatch");
  const actualScope = amuxV22ReadOnlyLaunchScope({
    profileConfigDigest: request.launchScope.profileConfigDigest,
    launcherConfigDigest: live.launcherConfigDigest,
  });
  return finish("current", actualScope);
}

async function boundedResponse(response, limit = 16_384) {
  if (!response.ok) throw new Error("controller route refused");
  const reader = response.body?.getReader(); if (!reader) throw new Error("controller body unavailable");
  const parts = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.length; if (bytes > limit) throw new Error("controller body boundary");
      parts.push(item.value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); parts.forEach(part => part.fill(0)); }
}

export async function runAmuxV22RecoveryControllerOnce(config, options = {}) {
  if (config.recoveryEnabled !== "true" || config.safeStopEnabled !== "true") return { state: "disabled" };
  if ((options.platform ?? process.platform) !== "linux" || (options.uid ?? process.getuid?.()) !== 0 ||
      typeof config.controllerSecret !== "string" || config.controllerSecret.length < 32 ||
      /[\r\n]/.test(config.controllerSecret)) return { state: "unavailable" };
  let base;
  try {
    base = new URL(config.internalUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash)
      return { state: "unavailable" };
  } catch { return { state: "unavailable" }; }
  const fetcher = options.fetcher ?? fetch;
  const url = new URL("/api/internal/amux/v22/recovery-controller", base);
  const timeoutSignal = options.timeoutSignal ?? (milliseconds => AbortSignal.timeout(milliseconds));
  const init = () => ({ headers: { Authorization: `Bearer ${config.controllerSecret}` }, cache: "no-store",
    redirect: "error", signal: timeoutSignal(10_000) });
  let request, report;
  try {
    const value = await boundedResponse(await fetcher(url, { ...init(), method: "GET" }));
    if (!exactKeys(value, "requests") || !Array.isArray(value.requests) || value.requests.length > 1)
      throw new Error("controller queue invalid");
    if (!value.requests.length) return { state: "idle" };
    if (options.onlyRequestKind && value.requests[0]?.requestKind !== options.onlyRequestKind)
      return { state: "idle" };
    if (value.requests[0]?.requestKind === "safe_stop") {
      request = parseAmuxV22SafeStopRequest(value.requests[0]);
      report = await executeAmuxV22SafeStop(request, options);
    } else if (value.requests[0]?.requestKind === "read_only_launch_check") {
      request = parseAmuxV22ReadOnlyLaunchCheckRequest(value.requests[0]);
      report = await executeAmuxV22ReadOnlyLaunchCheck(request, options);
    } else throw new Error("controller request kind invalid");
  } catch { return { state: "unavailable" }; }
  try {
    const postInit = init();
    const answer = await boundedResponse(await fetcher(url, { ...postInit, method: "POST",
      headers: { ...postInit.headers, "Content-Type": "application/json" }, body: JSON.stringify(report) }));
    const launchCheck = request.requestKind === "read_only_launch_check";
    const expectedLaunchDigest = launchCheck
      ? amuxV22RecoveryDigest("read-only-launch-proof", report) : null;
    const acknowledged = launchCheck ? exactKeys(answer,
      "launchProofDigest,launchProofId,observation,recorded,retryWrite") &&
        answer.recorded === true && answer.retryWrite === false &&
        answer.launchProofId === report.launchProofId &&
        answer.observation === report.observation &&
        answer.launchProofDigest === expectedLaunchDigest
      : exactKeys(answer,
        "evidenceDigest,evidenceId,reason,recorded,retryWrite,verified") && answer.recorded === true &&
        answer.evidenceId === report.evidenceId && DIGEST.test(answer.evidenceDigest) &&
        typeof answer.verified === "boolean" &&
        ((answer.verified === true && answer.reason === null) ||
          (answer.verified === false && UNVERIFIED_REPORT_REASONS.has(answer.reason))) &&
        answer.retryWrite === false;
    return acknowledged
      ? launchCheck
        ? { state: "reported", launchCheckId: request.launchCheckId,
            launchProofId: report.launchProofId, observation: report.observation }
        : { state: "reported", inspectionId: request.inspectionId, evidenceId: report.evidenceId,
            verified: answer.verified === true }
      : { state: "outcome_unknown" };
  } catch { return { state: "outcome_unknown" }; }
}

/** One timer run (policy v47). After this run reported a verified process-gone
 * proof, read the queue once more and process only the read-only launch check
 * that proof created, so the 90 s approval window is not spent waiting for the
 * next 60 s tick. Never more than two items, never a second safe stop. */
export async function runAmuxV22RecoveryControllerTick(config, options = {}) {
  const first = await runAmuxV22RecoveryControllerOnce(config, options);
  if (first.state !== "reported" || first.verified !== true) return first;
  const followUp = await runAmuxV22RecoveryControllerOnce(config,
    { ...options, onlyRequestKind: "read_only_launch_check" });
  return { ...first, followUp };
}
