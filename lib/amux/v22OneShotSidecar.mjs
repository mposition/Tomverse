import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { get as httpsGet } from "node:https";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { inspectClaudeCliResultUsage } from "./cliUsageObservationCore.ts";
import { amuxCliUsageReceiptDigest, amuxCliUsageReceiptSchema, makeAmuxCliUsageReceipt } from
  "./cliUsageLedgerCore.ts";
import { assertAmuxV22LocalCliTools } from "./v22ExternalAuthorityCore.ts";
import { AMUX_V22_READ_ONLY_RETRY_CAPABILITY, amuxV22ReadOnlyClaudeArgs,
  inspectAmuxV22ReadOnlyLauncherConfig, validateAmuxV22ReadOnlyRetryBinding } from
  "./v22ReadOnlyRetryProtocol.mjs";
import { AMUX_V22_READ_ONLY_API_CAPABILITY,
  AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  parseAmuxV22ReadOnlyApiExecutionReceipt } from "./v22ReadOnlyApiProtocol.mjs";
import { amuxV22ApiModelAccessResult, parseAmuxV22ApiModelAccessRequest,
  parseAmuxV22ApiModelAccessResult } from "./v22ApiModelAccessProtocol.mjs";
import { captureAmuxV22Patch, captureAmuxV22PatchBaseline } from
  "./v22PatchCapture.mjs";
import { amuxV22RecoveryBindingMatches, amuxV22RecoveryEvidenceId,
  parseAmuxV22ReadOnlyRecoveryBinding, parseAmuxV22RecoveryBinding,
  parseAmuxV22RecoveryInspectionRequest,
  readAmuxV22RecoveryJournal } from "./v22RecoveryHost.mjs";

export const AMUX_V22_SIDECAR_CODE_LATCH = true;
export const AMUX_V22_SIDECAR_ENV = "TOMVERSE_AMUX_V22_SIDECAR";
export const AMUX_V22_SIDECAR_DEADLINE_MS = 600_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const RESULT_MEMORY_TTL_MS = 15 * 60_000;
const MAX_BUDGET_MICROUSD = 5_000_000;
const MAX_RECOVERY_TERMINALS = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9._:-]{1,120}$/;
const MODEL = /^claude-[A-Za-z0-9._-]{1,120}$/;
const ROLES = Object.freeze({
  design: "Read,Grep,Glob",
  investigate: "Read,Grep,Glob",
  review: "Read,Grep,Glob",
  implement: "Read,Grep,Glob,Edit,Write",
});

/** Capacity evidence is read from the exact CLI profile owned by this
 * sidecar, not from the native fleet's possibly different login. */
export function normalizeAmuxV22ClaudeQuota(body, observedAt) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now) || !body || typeof body !== "object" || Array.isArray(body)) return null;
  const windows = [];
  if (Object.hasOwn(body, "five_hour") || Object.hasOwn(body, "seven_day")) {
    for (const key of ["five_hour", "seven_day", "seven_day_opus"]) {
      const row = body[key];
      if (key === "seven_day_opus" && row == null) continue;
      // Only an explicit zero/no-reset model window is inactive. A missing
      // or nonzero usage value without a reset is still unknown.
      if (key === "seven_day_opus" && row?.utilization === 0 && row.resets_at === null) continue;
      if (!row || typeof row !== "object" || typeof row.utilization !== "number" ||
          !Number.isFinite(row.utilization) || row.utilization < 0 ||
          typeof row.resets_at !== "string" || !Number.isFinite(Date.parse(row.resets_at)) ||
          Date.parse(row.resets_at) <= now) return null;
      windows.push({ used: row.utilization, reset: Date.parse(row.resets_at) });
    }
  } else if (Array.isArray(body.limits)) {
    if (!body.limits.some(row => row?.kind === "session" || row?.kind === "worker") ||
        !body.limits.some(row => row?.kind === "weekly_all")) return null;
    for (const row of body.limits) {
      if (!["session", "worker", "weekly_all", "weekly_scoped"].includes(row?.kind)) return null;
      if (row.kind === "weekly_scoped" && row.percent === 0 && row.resets_at === null) continue;
      if (typeof row.percent !== "number" || !Number.isFinite(row.percent) || row.percent < 0 ||
          typeof row.resets_at !== "string" || !Number.isFinite(Date.parse(row.resets_at)) ||
          Date.parse(row.resets_at) <= now) return null;
      windows.push({ used: row.percent, reset: Date.parse(row.resets_at) });
    }
  }
  if (!windows.length || windows.length > 12) return null;
  // Never round availability up, combine duplicated shapes, or turn absent
  // observations into a made-up zero/100-percent quota.
  const remaining = Math.floor(Math.max(0, 100 - Math.max(...windows.map(w => w.used))) * 100);
  return { provider: "anthropic", remaining_basis_points: remaining,
    confidence_basis_points: 10_000, exhausted: remaining === 0,
    source: "provider_api", observed_at: observedAt,
    reset_at: new Date(Math.min(...windows.map(w => w.reset))).toISOString() };
}

/** A subscription reading cannot establish API-key/alternate-backend
 * capacity. Refuse profile/project settings that select those auth paths. */
async function quotaProfileUsesOAuth(config, options) {
  const paths = [join(config.claudeConfigDir, "settings.json"),
    join(config.claudeConfigDir, ".claude.json"), `${config.claudeConfigDir}.json`,
    join(config.homePath, ".claude.json"),
    join(config.worktreePath, ".claude", "settings.json"),
    join(config.worktreePath, ".claude", "settings.local.json"),
    "/etc/claude-code/managed-settings.json"];
  const readSettings = options.readSettings ?? (async path => {
    let handle, buffer;
    try {
      handle = await (options.openSettings ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o022) || info.size > 262_144) throw new Error("unsafe settings");
      buffer = Buffer.alloc(262_145);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 262_144) throw new Error("settings limit");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
    } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    finally { buffer?.fill(0); await handle?.close().catch(() => {}); }
  });
  for (const path of paths) {
    const settings = await readSettings(path);
    if (settings === null) continue;
    if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
        ["apiKeyHelper", "primaryApiKey", "apiKey"].some(key => settings[key]) ||
        (settings.env && (typeof settings.env !== "object" || Array.isArray(settings.env)))) return false;
    const overrides = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
    if (overrides.some(key => Object.hasOwn(settings.env ?? {}, key))) return false;
  }
  return true;
}

export async function probeAmuxV22ClaudeQuota(config, options = {}) {
  let bytes, file;
  try {
    if (!NAME.test(config?.worker) || typeof config.claudeConfigDir !== "string" ||
        !isAbsolute(config.claudeConfigDir) || typeof config.worktreePath !== "string" ||
        !isAbsolute(config.worktreePath) || typeof config.homePath !== "string" ||
        !isAbsolute(config.homePath) || !await quotaProfileUsesOAuth(config, options)) return null;
    const path = join(config.claudeConfigDir, ".credentials.json");
    file = await (options.open ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 ||
        info.uid !== (options.uid ?? process.getuid?.()) || info.size > 65_536) return null;
    bytes = Buffer.alloc(65_537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead < 1 || bytesRead > 65_536) return null;
    const auth = JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, bytesRead)))?.claudeAiOauth;
    if (typeof auth?.accessToken !== "string" || auth.accessToken.length < 16 ||
        auth.accessToken.length > 8192 || /[\r\n]/.test(auth.accessToken) ||
        !Number.isFinite(auth.expiresAt) || auth.expiresAt <= Date.now()) return null;
    const request = options.request ?? ((token) => new Promise((resolve, reject) => {
      const req = (options.httpsGet ?? httpsGet)({ hostname: "api.anthropic.com", port: 443, rejectUnauthorized: true,
        path: "/api/oauth/usage", signal: AbortSignal.timeout(3000),
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01" } }, response => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error("quota unavailable")); return; }
        const parts = []; let length = 0;
        response.on("data", part => { length += part.length;
          if (length > 32_768) req.destroy(new Error("quota response limit")); else parts.push(part); });
        response.on("error", reject);
        response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
          catch { reject(new Error("quota unavailable")); } });
      });
      req.on("error", reject);
    }));
    const body = await request(auth.accessToken);
    return normalizeAmuxV22ClaudeQuota(body, new Date().toISOString());
  } catch { return null; }
  finally { bytes?.fill(0); await file?.close().catch(() => {}); }
}

export function amuxV22SidecarEnabled(value) {
  return AMUX_V22_SIDECAR_CODE_LATCH && value === "1";
}

export function parseAmuxV22OneShotRequest(raw, assignedWorker) {
  const fields = raw && typeof raw === "object" ? Object.keys(raw).filter(key =>
    !["readOnlyRetry", "recoveryBinding"].includes(key)).sort().join(",") : "";
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      fields !==
      "attemptId,budgetMicrousd,modelId,prompt,role,version,worker" ||
      raw.version !== 1 || !UUID.test(raw.attemptId) ||
      !NAME.test(raw.worker) || raw.worker !== assignedWorker ||
      !MODEL.test(raw.modelId) || !Object.hasOwn(ROLES, raw.role) ||
      typeof raw.prompt !== "string" || raw.prompt.trim().length === 0 ||
      Buffer.byteLength(raw.prompt, "utf8") > 32 * 1024 ||
      !Number.isSafeInteger(raw.budgetMicrousd) ||
      raw.budgetMicrousd < 1 || raw.budgetMicrousd > MAX_BUDGET_MICROUSD) {
    throw new TypeError("invalid v22 one-shot request");
  }
  if (Object.hasOwn(raw, "recoveryBinding")) {
    if (Object.hasOwn(raw, "readOnlyRetry"))
      parseAmuxV22ReadOnlyRecoveryBinding(raw.recoveryBinding);
    else parseAmuxV22RecoveryBinding(raw.recoveryBinding);
  }
  if (Object.hasOwn(raw, "readOnlyRetry")) {
    const validation = validateAmuxV22ReadOnlyRetryBinding(raw.readOnlyRetry);
    if (!validation.ok || !Object.hasOwn(raw, "recoveryBinding") ||
        raw.recoveryBinding.taskId !== "c48886b9-86f8-4631-8db8-c0b288a707af" ||
        raw.recoveryBinding.attemptId !== raw.attemptId ||
        raw.recoveryBinding.workerName !== raw.worker ||
        raw.recoveryBinding.briefDigest !== raw.readOnlyRetry.briefDigest ||
        raw.role !== "investigate" || raw.modelId !== raw.readOnlyRetry.modelId ||
        raw.budgetMicrousd !== Number(raw.readOnlyRetry.additionalCapMicroUsd))
      throw new TypeError("invalid read-only retry binding");
  }
  return raw;
}

function budgetUsd(microusd) {
  const dollars = Math.floor(microusd / 1_000_000);
  const fraction = String(microusd % 1_000_000).padStart(6, "0");
  return `${dollars}.${fraction}`;
}

export function amuxV22ClaudeArgs(request) {
  if (request.readOnlyRetry) return amuxV22ReadOnlyClaudeArgs(request);
  assertAmuxV22LocalCliTools(ROLES[request.role]);
  return ["-p", "--output-format", "json", "--no-session-persistence",
    "--no-chrome", "--strict-mcp-config", "--restricted",
    "--permission-prompts", "none", "--model", request.modelId,
    "--max-turns", "12", "--max-budget-usd", budgetUsd(request.budgetMicrousd),
    "--tools", ROLES[request.role], "--allowedTools", ROLES[request.role]];
}

function killChildGroup(child) {
  if (!child) return;
  if (!child.pid) { child.kill("SIGKILL"); return; }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { child.kill("SIGKILL"); }
}

const readOnlyRetryEcho = binding => binding ? {
  version: 1,
  launchBindingId: binding.launchBindingId,
  launchProofDigest: binding.launchProofDigest,
  launchScopeDigest: binding.launchScopeDigest,
  ...(binding.executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ? {
    executorKind: binding.executorKind,
    launcherConfigDigest: binding.launcherConfigDigest,
    apiExecutionFrameDigest: binding.apiExecutionFrameDigest,
  } : {}),
} : null;
const readOnlyRetryEchoMatches = (value, binding) => {
  const expected = readOnlyRetryEcho(binding);
  if (!expected) return value === undefined;
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === Object.keys(expected).sort().join(",") &&
    Object.keys(expected).every(key => value[key] === expected[key]);
};

/** API execution never reaches the CLI spawn path. The executor owns the
 * fixed HTTPS adapter and broker; this adapter only binds its terminal output
 * to the existing durable one-shot claim and transient result channel. */
export async function runAmuxV22ReadOnlyApiOneShot(raw, config) {
  const request = parseAmuxV22OneShotRequest(raw, config?.worker);
  if (request.readOnlyRetry?.executorKind !== AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ||
      typeof config?.executor?.execute !== "function" ||
      request.readOnlyRetry.launcherConfigDigest !== config.launcherConfigDigest ||
      request.readOnlyRetry.apiExecutionFrameDigest !== config.apiExecutionFrameDigest ||
      request.readOnlyRetry.apiExecutionFrameDigest !==
        amuxV22ReadOnlyApiExecutionFrameDigest(request.readOnlyRetry.apiExecutionFrame))
    throw new TypeError("invalid read-only API sidecar configuration");
  const echo = readOnlyRetryEcho(request.readOnlyRetry);
  let result;
  try {
    result = await config.executor.execute({
      version: 1,
      capability: AMUX_V22_READ_ONLY_API_CAPABILITY,
      attemptId: request.attemptId,
      invocationId: request.attemptId,
      prompt: request.prompt,
      apiExecutionFrame: request.readOnlyRetry.apiExecutionFrame,
      apiExecutionFrameDigest: request.readOnlyRetry.apiExecutionFrameDigest,
    });
  } catch {
    return { kind: "outcome_unknown", attemptId: request.attemptId,
      failure: "read_only_api_outcome_unknown", readOnlyRetry: echo };
  }
  if (!result || !["succeeded", "failed", "blocked", "outcome_unknown"]
    .includes(result.kind))
    return { kind: "outcome_unknown", attemptId: request.attemptId,
      failure: "read_only_api_outcome_unknown", readOnlyRetry: echo };
  if (result.kind === "blocked") return { kind: "failed", attemptId: request.attemptId,
    failure: result.error ?? "read_only_api_executor_disabled", readOnlyRetry: echo };
  if (result.kind === "outcome_unknown") return { kind: "outcome_unknown",
    attemptId: request.attemptId,
    failure: result.error ?? "read_only_api_outcome_unknown", readOnlyRetry: echo };
  let receipt;
  try {
    receipt = parseAmuxV22ReadOnlyApiExecutionReceipt(result.apiExecutionReceipt,
      request.readOnlyRetry.apiExecutionFrame);
    if (receipt.attemptId !== request.attemptId ||
        receipt.invocationId !== request.attemptId ||
        receipt.terminalStatus !== result.kind ||
        receipt.apiExecutionFrameDigest !==
          amuxV22ReadOnlyApiExecutionFrameDigest(request.readOnlyRetry.apiExecutionFrame))
      throw new TypeError("receipt binding mismatch");
  } catch {
    return { kind: "outcome_unknown", attemptId: request.attemptId,
      failure: "read_only_api_receipt_incomplete", readOnlyRetry: echo };
  }
  const resultText = result.kind === "succeeded" &&
    typeof result.resultText === "string" ? result.resultText : null;
  if (result.kind === "succeeded" && (!resultText || resultText.includes("\0") ||
      Buffer.byteLength(resultText, "utf8") > MAX_RESULT_BYTES))
    return { kind: "outcome_unknown", attemptId: request.attemptId,
      failure: "read_only_api_receipt_incomplete", readOnlyRetry: echo };
  const resultSha256 = resultText
    ? createHash("sha256").update(resultText).digest("hex") : null;
  return { kind: result.kind, attemptId: request.attemptId,
    cliStarted: false, apiExecutionReceipt: receipt, readOnlyRetry: echo,
    resultText, resultSha256 };
}

/** The sidecar owns the binary, checkout and credentials; none of those can
 * be named by the bridge request. Plaintext result is transient and never
 * enters the durable journal. */
export async function runAmuxV22OneShot(raw, config, options = {}) {
  const request = parseAmuxV22OneShotRequest(raw, config?.worker);
  const retryEcho = readOnlyRetryEcho(request.readOnlyRetry);
  const outcome = value => retryEcho ? { ...value, readOnlyRetry: retryEcho } : value;
  if (!config || typeof config.binaryPath !== "string" ||
      !config.binaryPath.startsWith("/") ||
      typeof config.worktreePath !== "string" ||
      !config.worktreePath.startsWith("/") ||
      typeof config.homePath !== "string" ||
      !config.homePath.startsWith("/") ||
      typeof config.claudeConfigDir !== "string" ||
      !config.claudeConfigDir.startsWith("/")) {
    throw new TypeError("invalid sidecar configuration");
  }
  if (process.platform !== "linux" && !options.syntheticPlatform) {
    throw new TypeError("Ubuntu sidecar only");
  }
  if (request.readOnlyRetry) {
    const measured = await (options.inspectReadOnlyLauncherConfig ??
      inspectAmuxV22ReadOnlyLauncherConfig)(config,
      request.readOnlyRetry.profileConfigDigest, options);
    if (measured?.current !== true ||
        measured.launcherConfigDigest !== request.readOnlyRetry.launcherConfigDigest)
      throw new TypeError("invalid read-only retry launcher configuration");
  }

  let child;
  let started = false;
  let timedOut = false;
  let truncated = false;
  let bytes = 0;
  const chunks = [];
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  const spawnChild = options.spawnChild ?? spawn;
  let patchBaseline = null;
  if (request.role === "implement") {
    patchBaseline = options.syntheticPlatform && !options.captureBaseline
      ? { ok: true, baseSha: "a".repeat(40) }
      : await (options.captureBaseline ?? captureAmuxV22PatchBaseline)(
        config.worktreePath);
    if (!patchBaseline.ok) {
      return outcome({ kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: `patch_baseline_${patchBaseline.reason}` });
    }
  }
  try {
    child = spawnChild(config.binaryPath, amuxV22ClaudeArgs(request), {
      cwd: config.worktreePath, detached: true, shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      env: { HOME: config.homePath, PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8", CLAUDE_CONFIG_DIR: config.claudeConfigDir },
    });
    const closed = new Promise((resolve, reject) => {
      child.once("spawn", () => { started = true; });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdout.on("data", (part) => {
      bytes += part.length;
      if (bytes > MAX_OUTPUT_BYTES) { truncated = true; killChildGroup(child); }
      else chunks.push(part);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request.prompt);
    const timer = setTimeout(() => { timedOut = true; killChildGroup(child); },
      options.deadlineMs ?? AMUX_V22_SIDECAR_DEADLINE_MS);
    let exit;
    try { exit = await closed; } finally { clearTimeout(timer); }
    if (!started || timedOut || truncated || exit.signal !== null) {
      return outcome({ kind: "outcome_unknown", attemptId: request.attemptId,
        cliStarted: started, failure: timedOut ? "deadline" :
          truncated ? "output_limit" : "signal" });
    }
    const output = Buffer.concat(chunks);
    try {
      let result;
      try { result = JSON.parse(output.toString("utf8")); }
      catch { return outcome({ kind: "outcome_unknown", attemptId: request.attemptId,
        cliStarted: true, failure: "invalid_result" }); }
      if (result?.type !== "result" || typeof result.subtype !== "string" ||
          typeof result.is_error !== "boolean")
        return outcome({ kind: "outcome_unknown", attemptId: request.attemptId,
          cliStarted: true, failure: "invalid_result" });
      const success = exit.code === 0 && result.subtype === "success" &&
        result.is_error === false;
      let resultText = null;
      let resultSha256 = null;
      if (success && typeof result.result === "string") {
        const body = Buffer.from(result.result, "utf8");
        if (body.length >= 1 && body.length <= MAX_RESULT_BYTES &&
            !result.result.includes("\0")) {
          resultText = result.result;
          resultSha256 = createHash("sha256").update(body).digest("hex");
        }
        body.fill(0);
      }
      const observation = inspectClaudeCliResultUsage(result, {
        exitCode: exit.code, stdoutComplete: true,
        freshPrintInvocation: true,
      });
      let usageReceipt = null;
      try {
        usageReceipt = makeAmuxCliUsageReceipt({
          invocationId: request.attemptId,
          binding: { kind: "task_attempt", attemptId: request.attemptId },
          worker: request.worker, selectedModelId: request.modelId,
          cliVersion: null, authentication: "unknown",
          startedAt, endedAt: new Date().toISOString(),
          status: success ? "succeeded" : "failed", observation,
        });
      } catch { /* An incomplete observation is never promoted to a receipt. */ }
      const patchCandidate = success && patchBaseline
        ? await (options.capturePatch ?? captureAmuxV22Patch)(
          config.worktreePath, patchBaseline.baseSha)
        : null;
      const publishFiles = patchCandidate?.ok &&
        Array.isArray(patchCandidate.publishFiles) &&
        Buffer.byteLength(JSON.stringify({ version: 1,
          text: patchCandidate.patchBody,
          files: patchCandidate.publishFiles }), "utf8") <= 65_536
        ? patchCandidate.publishFiles : null;
      const publishFilesDigest = publishFiles ?
        createHash("sha256").update(JSON.stringify(publishFiles)).digest("hex") : null;
      return outcome({ kind: success ? "succeeded" : "failed",
        attemptId: request.attemptId, cliStarted: true,
        ...(patchBaseline ? { recoveryBaseSha: patchBaseline.baseSha } : {}),
        outputDigest: createHash("sha256").update(output).digest("hex"),
        elapsedMs: Date.now() - start, usageReceipt,
        resultText, resultSha256,
        ...(patchCandidate?.ok ? {
          patchBaseSha: patchCandidate.baseSha,
          patchDigest: patchCandidate.patchDigest,
          patchBody: patchCandidate.patchBody,
          ...(publishFiles ? { publishFiles, publishFilesDigest } : {}),
        } : patchCandidate ? { patchReason: patchCandidate.reason } : {}),
        usageReceiptDigest: usageReceipt ?
          amuxCliUsageReceiptDigest(usageReceipt) : null });
    } finally { output.fill(0); }
  } catch {
    return outcome({ kind: "outcome_unknown", attemptId: request.attemptId,
      cliStarted: started, failure: started ? "child_io" : "spawn" });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      killChildGroup(child);
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Unix-domain transport is for the isolated bridge account only. The unit
 * must provision a parent directory the bridge group can traverse but not
 * modify, plus a dedicated bridge/worker socket group. */
export function createAmuxV22SidecarServer(socketPath, run) {
  if (process.platform !== "linux" || typeof socketPath !== "string" ||
      !socketPath.startsWith("/") || typeof run !== "function")
    throw new TypeError("invalid sidecar socket");
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let bytes = 0;
    const parts = [];
    let handled = false;
    const refuse = () => { socket.end('{"kind":"refused"}\n'); };
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("data", async (part) => {
      if (handled) { socket.destroy(); return; }
      bytes += part.length;
      if (bytes > MAX_REQUEST_BYTES) { handled = true; refuse(); return; }
      parts.push(part);
      const payload = Buffer.concat(parts);
      const newline = payload.indexOf(10);
      if (newline < 0) return;
      handled = true;
      socket.setTimeout(0);
      if (payload.subarray(newline + 1).toString("utf8").trim()) {
        refuse(); return;
      }
      try {
        const result = await run(JSON.parse(payload.subarray(0, newline)
          .toString("utf8")));
        socket.end(`${JSON.stringify(result)}\n`);
      } catch { refuse(); }
      finally {
        for (const item of parts) item.fill(0);
        parts.length = 0;
        payload.fill(0);
      }
    });
  });
  server.maxConnections = 4;
  return {
    async listen() {
      const previousUmask = process.umask(0o117);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject); resolve();
        });
      }).finally(() => process.umask(previousUmask));
      await chmod(socketPath, 0o660);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try { await unlink(socketPath); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    },
  };
}

/** A claim is durable before the CLI starts. A crash after that point can
 * never trigger a second provider call for the same attempt. The sidecar
 * stores no prompt, child stdout, auth or worktree path in this journal. */
export function createAmuxV22SidecarHandler({ worker, stateDir, run, quota,
  protocolCapabilities, modelAccess,
  invocationId = null, recoveryUnit, recoveryWorkspace,
  recoveryJournal = readAmuxV22RecoveryJournal }) {
  if (!NAME.test(worker) || typeof stateDir !== "string" ||
      !isAbsolute(stateDir) || typeof run !== "function")
    throw new TypeError("invalid sidecar handler");
  const active = new Set();
  const volatileResults = new Map();
  const volatilePatches = new Map();
  const terminals = new Map();
  const invocationStartedAt = Date.now();
  const uid = process.getuid?.() ?? 0;
  let busy = false;
  let inspecting = false;
  const file = (attemptId, suffix) => join(stateDir, `${attemptId}.${suffix}`);
  const syncDirectory = async () => {
    if (process.platform !== "linux") return;
    const directory = await open(stateDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const readResult = async (attemptId) => {
    try {
      const value = JSON.parse(await readFile(file(attemptId, "result"), "utf8"));
      if (value?.attemptId !== attemptId)
        return { kind: "outcome_unknown", attemptId };
      const pending = volatileResults.get(attemptId);
      const patch = volatilePatches.get(attemptId);
      return {
        ...value,
        ...(pending && value.resultSha256 === pending.sha256 ?
          { resultText: pending.bytes.toString("utf8") } : {}),
        ...(patch && value.patchDigest === patch.sha256 ?
          { patchBody: patch.bytes.toString("utf8"),
            ...(patch.files ? { publishFiles: patch.files.map((file) => ({
              path: file.path, mode: file.mode,
              bytesBase64: file.bytes.toString("base64"),
            })), publishFilesDigest: patch.filesDigest } : {}) } : {}),
      };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return { kind: "outcome_unknown", attemptId };
    }
  };
  return async (raw) => {
    if (raw?.op === "inspect_recovery") {
      const request = { ...raw }; delete request.op;
      parseAmuxV22RecoveryInspectionRequest(request, worker);
      const proof = { terminalOutcome: "unknown", sameLiveInvocation: false,
        noActiveExecution: false, processTreeStopped: false, rootOwnedUnit: false,
        controlGroupBound: false, journalBound: false, socketTerminal: false,
        externalEffectsKnown: false, workspaceClean: false };
      const evidence = { ...request, evidenceId: amuxV22RecoveryEvidenceId(),
        hostInvocationId: null, proof, usage: { status: "unknown", projectedCostMicroUsd: null },
        reason: "legacy_invocation_unbound" };
      delete evidence.requestedAt;
      if (inspecting) return evidence;
      inspecting = true;
      try {
        proof.noActiveExecution = active.size === 0 && !busy;
        const memo = terminals.get(request.priorAttemptId);
        if (!memo || !/^[a-f0-9]{32}$/.test(invocationId) ||
            !amuxV22RecoveryBindingMatches(memo.binding, request)) return evidence;
        const claim = await recoveryJournal(file(request.priorAttemptId, "claimed"),
          65, uid, invocationStartedAt);
        const text = await recoveryJournal(file(request.priorAttemptId, "result"),
          131_072, uid, invocationStartedAt);
        let result;
        try { result = text ? JSON.parse(text) : null; } catch { return evidence; }
        if (!text || createHash("sha256").update(text).digest("hex") !== memo.terminalDigest ||
            claim?.trim() !== memo.requestDigest || result?.attemptId !== request.priorAttemptId ||
            !["succeeded", "failed", "outcome_unknown"].includes(result.kind) ||
            result.kind !== memo.kind || result.recovery?.invocationId !== invocationId ||
            result.recovery?.requestDigest !== memo.requestDigest ||
            !amuxV22RecoveryBindingMatches(result.recovery?.binding, request)) return evidence;
        proof.terminalOutcome = result.kind === "outcome_unknown" ? "unknown" : result.kind;
        proof.sameLiveInvocation = true; proof.journalBound = true; proof.socketTerminal = true;
        evidence.hostInvocationId = invocationId;
        const workspace = memo.role === "implement" && typeof recoveryWorkspace === "function"
          ? await recoveryWorkspace() : null;
        proof.workspaceClean = memo.role !== "implement" ||
          (workspace?.ok === true && workspace.baseSha === memo.baseSha);
        // The fixed tools have no send/exec capability. Implement additionally
        // proves its original checkout has no leftover modification.
        proof.externalEffectsKnown = Object.hasOwn(ROLES, memo.role) && proof.workspaceClean;
        const unit = typeof recoveryUnit === "function" ? await recoveryUnit() : null;
        for (const key of ["rootOwnedUnit", "controlGroupBound", "processTreeStopped"])
          proof[key] = unit?.[key] === true;
        proof.noActiveExecution = active.size === 0 && !busy;
        if (!proof.noActiveExecution) proof.processTreeStopped = false;
        if (result.kind === "succeeded") evidence.reason = "terminal_success";
        else evidence.reason = Object.entries(proof).filter(([key]) => key !== "terminalOutcome")
          .every(([, value]) => value === true) ? "stopped_proven" : "inspection_unverified";
        const receipt = amuxCliUsageReceiptSchema.safeParse(result.usageReceipt);
        if (receipt.success && receipt.data.completeness === "reported_complete" &&
            receipt.data.binding.kind === "task_attempt" &&
            receipt.data.binding.attemptId === request.priorAttemptId &&
            receipt.data.invocationId === request.priorAttemptId && receipt.data.worker === worker &&
            amuxCliUsageReceiptDigest(receipt.data) === result.usageReceiptDigest) evidence.usage = {
          status: "reported_complete", projectedCostMicroUsd: null };
        return evidence;
      } finally { inspecting = false; }
    }
    if (raw?.op === "quota") {
      if (Object.keys(raw).sort().join(",") !== "op,requestId,worker" ||
          !UUID.test(raw.requestId) || raw.worker !== worker) throw new TypeError("invalid quota request");
      const observation = typeof quota === "function" ? await quota() : null;
      return { kind: observation ? "quota" : "quota_unavailable",
        requestId: raw.requestId, worker, ...(observation ? { observation } : {}) };
    }
    if (raw?.op === "protocol") {
      if (Object.keys(raw).sort().join(",") !== "op,requestId,worker" ||
          !UUID.test(raw.requestId) || raw.worker !== worker)
        throw new TypeError("invalid protocol request");
      const capabilities = typeof protocolCapabilities === "function"
        ? await protocolCapabilities() : [AMUX_V22_READ_ONLY_RETRY_CAPABILITY];
      if (!Array.isArray(capabilities) || capabilities.length > 1 ||
          capabilities.some(value => ![AMUX_V22_READ_ONLY_RETRY_CAPABILITY,
            AMUX_V22_READ_ONLY_API_CAPABILITY].includes(value)))
        throw new TypeError("invalid protocol capabilities");
      return { kind: "protocol", requestId: raw.requestId, worker, capabilities };
    }
    if (raw?.op === "api_model_access") {
      const request = { ...raw };
      delete request.op;
      const parsed = parseAmuxV22ApiModelAccessRequest(request);
      if (parsed.worker !== worker || typeof modelAccess !== "function")
        throw new TypeError("invalid API model access request");
      const requestDigest = createHash("sha256")
        .update("amux-v22-api-model-access-request-v1\n", "utf8")
        .update(JSON.stringify(parsed, Object.keys(parsed).sort()), "utf8")
        .digest("hex");
      const claimPath = file(parsed.requestId, "model-access-claimed");
      const resultPath = file(parsed.requestId, "model-access-result");
      let claimed = false;
      try {
        const handle = await open(claimPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600);
        try { await handle.writeFile(`${requestDigest}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await syncDirectory();
        claimed = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (!claimed) {
        const storedDigest = (await readFile(claimPath, "utf8")).trim();
        if (storedDigest !== requestDigest)
          throw new TypeError("API model access request conflict");
        try {
          const stored = parseAmuxV22ApiModelAccessResult(
            JSON.parse(await readFile(resultPath, "utf8")));
          if (stored.requestId !== parsed.requestId ||
              stored.launchProofDigest !== parsed.launchProofDigest ||
              stored.apiExecutionFrameDigest !== parsed.apiExecutionFrameDigest)
            throw new TypeError("API model access result conflict");
          return stored;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          return amuxV22ApiModelAccessResult(parsed,
            { access: "unknown", reason: "outcome_unknown" });
        }
      }
      let result;
      try { result = parseAmuxV22ApiModelAccessResult(await modelAccess(parsed)); }
      catch { result = amuxV22ApiModelAccessResult(parsed,
        { access: "unknown", reason: "outcome_unknown" }); }
      if (result.requestId !== parsed.requestId ||
          result.launchProofDigest !== parsed.launchProofDigest ||
          result.apiExecutionFrameDigest !== parsed.apiExecutionFrameDigest ||
          result.credentialMetadataDigest !== parsed.credentialMetadataDigest ||
          result.launcherConfigDigest !== parsed.launcherConfigDigest)
        result = amuxV22ApiModelAccessResult(parsed,
          { access: "unknown", reason: "outcome_unknown" });
      const temporary = file(parsed.requestId, "model-access-result.tmp");
      try {
        const handle = await open(temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600);
        try { await handle.writeFile(`${JSON.stringify(result)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, resultPath);
        await syncDirectory();
      } catch {
        try { await unlink(temporary); } catch {}
        return amuxV22ApiModelAccessResult(parsed,
          { access: "unknown", reason: "outcome_unknown" });
      }
      return result;
    }
    const attemptId = raw?.attemptId;
    if (!UUID.test(attemptId)) throw new TypeError("invalid attempt ID");
    if (raw.op === "readback") {
      if (Object.keys(raw).sort().join(",") !== "attemptId,op")
        throw new TypeError("invalid readback");
      if (active.has(attemptId)) return { kind: "in_progress", attemptId };
      const result = await readResult(attemptId);
      if (result) return result;
      try { await readFile(file(attemptId, "claimed")); }
      catch (error) {
        if (error?.code === "ENOENT") return { kind: "not_found", attemptId };
      }
      return { kind: "outcome_unknown", attemptId };
    }
    if (raw.op === "confirm_result") {
      if (Object.keys(raw).sort().join(",") !==
          "attemptId,op,sourceSha256" ||
          !/^[0-9a-f]{64}$/.test(raw.sourceSha256))
        throw new TypeError("invalid result confirmation");
      const stored = await readResult(attemptId);
      if (stored?.resultSha256 !== raw.sourceSha256)
        return { kind: "outcome_unknown", attemptId };
      const pending = volatileResults.get(attemptId);
      if (pending?.sha256 === raw.sourceSha256) {
        clearTimeout(pending.timer);
        pending.bytes.fill(0);
        volatileResults.delete(attemptId);
      }
      return { kind: "confirmed", attemptId };
    }
    if (raw.op === "confirm_patch") {
      if (Object.keys(raw).sort().join(",") !==
          "attemptId,op,patchDigest" ||
          !/^[0-9a-f]{64}$/.test(raw.patchDigest))
        throw new TypeError("invalid patch confirmation");
      const stored = await readResult(attemptId);
      if (stored?.patchDigest !== raw.patchDigest)
        return { kind: "outcome_unknown", attemptId };
      const pending = volatilePatches.get(attemptId);
      if (pending?.sha256 === raw.patchDigest) {
        clearTimeout(pending.timer);
        pending.bytes.fill(0);
        pending.files?.forEach((file) => file.bytes.fill(0));
        volatilePatches.delete(attemptId);
      }
      return { kind: "confirmed", attemptId };
    }
    if (raw.op !== "execute") throw new TypeError("invalid operation");
    const request = { ...raw };
    delete request.op;
    parseAmuxV22OneShotRequest(request, worker);
    if (active.has(attemptId)) return { kind: "in_progress", attemptId };
    if (busy || inspecting) return { kind: "busy", attemptId };
    busy = true;
    try {
      const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const claimPath = file(attemptId, "claimed");
      let claimed = false;
      try {
        const handle = await open(claimPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600);
        try { await handle.writeFile(`${digest}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await syncDirectory();
        claimed = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (!claimed) {
        const storedDigest = (await readFile(claimPath, "utf8")).trim();
        if (storedDigest !== digest) throw new TypeError("attempt payload conflict");
        return (await readResult(attemptId)) ?? {
          kind: "outcome_unknown", attemptId,
        };
      }
      active.add(attemptId);
      void (async () => {
        try {
          let result;
          try { result = await run(request); }
          catch { result = { kind: "outcome_unknown", attemptId }; }
          if (!result || result.attemptId !== attemptId ||
              !["succeeded", "failed", "outcome_unknown"].includes(result.kind) ||
              !readOnlyRetryEchoMatches(result.readOnlyRetry, request.readOnlyRetry))
            result = { kind: "outcome_unknown", attemptId };
          if (request.readOnlyRetry?.executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND &&
              ["succeeded", "failed"].includes(result.kind)) {
            try {
              const receipt = parseAmuxV22ReadOnlyApiExecutionReceipt(
                result.apiExecutionReceipt, request.readOnlyRetry.apiExecutionFrame);
              if (receipt.attemptId !== attemptId || receipt.invocationId !== attemptId ||
                  receipt.terminalStatus !== result.kind)
                throw new TypeError("receipt binding mismatch");
              result.apiExecutionReceipt = receipt;
            } catch {
              result = { kind: "outcome_unknown", attemptId,
                failure: "read_only_api_receipt_incomplete",
                readOnlyRetry: readOnlyRetryEcho(request.readOnlyRetry) };
            }
          }
          const resultText = result.resultText;
          const resultSha256 = result.resultSha256;
          const durable = { ...result };
          // This metadata is produced only by the authenticated fixed execute
          // path and retained in this live handler after a durable terminal.
          const recovery = request.recoveryBinding && /^[a-f0-9]{32}$/.test(invocationId)
            ? { binding: request.recoveryBinding, invocationId, requestDigest: digest } : null;
          if (recovery) durable.recovery = recovery;
          delete durable.resultText;
          delete durable.patchBody;
          delete durable.publishFiles;
          if (typeof resultText === "string" &&
              /^[0-9a-f]{64}$/.test(resultSha256) &&
              Buffer.byteLength(resultText, "utf8") <= MAX_RESULT_BYTES &&
              createHash("sha256").update(resultText).digest("hex") === resultSha256) {
            const bytes = Buffer.from(resultText, "utf8");
            const timer = setTimeout(() => {
              bytes.fill(0);
              volatileResults.delete(attemptId);
            }, RESULT_MEMORY_TTL_MS);
            timer.unref?.();
            volatileResults.set(attemptId, { bytes, sha256: resultSha256, timer });
          } else {
            delete durable.resultSha256;
          }
          if (typeof result.patchBody === "string" &&
              /^[0-9a-f]{40}$/.test(result.patchBaseSha) &&
              /^[0-9a-f]{64}$/.test(result.patchDigest) &&
              Buffer.byteLength(result.patchBody, "utf8") <= 65_536 &&
              createHash("sha256").update(result.patchBody)
                .digest("hex") === result.patchDigest) {
            const bytes = Buffer.from(result.patchBody, "utf8");
            const files = Array.isArray(result.publishFiles) &&
              result.publishFiles.length <= 5 &&
              result.publishFiles.every((file) =>
                typeof file.path === "string" &&
                file.mode === "100644" &&
                typeof file.bytesBase64 === "string") ?
              result.publishFiles.map((file) => ({ path: file.path,
                mode: file.mode,
                bytes: Buffer.from(file.bytesBase64, "base64") })) : null;
            if (!files) delete durable.publishFilesDigest;
            const timer = setTimeout(() => {
              bytes.fill(0);
              files?.forEach((file) => file.bytes.fill(0));
              volatilePatches.delete(attemptId);
            }, RESULT_MEMORY_TTL_MS);
            timer.unref?.();
            volatilePatches.set(attemptId,
              { bytes, files, filesDigest: files ?
                result.publishFilesDigest ?? null : null,
                sha256: result.patchDigest, timer });
          } else {
            delete durable.patchBaseSha;
            delete durable.patchDigest;
            delete durable.publishFilesDigest;
          }
          const resultPath = file(attemptId, "result");
          const temporary = file(attemptId, "result.tmp");
          const handle = await open(temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600);
          const terminalText = JSON.stringify(durable);
          try { await handle.writeFile(terminalText); await handle.sync(); }
          finally { await handle.close(); }
          await rename(temporary, resultPath);
          await syncDirectory();
          if (recovery) terminals.set(attemptId, { binding: request.recoveryBinding,
            requestDigest: digest, kind: durable.kind, role: request.role,
            terminalDigest: createHash("sha256").update(terminalText).digest("hex"),
            baseSha: result.recoveryBaseSha ?? null });
          while (terminals.size > MAX_RECOVERY_TERMINALS) terminals.delete(terminals.keys().next().value);
        } catch { /* The durable claim makes a failed write an unknown result. */ }
        finally { active.delete(attemptId); busy = false; }
      })();
      return { kind: "in_progress", attemptId };
    } finally {
      if (!active.has(attemptId)) busy = false;
    }
  };
}

export async function checkAmuxV22SidecarStateDir(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid())
    throw new TypeError("unsafe sidecar state directory");
}

export async function checkAmuxV22SidecarSocketDir(socketPath) {
  if (typeof socketPath !== "string" || !isAbsolute(socketPath))
    throw new TypeError("invalid sidecar socket path");
  const info = await lstat(dirname(socketPath));
  const mode = info.mode & 0o777;
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (mode !== 0o700 && mode !== 0o750) ||
      info.uid !== process.getuid() || info.gid !== process.getgid())
    throw new TypeError("unsafe sidecar socket directory");
}
