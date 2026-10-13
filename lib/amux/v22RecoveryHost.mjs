import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, posix } from "node:path";
import { promisify } from "node:util";
import { amuxV22RecoveryEvidenceSchema } from "./v22TaskRecoveryCore.ts";

export const AMUX_V22_RECOVERY_CHECKER_ENV = "TOMVERSE_AMUX_V22_RECOVERY_CHECKER";
export const AMUX_V22_RECOVERY_INSPECTOR_SECRET_ENV =
  "TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const INVOCATION = /^[a-f0-9]{32}$/;
const FALSE_UNIT = Object.freeze({ rootOwnedUnit: false, controlGroupBound: false,
  processTreeStopped: false });
const execFileAsync = promisify(execFile);
const REQUEST_KEYS = "inspectionId,priorAttemptId,priorAttemptTaskRevision,requestDigest,requestedAt,targetHost,taskId,taskRevision,workerGeneration,workerInstanceId,workerName";

export function parseAmuxV22RecoveryBinding(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !== "targetHost,taskId,taskRevision,version,workerGeneration,workerInstanceId" ||
      raw.version !== 1 || !ID.test(raw.taskId) || !Number.isSafeInteger(raw.taskRevision) ||
      raw.taskRevision < 0 || raw.taskRevision > 2_147_483_644 ||
      !UUID.test(raw.workerInstanceId) || !Number.isSafeInteger(raw.workerGeneration) ||
      raw.workerGeneration < 1 || raw.workerGeneration > 2_147_483_647 || raw.targetHost !== "amux-ubuntu")
    throw new TypeError("invalid recovery binding");
  return raw;
}
export function parseAmuxV22ReadOnlyRecoveryBinding(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !==
      "attemptId,briefDigest,recoveryApprovalId,targetHost,taskId,taskRevision,version,workerGeneration,workerInstanceId,workerName" ||
      raw.version !== 1 || raw.taskId !== "c48886b9-86f8-4631-8db8-c0b288a707af" ||
      !UUID.test(raw.attemptId) || !UUID.test(raw.recoveryApprovalId) ||
      !DIGEST.test(raw.briefDigest) || !WORKER.test(raw.workerName))
    throw new TypeError("invalid read-only recovery binding");
  parseAmuxV22RecoveryBinding({ version: raw.version, taskId: raw.taskId,
    taskRevision: raw.taskRevision, workerInstanceId: raw.workerInstanceId,
    workerGeneration: raw.workerGeneration, targetHost: raw.targetHost });
  return raw;
}
export function parseAmuxV22RecoveryInspectionRequest(raw, worker) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !== REQUEST_KEYS || !UUID.test(raw.inspectionId) ||
      !UUID.test(raw.priorAttemptId) || !DIGEST.test(raw.requestDigest) ||
      !WORKER.test(raw.workerName) || raw.workerName !== worker ||
      !Number.isSafeInteger(raw.taskRevision) || raw.taskRevision < 0 || raw.taskRevision > 2_147_483_644 ||
      typeof raw.requestedAt !== "string" || !Number.isFinite(Date.parse(raw.requestedAt)))
    throw new TypeError("invalid recovery inspection request");
  parseAmuxV22RecoveryBinding({ version: 1, taskId: raw.taskId, taskRevision: raw.priorAttemptTaskRevision,
    workerInstanceId: raw.workerInstanceId, workerGeneration: raw.workerGeneration,
    targetHost: raw.targetHost });
  return raw;
}
export function amuxV22RecoveryBindingMatches(binding, request) {
  try { parseAmuxV22RecoveryBinding(binding); }
  catch { return false; }
  return binding.taskRevision === request.priorAttemptTaskRevision &&
    ["taskId", "workerInstanceId", "workerGeneration", "targetHost"]
      .every(key => binding[key] === request[key]);
}

/** No symlink, extra hard link, foreign owner, oversized or historical journal
 * is promoted to evidence. This reader never returns a path or file body. */
export async function readAmuxV22RecoveryJournal(path, limit, uid, startedAt, options = {}) {
  let handle, buffer;
  try {
    const before = await (options.stat ?? lstat)(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        before.uid !== uid || (before.mode & 0o777) !== 0o600 || before.size < 1 ||
        before.size > limit || before.ctimeMs < startedAt) return null;
    handle = await (options.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.ctimeMs !== before.ctimeMs ||
        !info.isFile() || info.uid !== uid || info.nlink !== 1 || info.size > limit) return null;
    buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size || bytesRead > limit) return null;
    const after = await handle.stat();
    if (after.ctimeMs !== info.ctimeMs || after.size !== info.size) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } catch { return null; }
  finally { buffer?.fill(0); await handle?.close().catch(() => {}); }
}
async function boundedFile(path, limit = 16_384) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(limit + 1);
  try {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("inspection bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { buffer.fill(0); await file.close(); }
}
async function protectedRootPath(path, stat = lstat) {
  let current = path;
  for (let count = 0; count < 16; count += 1) {
    const info = await stat(current);
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) return false;
    if (current === "/") return true;
    current = dirname(current);
  }
  return false;
}

/** Fixed current service only: show is read-only. The only admitted cgroup
 * population is this live sidecar PID; names/argv/environment are never read.
 * This intentionally has no legacy invocation inference or service control. */
export async function inspectAmuxV22RecoveryUnit(config, options = {}) {
  if ((options.platform ?? process.platform) !== "linux" || !WORKER.test(config.worker) ||
      !INVOCATION.test(config.invocationId)) return { ...FALSE_UNIT };
  const pid = options.pid ?? process.pid;
  const unit = `tomverse-amux-v22-sidecar@${config.worker}.service`;
  const properties = ["InvocationID", "ControlGroup", "MainPID", "KillMode", "Delegate",
    "FragmentPath", "DropInPaths", "ActiveState", "SubState"];
  const run = options.run ?? execFileAsync;
  const read = options.read ?? boundedFile;
  const stat = options.stat ?? lstat;
  const list = options.list ?? readdir;
  const deadline = performance.now() + 4_000;
  const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("unit inspection deadline"); };
  const show = async () => {
    const { stdout } = await run("/usr/bin/systemctl", ["show", unit,
      `--property=${properties.join(",")}`, "--no-pager"], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8",
      timeout: 2_000, maxBuffer: 16_384, windowsHide: true });
    const map = Object.fromEntries(stdout.trim().split("\n").map(line => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (Object.keys(map).length !== properties.length || properties.some(key => !Object.hasOwn(map, key)))
      throw new Error("unit properties unavailable");
    return map;
  };
  try {
    checkDeadline();
    const unitState = await show();
    // Template instances normally have a per-template slice. Admit only
    // system slices ending at this exact root-managed unit, never an input path.
    const groupParts = unitState.ControlGroup.split("/");
    const expectedGroup = unitState.ControlGroup;
    const groupValid = groupParts.length >= 3 && groupParts.length <= 8 &&
      groupParts[0] === "" && groupParts[1] === "system.slice" && groupParts.at(-1) === unit &&
      groupParts.slice(2, -1).every(part => /^(?:[A-Za-z0-9._-]|\\x[0-9a-f]{2})+\.slice$/.test(part));
    const allowedFragments = [`/etc/systemd/system/${unit}`,
      "/etc/systemd/system/tomverse-amux-v22-sidecar@.service"];
    if (!allowedFragments.includes(unitState.FragmentPath) || unitState.KillMode !== "control-group" ||
        unitState.Delegate !== "no" || unitState.ActiveState !== "active" ||
        unitState.SubState !== "running" || unitState.MainPID !== String(pid) ||
        unitState.InvocationID !== config.invocationId || !groupValid)
      return { ...FALSE_UNIT };
    const drops = unitState.DropInPaths ? unitState.DropInPaths.split(" ") : [];
    if (drops.length > 16 || drops.some(path => ![
      `/etc/systemd/system/${unit}.d/`, "/etc/systemd/system/tomverse-amux-v22-sidecar@.service.d/",
    ].some(prefix => path.startsWith(prefix) && /^[A-Za-z0-9._-]+\.conf$/.test(path.slice(prefix.length)))))
      return { ...FALSE_UNIT };
    for (const path of [unitState.FragmentPath, ...drops]) {
      checkDeadline();
      if (!(await stat(path)).isFile()) return { ...FALSE_UNIT };
      if (!await protectedRootPath(path, stat)) return { ...FALSE_UNIT };
    }
    const ownGroup = (await read("/proc/self/cgroup", 4096)).trim();
    if (ownGroup !== `0::${expectedGroup}`) return { rootOwnedUnit: true,
      controlGroupBound: false, processTreeStopped: false };
    const root = `/sys/fs/cgroup${expectedGroup}`;
    if (!await protectedRootPath(root, stat)) return { ...FALSE_UNIT };
    const queue = [root]; const pids = new Set(); let directories = 0;
    while (queue.length) {
      checkDeadline();
      const path = queue.shift();
      if (++directories > 32) throw new Error("cgroup bound");
      const info = await stat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022))
        throw new Error("cgroup not protected");
      const text = await read(`${path}/cgroup.procs`, 4096);
      for (const item of text.trim().split("\n").filter(Boolean)) {
        if (!/^[1-9][0-9]{0,9}$/.test(item)) throw new Error("cgroup pid invalid");
        pids.add(item); if (pids.size > 256) throw new Error("cgroup bound");
      }
      const entries = await list(path, { withFileTypes: true });
      if (entries.length > 256) throw new Error("cgroup bound");
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error("cgroup symlink");
        if (entry.isDirectory()) {
          if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) throw new Error("cgroup child invalid");
          queue.push(`${path}/${entry.name}`);
        }
      }
    }
    const unchanged = JSON.stringify(await show()) === JSON.stringify(unitState);
    checkDeadline();
    return { rootOwnedUnit: unchanged, controlGroupBound: unchanged,
      processTreeStopped: unchanged && pids.size === 1 && pids.has(String(pid)) };
  } catch { return { ...FALSE_UNIT }; }
}

export function readAmuxV22RecoverySocket(socketPath, payload) {
  if (typeof socketPath !== "string" || !posix.isAbsolute(socketPath))
    throw new TypeError("invalid fixed recovery socket");
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); const parts = []; let bytes = 0;
    const timer = setTimeout(() => socket.destroy(new Error("inspection timeout")), 5_000);
    socket.once("connect", () => socket.end(`${JSON.stringify(payload)}\n`));
    socket.on("data", part => { bytes += part.length;
      if (bytes > 8192) socket.destroy(new Error("inspection response bound")); else parts.push(part); });
    socket.once("error", reject);
    socket.once("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
      catch { reject(new Error("inspection response invalid")); } });
    socket.once("close", () => { clearTimeout(timer); parts.forEach(part => part.fill(0)); });
  });
}
async function boundedResponse(response, limit = 8192) {
  if (!response.ok) throw new Error("checker route refused");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("checker body unavailable");
  const parts = []; let count = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      count += item.value.length;
      if (count > limit) throw new Error("checker response bound");
      parts.push(item.value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); parts.forEach(part => part.fill(0)); }
}
export async function runAmuxV22RecoveryCheckerOnce(config, options = {}) {
  if (config.enabled !== "1") return { state: "disabled" };
  if (!WORKER.test(config.workerName)) return { state: "unavailable" };
  const fixedSocketPath = `/run/tomverse-amux-v22-${config.workerName}/task.sock`;
  if (typeof config.socketPath !== "string" || !posix.isAbsolute(config.socketPath) ||
      config.socketPath !== fixedSocketPath || typeof config.syncSecret !== "string" ||
      config.syncSecret.length < 32 || /[\r\n]/.test(config.syncSecret)) return { state: "unavailable" };
  let base;
  try { base = new URL(config.internalUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" ||
        base.search || base.hash) return { state: "unavailable" }; }
  catch { return { state: "unavailable" }; }
  const fetcher = options.fetcher ?? fetch;
  const url = new URL("/api/internal/amux/v22/recovery-inspection", base);
  const timeoutSignal = options.timeoutSignal ?? (milliseconds => AbortSignal.timeout(milliseconds));
  const init = () => ({ headers: { Authorization: `Bearer ${config.syncSecret}` },
    cache: "no-store", redirect: "error", signal: timeoutSignal(10_000) });
  let request, evidence;
  try {
    url.searchParams.set("workerName", config.workerName);
    const value = await boundedResponse(await fetcher(url, { ...init(), method: "GET" }));
    if (!value || Object.keys(value).join(",") !== "requests" || !Array.isArray(value.requests) ||
        value.requests.length > 1) throw new Error("checker queue invalid");
    if (!value.requests.length) return { state: "idle" };
    request = parseAmuxV22RecoveryInspectionRequest(value.requests[0], config.workerName);
    const result = await (options.inspectSocket ?? readAmuxV22RecoverySocket)(
      config.socketPath, { op: "inspect_recovery", ...request });
    // Parse the closed projection; never send a socket response's extra bytes.
    const parsed = amuxV22RecoveryEvidenceSchema.safeParse(result);
    if (!parsed.success) throw new Error("checker evidence invalid");
    evidence = parsed.data;
    for (const key of Object.keys(request).filter(key => key !== "requestedAt"))
      if (evidence[key] !== request[key]) throw new Error("checker evidence binding");
  } catch { return { state: "unavailable" }; }
  try {
    url.search = "";
    const postInit = init();
    const answer = await boundedResponse(await fetcher(url, { ...postInit, method: "POST",
      headers: { ...postInit.headers, "Content-Type": "application/json" },
      body: JSON.stringify(evidence) }));
    return answer?.recorded === true && answer.evidenceId === evidence.evidenceId
      ? { state: "reported", inspectionId: request.inspectionId, evidenceId: evidence.evidenceId }
      : { state: "outcome_unknown" };
  } catch { return { state: "outcome_unknown" }; }
}
export const amuxV22RecoveryEvidenceId = () => randomUUID();
