import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { get as httpsGet } from "node:https";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from
  "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { inspectClaudeCliResultUsage } from "./cliUsageObservationCore.ts";
import { amuxCliUsageReceiptDigest, amuxCliUsageReceiptSchema, makeAmuxCliUsageReceipt } from
  "./cliUsageLedgerCore.ts";
import { assertAmuxV22LocalCliTools } from "./v22ExternalAuthorityCore.ts";
import { amuxV22OneShotRouteSupported, amuxV22ProviderRoleSupported } from
  "./v22WorkerClaimCore.ts";
import { AMUX_V22_CHANNEL_MAX_OUTPUT_BYTES, AmuxV22ChannelAuthRefused,
  amuxV22ChannelArgs, amuxV22ChannelEnv,
  amuxV22ChannelPreflight, amuxV22ChannelStdin, amuxV22OutputShape,
  createAmuxV22ChannelOutputParser, createAmuxV22ChannelRunHome,
  createAmuxV22OutputShapeCollector, parseAmuxV22ChannelOutput } from "./v22ChannelRun.mjs";
import { AMUX_V22_READ_ONLY_RETRY_CAPABILITY, amuxV22ReadOnlyClaudeArgs,
  inspectAmuxV22ReadOnlyLauncherConfig, validateAmuxV22ReadOnlyRetryBinding } from
  "./v22ReadOnlyRetryProtocol.mjs";
import { AMUX_V22_READ_ONLY_API_CAPABILITY,
  AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  parseAmuxV22ReadOnlyApiExecutionReceipt } from "./v22ReadOnlyApiProtocol.mjs";
import { amuxV22ApiModelAccessResult, parseAmuxV22ApiModelAccessRequest,
  parseAmuxV22ApiModelAccessResult } from "./v22ApiModelAccessProtocol.mjs";
import { AMUX_V22_PATCH_MAX_BYTES } from "./v22PatchLimit.ts";
import { captureAmuxV22Patch, captureAmuxV22PatchBaseline,
  captureAmuxV52ChangedPaths, captureAmuxV52ReviewCommit,
  discardAmuxV52AttemptChanges, syncAmuxV22WorktreeBase } from
  "./v22PatchCapture.mjs";
import { AMUX_V22_WORKTREE_TMP, ensureAmuxV22WorktreeDependencies } from
  "./v22WorkerDependencies.mjs";
import { createAmuxV22ShellJail } from "./v22ShellJail.mjs";
import { amuxV22RecoveryBindingMatches, amuxV22RecoveryEvidenceId,
  parseAmuxV22ReadOnlyRecoveryBinding, parseAmuxV22RecoveryBinding,
  parseAmuxV22RecoveryInspectionRequest,
  readAmuxV22RecoveryJournal } from "./v22RecoveryHost.mjs";
import { AMUX_V22_CONTEXT_DIR, AMUX_V22_CONTEXT_FILES, AMUX_V22_PROMPT_MAX_BYTES,
  AMUX_V22_RUN_PROGRESS_POLL_MS,
  AMUX_V22_RUN_STALL_MS, AMUX_V22_TRANSPORT_MAX_BYTES, amuxV22ExtractContextFiles,
  amuxV22FitReportText, amuxV22LocalCliFlowEnabled, amuxV22RoleHasShell } from
  "./v22LocalCliFlowCore.ts";

const execFileAsync = promisify(execFile);

export const AMUX_V22_SIDECAR_CODE_LATCH = true;
export const AMUX_V22_SIDECAR_ENV = "TOMVERSE_AMUX_V22_SIDECAR";
/** The fixed deadline of the earlier flow (TOMVERSE_AMUX_V22_LOCAL_CLI_FLOW=
 * disabled). The local CLI flow has none (v22LocalCliFlowCore.ts). */
export const AMUX_V22_SIDECAR_DEADLINE_MS = 600_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const LEGACY_PROMPT_MAX_BYTES = 32 * 1024;
/** A read role's diff up to this size is shown in its report; a larger one
 * is named by its preserved ref and file, which keep all of it. */
const READ_ROLE_DIFF_INLINE_MAX_BYTES = 4 * 1024 * 1024;
/** One execute request: the prompt and its context files, plus the frame. */
// JSON escaping can at most double the prompt; the bridge uses the same bound.
const FLOW_MAX_REQUEST_BYTES = 2 * AMUX_V22_PROMPT_MAX_BYTES + 64 * 1024;
const RESULT_MEMORY_TTL_MS = 15 * 60_000;
const MAX_RECOVERY_TERMINALS = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9._:-]{1,120}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ROLES = Object.freeze({
  design: "Read,Grep,Glob",
  investigate: "Read,Grep,Glob",
  review: "Read,Grep,Glob",
  // Bash only runs inside the sidecar's jail (v22ShellJail.mjs): no network,
  // the checkout the one writable path. Owner request 2026-11-09.
  implement: "Read,Grep,Glob,Edit,Write,Bash",
});
/** The local CLI flow (owner decision 2026-11-15): every role has the same
 * jailed shell, so a read role can run tests; only implement edits files
 * with the file tools, and a read role's change is reported, never published. */
const LOCAL_CLI_ROLES = Object.freeze({
  design: "Read,Grep,Glob,Bash",
  investigate: "Read,Grep,Glob,Bash",
  review: "Read,Grep,Glob,Bash",
  implement: "Read,Grep,Glob,Edit,Write,Bash",
});
/** The Claude tools a role runs with. */
export function amuxV22RoleTools(role, flow = amuxV22LocalCliFlowEnabled()) {
  return (flow ? LOCAL_CLI_ROLES : ROLES)[role];
}
/** The providers whose shell the sidecar jails (Codex jails its own). */
const JAILED_SHELL_PROVIDERS = new Set(["anthropic", "github-copilot", "antigravity"]);
/** The providers that look `bash` up on PATH, so the jail goes first there. */
const PATH_SHELL_PROVIDERS = new Set(["github-copilot", "antigravity"]);

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
      // An explicit null five-hour window means no session has started, so
      // none of it is used (production 2026-11-06: an idle account answered
      // five_hour: null and every reading was dropped). The weekly window
      // is still required, and an absent key stays unknown.
      if (key === "five_hour" && row === null && Object.hasOwn(body, key)) continue;
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

/** `provider` is the sidecar's own (TOMVERSE_AMUX_V22_PROVIDER); the
 * read-only retry exists for Claude only. The local CLI flow drops the 32 KiB
 * prompt bound; only the transport backstop remains (its context files ride
 * at the prompt's end, amuxV22ExtractContextFiles). */
export function parseAmuxV22OneShotRequest(raw, assignedWorker, provider = "anthropic",
  { flow = amuxV22LocalCliFlowEnabled() } = {}) {
  const fields = raw && typeof raw === "object" ? Object.keys(raw).filter(key =>
    !["readOnlyRetry", "recoveryBinding", "gradeGuard", "executionGrade",
      "baseSha"].includes(key)).sort().join(",") : "";
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      fields !==
      "attemptId,budgetMicrousd,modelId,prompt,role,version,worker" ||
      raw.version !== 1 || !UUID.test(raw.attemptId) ||
      !NAME.test(raw.worker) || raw.worker !== assignedWorker ||
      !amuxV22OneShotRouteSupported(provider, raw.modelId) ||
      !Object.hasOwn(ROLES, raw.role) || !amuxV22ProviderRoleSupported(provider, raw.role) ||
      typeof raw.prompt !== "string" || raw.prompt.trim().length === 0 ||
      Buffer.byteLength(raw.prompt, "utf8") >
        (flow ? AMUX_V22_PROMPT_MAX_BYTES : LEGACY_PROMPT_MAX_BYTES) ||
      !Number.isSafeInteger(raw.budgetMicrousd) ||
      raw.budgetMicrousd < 1) {
    throw new TypeError("invalid v22 one-shot request");
  }
  if (Object.hasOwn(raw, "recoveryBinding")) {
    if (Object.hasOwn(raw, "readOnlyRetry"))
      parseAmuxV22ReadOnlyRecoveryBinding(raw.recoveryBinding);
    else parseAmuxV22RecoveryBinding(raw.recoveryBinding);
  }
  if (Object.hasOwn(raw, "gradeGuard") && raw.gradeGuard !== true)
    throw new TypeError("invalid grade guard");
  // Only an implement attempt has a publication base to build on.
  if (Object.hasOwn(raw, "baseSha") &&
      (typeof raw.baseSha !== "string" || !COMMIT.test(raw.baseSha) ||
        raw.role !== "implement"))
    throw new TypeError("invalid base commit");
  if (raw.gradeGuard === true ?
      !["routine", "advanced", "frontier"].includes(raw.executionGrade) :
      Object.hasOwn(raw, "executionGrade"))
    throw new TypeError("invalid execution grade");
  if (Object.hasOwn(raw, "readOnlyRetry")) {
    const validation = validateAmuxV22ReadOnlyRetryBinding(raw.readOnlyRetry);
    if (!validation.ok || provider !== "anthropic" || !Object.hasOwn(raw, "recoveryBinding") ||
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

export function amuxV22ClaudeArgs(request, { flow = amuxV22LocalCliFlowEnabled() } = {}) {
  if (request.readOnlyRetry) return amuxV22ReadOnlyClaudeArgs(request);
  const tools = amuxV22RoleTools(request.role, flow);
  assertAmuxV22LocalCliTools(tools, { jailedShell: tools.split(",").includes("Bash") });
  // The local CLI flow streams every event (stream-json): the stream is the
  // run's transcript and its progress signal, and its last `result` event is
  // the same object `json` prints. The CLI still keeps no session files in
  // its sign-in profile (--no-session-persistence).
  return ["-p", "--output-format", flow ? "stream-json" : "json",
    ...(flow ? ["--verbose"] : []), "--no-session-persistence",
    "--no-chrome", "--strict-mcp-config", "--restricted",
    "--permission-prompts", "none", "--model", request.modelId,
    // No dollar budget (owner decision 2026-10-25) and no turn limit (owner
    // decision 2026-11-06). The earlier flow ends a run at
    // AMUX_V22_SIDECAR_DEADLINE_MS; the local CLI flow only at a stall, the
    // operator's stop or the safety cap (v22LocalCliFlowCore.ts).
    "--tools", tools, "--allowedTools", tools];
}

/** The last `result` event of a Claude stream (or the one object `json`
 * prints), or null. */
export function amuxV22ClaudeStreamResult(text) {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event && typeof event === "object" && !Array.isArray(event) &&
        event.type === "result") return event;
  }
  return null;
}

/** A transcript file as 1 MiB chunks, never as one buffer. */
export async function* readTranscriptChunks(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ highWaterMark: 1024 * 1024,
      autoClose: false })) yield chunk;
  } finally { await handle.close().catch(() => {}); }
}

/**
 * One pass over a CLI stream given as chunks: its byte count and sha256, a
 * strict UTF-8 reading split into lines for `onLine`, and the stream's event
 * shape for a refusal's journal line. Only the current line is ever held, so
 * a stream of any length is read in bounded memory. A byte sequence that is
 * not UTF-8 marks the stream undecodable (the digest still covers it all).
 */
export async function scanAmuxV22Output(chunks, onLine) {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const shape = createAmuxV22OutputShapeCollector();
  let bytes = 0;
  let pending = "";
  let undecodable = false;
  const emit = (line) => { shape.push(line); onLine(line); };
  const drain = () => {
    let start = 0;
    for (let newline = pending.indexOf("\n"); newline >= 0;
      newline = pending.indexOf("\n", start)) {
      emit(pending.slice(start, newline));
      start = newline + 1;
    }
    pending = pending.slice(start);
  };
  for await (const chunk of chunks) {
    bytes += chunk.length;
    hash.update(chunk);
    if (undecodable) continue;
    try { pending += decoder.decode(chunk, { stream: true }); }
    catch { undecodable = true; pending = ""; continue; }
    drain();
  }
  if (!undecodable) {
    try { pending += decoder.decode(); } catch { undecodable = true; }
    if (!undecodable) { drain(); if (pending) emit(pending); }
  }
  pending = "";
  return { bytes, digest: hash.digest("hex"), undecodable,
    shape: undecodable ? "undecodable" : shape.value() };
}

const git = async (worktreePath, args, { run = execFileAsync, timeout = 120_000,
  env = {}, maxBuffer = 64 * 1024 * 1024 } = {}) =>
  (await run("git", args, { cwd: worktreePath, encoding: "buffer",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", ...env },
    timeout, killSignal: "SIGKILL", maxBuffer,
    windowsHide: true })).stdout;

const PRESERVED_REF = /^[A-Za-z0-9._-]{1,120}$/;

/** `git <args>` with its stdout streamed into a new file (mode 0600) and
 * hashed on the way; nothing of it is held in memory. */
export async function gitOutputToFile(worktreePath, args, filePath,
  { pathEnv = "/usr/bin:/bin", timeout = 600_000 } = {}) {
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT |
    constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  const out = handle.createWriteStream();
  const hash = createHash("sha256");
  let bytes = 0;
  const child = spawn("git", args, { cwd: worktreePath, shell: false, windowsHide: true,
    env: { PATH: pathEnv, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "ignore"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  child.stdout.on("data", (part) => { bytes += part.length; hash.update(part); });
  child.stdout.pipe(out);
  try {
    const [code] = await Promise.all([
      new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }),
      new Promise((resolve, reject) => { out.once("finish", resolve); out.once("error", reject); }),
    ]);
    if (code !== 0) throw new Error("git output unavailable");
  } finally { clearTimeout(timer); }
  return { digest: hash.digest("hex"), bytes };
}

/**
 * Keeps everything a run left in its checkout, whatever its size and kind
 * (tracked edits, new and binary files; ignored files stay out), without
 * touching the working tree or the real index: a throwaway index snapshots
 * the tree into a commit object under `refs/amux-v22-preserved/<name>`,
 * which a later `reset --hard` or `clean` cannot remove. With `patchPath`
 * its binary diff against HEAD is streamed into that file. Independent of
 * the publication patch and its bounds.
 */
export async function preserveAmuxV22WorkingTree(worktreePath, name, { run,
  patchPath = null, pathEnv } = {}) {
  if (!PRESERVED_REF.test(name)) throw new TypeError("invalid preserved ref");
  const status = await git(worktreePath, ["--no-optional-locks", "status",
    "--porcelain=v1", "-z", "--untracked-files=all"], { run, timeout: 60_000 });
  if (status.length === 0) return { ok: true, changed: false };
  const indexName = (await git(worktreePath, ["rev-parse", "--git-path",
    `amux-v22-preserve-${name}.index`], { run })).toString("utf8").trim();
  const index = isAbsolute(indexName) ? indexName : join(worktreePath, indexName);
  const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "amux-v22-sidecar",
    GIT_AUTHOR_EMAIL: "amux-v22-sidecar@localhost", GIT_COMMITTER_NAME: "amux-v22-sidecar",
    GIT_COMMITTER_EMAIL: "amux-v22-sidecar@localhost" };
  try {
    await git(worktreePath, ["read-tree", "HEAD"], { run, env });
    await git(worktreePath, ["add", "-A", "--", "."], { run, env, timeout: 600_000 });
    const tree = (await git(worktreePath, ["write-tree"], { run, env })).toString("ascii").trim();
    const commit = (await git(worktreePath, ["commit-tree", tree, "-p", "HEAD", "-m",
      `amux v22 preserved ${name}`], { run, env })).toString("ascii").trim();
    if (!COMMIT.test(commit)) throw new Error("preserved commit unavailable");
    const ref = `refs/amux-v22-preserved/${name}`;
    await git(worktreePath, ["update-ref", ref, commit], { run });
    // The ref is the preservation. Its binary diff, when a file is asked for,
    // is streamed there (any size, never held in memory); a diff that cannot
    // be written leaves the ref as the record.
    if (!patchPath) return { ok: true, changed: true, ref, commit };
    try {
      const diff = await gitOutputToFile(worktreePath, ["diff", "--binary", "HEAD", commit],
        patchPath, { pathEnv });
      return { ok: true, changed: true, ref, commit, patchPath,
        patchDigest: diff.digest, patchBytes: diff.bytes };
    } catch {
      await writeFile(patchPath, `# The change is preserved in ${ref} (${commit}); its diff ` +
        "could not be written here.\n", { mode: 0o600, flag: constants.O_WRONLY |
        constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW }).catch(() => {});
      return { ok: true, changed: true, ref, commit, patchPath, patchDigest: null };
    }
  } finally { await rm(index, { force: true }).catch(() => {}); }
}

/**
 * The run's context files, written into `.amux/context/` of the checkout
 * after the dependency install (which clears every ignored file) and the
 * clean-baseline check. The directory is listed in the checkout's own
 * .git/info/exclude, so no context file enters a patch or the changed-path
 * inventory, whatever the synced base's .gitignore says.
 */
export async function writeAmuxV22ContextFiles(worktreePath, files, { run } = {}) {
  const parent = join(worktreePath, AMUX_V22_CONTEXT_DIR.split("/")[0]);
  const directory = join(worktreePath, AMUX_V22_CONTEXT_DIR);
  // An earlier run's shell could leave a symlink here; the sidecar, which
  // holds the CLI sign-in, never follows one out of the checkout.
  const refuseLink = async (path, { directory: isDirectory }) => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile()))
        throw new TypeError("unsafe v22 context path");
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  };
  await refuseLink(parent, { directory: true });
  await refuseLink(directory, { directory: true });
  await rm(directory, { recursive: true, force: true });
  if (!files?.length) return { ok: true, written: [] };
  const exclude = (await git(worktreePath, ["rev-parse", "--git-path", "info/exclude"],
    { run })).toString("utf8").trim();
  const excludePath = isAbsolute(exclude) ? exclude : join(worktreePath, exclude);
  await refuseLink(dirname(excludePath), { directory: true });
  await refuseLink(excludePath, { directory: false });
  let current = "";
  try { current = await readFile(excludePath, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const line = `/${AMUX_V22_CONTEXT_DIR.split("/")[0]}/`;
  if (!current.split(/\r?\n/).includes(line)) {
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`,
      { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW });
  }
  await mkdir(directory, { recursive: true, mode: 0o755 });
  for (const file of files)
    await writeFile(join(directory, file.name), file.text,
      { mode: 0o644, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        constants.O_NOFOLLOW });
  return { ok: true, written: files.map((file) => file.name) };
}

/** An implement run resumes on its previous change: applied to the checkout
 * (three-way, so a moved base still merges) before the CLI starts, as a
 * local session would continue from its working tree. */
export async function applyAmuxV22PriorPatch(worktreePath, { run } = {}) {
  const path = join(AMUX_V22_CONTEXT_DIR, AMUX_V22_CONTEXT_FILES.priorPatch);
  try {
    await git(worktreePath, ["apply", "--3way", "--whitespace=nowarn", path], { run });
    // --3way stages what it merged; the run's own changes stay unstaged.
    await git(worktreePath, ["reset", "--quiet"], { run });
    return { applied: true };
  } catch {
    // A conflicted three-way apply leaves markers: the checkout goes back to
    // its clean base and the worker applies the file itself. Excluded context
    // files survive `clean` without -x.
    try {
      await git(worktreePath, ["reset", "--hard", "--quiet", "HEAD"], { run });
      await git(worktreePath, ["clean", "-fd", "--quiet", "--"], { run });
    } catch { /* the baseline check of the next attempt refuses a dirty tree */ }
    return { applied: false };
  }
}

/**
 * The CPU time, in clock ticks, used so far by a process tree: the root, its
 * descendants (by parent pid) and its process group, each counted with the
 * time of the children it has already reaped (utime, stime, cutime, cstime
 * of /proc/<pid>/stat). Any change between two readings is a sign of life.
 * Null where /proc cannot be read or the root is gone (not Linux, a
 * restricted mount), so the stall watch falls back to its other signals.
 */
export async function readAmuxV22ProcessTreeCpuTicks(rootPid, { procRoot = "/proc",
  fs = { readdir, readFile } } = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return null;
  let names;
  try { names = await fs.readdir(procRoot); } catch { return null; }
  const rows = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let text;
    try { text = await fs.readFile(join(procRoot, name, "stat"), "utf8"); }
    catch { continue; }
    // The command name sits in parentheses and may hold spaces or ")"; the
    // numbered fields follow the last ")": state, ppid, pgrp, ... utime (14).
    const close = text.lastIndexOf(")");
    if (close < 0) continue;
    const fields = text.slice(close + 1).trim().split(/\s+/);
    const ticks = [11, 12, 13, 14].reduce((sum, index) => sum + Number(fields[index]), 0);
    const ppid = Number(fields[1]);
    const pgrp = Number(fields[2]);
    if (!Number.isFinite(ticks) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgrp))
      continue;
    rows.set(Number(name), { ppid, pgrp, ticks });
  }
  if (!rows.has(rootPid)) return null;
  const children = new Map();
  for (const [pid, row] of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(pid);
  }
  const queue = [rootPid, ...[...rows].filter(([, row]) => row.pgrp === rootPid)
    .map(([pid]) => pid)];
  const seen = new Set();
  let total = 0;
  while (queue.length > 0) {
    const pid = queue.pop();
    if (seen.has(pid) || !rows.has(pid)) continue;
    seen.add(pid);
    total += rows.get(pid).ticks;
    queue.push(...(children.get(pid) ?? []));
  }
  return total;
}

/** A cheap checkout activity reading for the stall watch: the status digest. */
export async function probeAmuxV22CheckoutActivity(worktreePath, { run, stat = lstat } = {}) {
  const status = await git(worktreePath, ["--no-optional-locks", "status",
    "--porcelain=v1", "-z", "--untracked-files=all"], { run, timeout: 60_000 });
  // The paths and states alone do not move while a run keeps editing a file
  // it already changed, or keeps writing an untracked file: each changed
  // path's modification time and size go into the reading too.
  const hash = createHash("sha256").update(status);
  const entries = status.toString("utf8").split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    // A rename or copy is followed by its source path.
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
    try {
      const info = await stat(join(worktreePath, path));
      hash.update(`\0${path}\0${info.mtimeMs}\0${info.size}`);
    } catch { hash.update(`\0${path}\0absent`); }
  }
  return hash.digest("hex");
}

/**
 * The CLI's environment. An implement run with a jailed shell names the jail
 * the way each CLI was measured to take it (2026-11-09): Claude Code wraps
 * every Bash call in CLAUDE_CODE_SHELL_PREFIX and keeps its own temp files in
 * CLAUDE_CODE_TMPDIR, inside the checkout so the jailed shell can write the
 * cwd file Claude reads back; Copilot looks `bash` up on PATH and SHELL, and
 * Antigravity on PATH only (agy 1.5.4, measured 2026-11-10).
 */
export function amuxV22CliEnv(provider, config, runHome, { worktreeTmp = null,
  shellJail = null } = {}) {
  if (provider === "anthropic") return { HOME: config.homePath, PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8", CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    ...(shellJail ? { CLAUDE_CODE_SHELL_PREFIX: shellJail.prefixPath,
      CLAUDE_CODE_TMPDIR: worktreeTmp } : {}) };
  return { ...amuxV22ChannelEnv(provider, runHome.config, { copilotToken: runHome.copilotToken }),
    ...(worktreeTmp ? { TMPDIR: worktreeTmp } : {}),
    ...(shellJail && PATH_SHELL_PROVIDERS.has(provider) ? {
      PATH: `${shellJail.binPath}:/usr/bin:/bin`, SHELL: `${shellJail.binPath}/bash` } : {}) };
}

/** Claude Code's `subtype` on a result that is not a success, as a closed
 * enum. The CLI's `errors` text is never carried: it can hold user text or a
 * secret. Anything unrecognised is "unknown", which the app never reads as a
 * known cause. */
export function amuxV22ClaudeFailureKind(subtype) {
  return subtype === "error_max_turns" ? "turn_limit" :
    subtype === "error_during_execution" ? "execution_error" :
    subtype === "error_max_budget_usd" ? "budget_limit" : "unknown";
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
    resultText, resultSha256,
    // This fixed HTTPS executor receives no checkout or file tool. It never
    // enters the CLI worktree, so its local changed-path inventory is empty.
    ...(request.gradeGuard === true ? { gradeGuard: true,
      changedPaths: [] } : {}) };
}

/** The sidecar owns the binary, checkout and credentials; none of those can
 * be named by the bridge request. Plaintext result is transient and never
 * enters the durable journal. */
export async function runAmuxV22OneShot(raw, config, options = {}) {
  const provider = config?.provider ?? "anthropic";
  const flowSetting = options.localCliFlow ?? amuxV22LocalCliFlowEnabled();
  const request = parseAmuxV22OneShotRequest(raw, config?.worker, provider,
    { flow: flowSetting });
  // The risk-accepted read-only retry keeps its exact signed launch: its
  // arguments, tools, environment, deadline and output handling.
  const flow = flowSetting && !request.readOnlyRetry;
  // The earlier flow kills a child whose stdout passes this; the local CLI
  // flow keeps the whole stream in the run's transcript file instead, and
  // holds only the transport backstop in memory when there is no file.
  const outputLimit = flow ? AMUX_V22_TRANSPORT_MAX_BYTES :
    provider === "anthropic" ? MAX_OUTPUT_BYTES : AMUX_V22_CHANNEL_MAX_OUTPUT_BYTES;
  const shellRole = amuxV22RoleHasShell(request.role, flow);
  // The delivery's context files ride at the prompt's end; the CLI reads them
  // from the checkout instead. The read-only retry keeps its exact prompt.
  const extracted = flow ?
    amuxV22ExtractContextFiles(request.prompt) : { prompt: request.prompt, files: [] };
  const contextFiles = extracted.files;
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
  /** Why the local CLI flow stopped a still-running child, if it did. */
  let stopReason = null;
  let bytes = 0;
  const chunks = [];
  const notes = [];
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  const spawnChild = options.spawnChild ?? spawn;
  const refused = provider === "anthropic" ? null :
    (options.channelPreflight ?? amuxV22ChannelPreflight)(provider, config);
  if (refused) {
    return outcome({ kind: "failed", attemptId: request.attemptId,
      cliStarted: false, failure: refused });
  }
  let runHome = null;
  if (provider !== "anthropic") {
    try {
      runHome = await (options.createRunHome ?? createAmuxV22ChannelRunHome)(provider, config,
        { role: request.role, readRoleShell: flow });
    } catch (error) {
      return outcome({ kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: error instanceof AmuxV22ChannelAuthRefused ?
          "channel_auth_refused" : "run_home_unavailable" });
    }
  }
  // What an earlier run left in the checkout (a stop, a crash) is preserved
  // before the base sync below drops it. A checkout that cannot be preserved
  // is left untouched and this attempt does not start.
  let leftoverPreserved = null;
  if (flow && !(options.syntheticPlatform && !options.preserveWorkingTree)) {
    let leftover;
    try {
      leftover = await (options.preserveWorkingTree ?? preserveAmuxV22WorkingTree)(
        config.worktreePath, `leftover-${request.attemptId}`);
    } catch { leftover = { ok: false }; }
    if (!leftover?.ok) {
      await runHome?.cleanup().catch(() => {});
      return outcome({ kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: "leftover_preserve_unavailable" });
    }
    if (leftover.changed) leftoverPreserved = { ref: leftover.ref, commit: leftover.commit };
  }
  // Without a pinned publication base the checkout follows develop's head,
  // so every attempt reads current code rather than the tree it was cloned at.
  let syncedBase = null;
  if (!(options.syntheticPlatform && !options.syncBase)) {
    const synced = await (options.syncBase ?? syncAmuxV22WorktreeBase)(
      config.worktreePath, request.baseSha ?? null);
    if (!synced.ok) {
      await runHome?.cleanup().catch(() => {});
      return outcome({ kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: `base_sync_${synced.reason}` });
    }
    syncedBase = synced.baseSha;
  }
  // A role with a shell has no network (Codex's own sandbox, or the jail
  // below for Claude, Copilot and Antigravity), so the sidecar installs the synced base's
  // locked packages before the CLI starts, each time into a checkout cleared
  // of every file an earlier attempt left. A failed install is not a stop;
  // the local CLI flow tells the worker and the result that tests may not run.
  let worktreeTmp = null;
  let dependencies = null;
  if (shellRole && !(options.syntheticPlatform && !options.ensureDependencies)) {
    const deps = await (options.ensureDependencies ?? ensureAmuxV22WorktreeDependencies)(
      config.worktreePath, config.homePath, { localCliFlow: flow });
    if (deps.ok) worktreeTmp = join(config.worktreePath, AMUX_V22_WORKTREE_TMP);
    dependencies = deps.ok ? { ok: true } :
      { ok: false, reason: typeof deps.reason === "string" ? deps.reason : "install_failed" };
    if (flow && !deps.ok)
      notes.push(`The runner could not install this checkout's locked dependencies ` +
        `(${dependencies.reason}); node_modules may be missing, so tests and type checks ` +
        "may not run. Say in your report which checks you could not run.");
  }
  // Claude's, Copilot's and Antigravity's shell runs only in the jail. Without one
  // the run does not start: their shell would otherwise run open.
  let shellJail = null;
  if (shellRole && JAILED_SHELL_PROVIDERS.has(provider)) {
    try {
      shellJail = options.syntheticPlatform && !options.createShellJail
        ? { binPath: "/synthetic/shell/bin", prefixPath: "/synthetic/shell/prefix",
          cleanup: async () => {} }
        : await (options.createShellJail ?? createAmuxV22ShellJail)({
          worktreePath: config.worktreePath,
          tmpPath: join(config.worktreePath, AMUX_V22_WORKTREE_TMP),
          // Outside the checkout and the jail; Copilot's run home is removed
          // after the run, Claude's jail directory by its own cleanup.
          homePath: runHome?.config.homePath ?? config.homePath });
    } catch { shellJail = null; }
    if (!shellJail) {
      await runHome?.cleanup().catch(() => {});
      return outcome({ kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: "shell_jail_unavailable" });
    }
    worktreeTmp = join(config.worktreePath, AMUX_V22_WORKTREE_TMP);
  }
  const cleanupBeforeStart = async () => {
    await shellJail?.cleanup().catch(() => {});
    await runHome?.cleanup().catch(() => {});
  };
  let patchBaseline = null;
  // In the local CLI flow every shell role starts from a recorded clean base:
  // a read role's change is then reported against it, and recovery knows it.
  if (request.role === "implement" || request.gradeGuard === true ||
      (flow && shellRole)) {
    patchBaseline = options.syntheticPlatform && !options.captureBaseline
      ? { ok: true, baseSha: "a".repeat(40) }
      : await (options.captureBaseline ?? captureAmuxV22PatchBaseline)(
        config.worktreePath, { guardIgnoredContract: request.gradeGuard === true });
    if (!patchBaseline.ok) {
      await cleanupBeforeStart();
      return outcome({ kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: `patch_baseline_${patchBaseline.reason}` });
    }
    if (syncedBase !== null && !options.syntheticPlatform &&
        patchBaseline.baseSha !== syncedBase) {
      await cleanupBeforeStart();
      return outcome({ kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: "base_sync_moved" });
    }
  }
  // Checked again on the tree the CLI will run in: the base sync above may
  // have checked out a commit that brings the CLI's project configuration
  // (independent review of #3694). The first check only spares the work.
  const refusedNow = provider === "anthropic" ? null :
    (options.channelPreflight ?? amuxV22ChannelPreflight)(provider, config);
  if (refusedNow) {
    await cleanupBeforeStart();
    return outcome({ kind: "failed", attemptId: request.attemptId,
      cliStarted: false, failure: refusedNow });
  }
  // The local CLI flow hands the brief and its companions over as files in
  // the checkout, and resumes an implement run on its previous change.
  if (flow && !(options.syntheticPlatform && !options.writeContextFiles)) {
    let written;
    try {
      written = await (options.writeContextFiles ?? writeAmuxV22ContextFiles)(
        config.worktreePath, contextFiles);
    } catch { written = { ok: false }; }
    if (!written?.ok) {
      await cleanupBeforeStart();
      return outcome({ kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: "context_files_unavailable" });
    }
  }
  if (flow && request.role === "implement" &&
      contextFiles.some((file) => file.name === AMUX_V22_CONTEXT_FILES.priorPatch) &&
      !(options.syntheticPlatform && !options.applyPriorPatch)) {
    const applied = await (options.applyPriorPatch ?? applyAmuxV22PriorPatch)(config.worktreePath)
      .catch(() => ({ applied: false }));
    notes.push(applied?.applied ?
      `Your previous run's change (${AMUX_V22_CONTEXT_DIR}/${AMUX_V22_CONTEXT_FILES.priorPatch}) ` +
        "is already applied to your checkout. Continue from it." :
      `Your previous run's change (${AMUX_V22_CONTEXT_DIR}/${AMUX_V22_CONTEXT_FILES.priorPatch}) ` +
        "did not apply cleanly to this base. Apply it with `git apply --3way` and resolve what conflicts.");
  }
  const prompt = notes.length === 0 ? extracted.prompt :
    `${extracted.prompt}\n\nNotes from the runner:\n${notes.map((note) => `- ${note}`).join("\n")}`;
  // Whatever ends a local CLI flow run, the checkout's change is kept: it
  // stays in place (the next attempt's base sync is what clears it) and is
  // copied to the attempt's preserved patch in the sidecar's own state
  // directory (outside the checkout, mode 0600). Never discarded.
  // The preserved diff is streamed into the attempt's patch file by the
  // preservation itself; it is never held here, whatever its size.
  const preserveTree = (name, patchPath = options.preservedPatchPath ?? null) =>
    (options.preserveWorkingTree ?? preserveAmuxV22WorkingTree)(config.worktreePath, name,
      { patchPath });
  const preserveChanges = async () => {
    if (!flow || !patchBaseline?.ok ||
        (options.syntheticPlatform && !options.preserveWorkingTree)) return null;
    try {
      const kept = await preserveTree(request.attemptId);
      if (!kept?.ok) return { reason: "preserve_failed" };
      if (!kept.changed) return { changed: false };
      const changed = options.syntheticPlatform && !options.captureChangedPaths ? null :
        await (options.captureChangedPaths ?? captureAmuxV52ChangedPaths)(
          config.worktreePath, patchBaseline.baseSha).catch(() => null);
      return { ...kept, ...(changed?.ok ? { changedPaths: changed.files } : {}) };
    } catch { return { reason: "preserve_failed" }; }
  };
  // Journal-safe: the preserved ref, its commit, repository paths and a
  // digest, never the patch text.
  const preservedSummary = (preserved) => preserved.reason ? { reason: preserved.reason } :
    !preserved.changed ? { changed: false } :
    { changed: true, ref: preserved.ref, commit: preserved.commit,
      ...(preserved.changedPaths ? { changedPaths: preserved.changedPaths } : {}),
      ...(typeof preserved.patchDigest === "string" ?
        { patchDigest: preserved.patchDigest, patchBytes: preserved.patchBytes } : {}) };
  // The local CLI flow keeps the whole stream in the attempt's transcript.
  let transcript = null;
  if (flow && options.transcriptPath) {
    try {
      const handle = await open(options.transcriptPath, constants.O_WRONLY |
        constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      transcript = handle.createWriteStream();
      // A failed write (a full disk) must not crash the sidecar; the run
      // stops, since its output is no longer whole.
      transcript.on("error", () => {
        if (stopReason === null) stopReason = "transcript_write_failed";
        killChildGroup(child);
      });
    } catch {
      await cleanupBeforeStart();
      return outcome({ kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: "transcript_unavailable" });
    }
  }
  const timers = [];
  try {
    child = spawnChild(config.binaryPath, provider === "anthropic" ?
      amuxV22ClaudeArgs(request, { flow }) :
      amuxV22ChannelArgs(provider, request, config.worktreePath, { readRoleShell: flow }), {
      cwd: config.worktreePath, detached: true, shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      env: amuxV22CliEnv(provider, config, runHome, { worktreeTmp, shellJail }),
    });
    const closed = new Promise((resolve, reject) => {
      child.once("spawn", () => { started = true; });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdout.on("data", (part) => {
      bytes += part.length;
      // A slow disk pauses the child's stdout rather than letting writes pile
      // up in memory.
      if (transcript) {
        if (!transcript.write(part)) {
          child.stdout.pause();
          transcript.once("drain", () => child.stdout.resume());
        }
        return;
      }
      if (bytes > outputLimit) { truncated = true; killChildGroup(child); }
      else chunks.push(part);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(provider === "anthropic" ? prompt :
      amuxV22ChannelStdin(provider, prompt));
    if (flow) {
      // No time limit: a run ends by itself, at the operator's stop, or when
      // it shows no sign of life for the stall window. A sign of life is new
      // output, a checkout change, or CPU time used by the CLI's process tree
      // (children included), so a quiet test or build that is working goes on.
      // Where /proc cannot be read the first two signals decide.
      const stopRun = (reason) => {
        if (stopReason !== null) return;
        stopReason = reason;
        killChildGroup(child);
      };
      const probe = options.probeActivity ?? (options.syntheticPlatform ? null :
        () => probeAmuxV22CheckoutActivity(config.worktreePath));
      const probeCpu = options.probeCpu ?? (Number.isSafeInteger(child.pid) ?
        () => readAmuxV22ProcessTreeCpuTicks(child.pid) : null);
      const stallMs = options.stallMs ?? AMUX_V22_RUN_STALL_MS;
      let seenBytes = 0;
      let seenActivity = null;
      let seenCpu = null;
      let lastProgress = Date.now();
      let probing = false;
      const changed = (now, seen) => now !== null && seen !== null && now !== seen;
      timers.push(setInterval(async () => {
        if (probing || stopReason !== null) return;
        probing = true;
        try {
          let progressed = bytes !== seenBytes;
          seenBytes = bytes;
          if (probeCpu) {
            const cpu = await Promise.resolve().then(probeCpu).catch(() => null);
            if (changed(cpu, seenCpu)) progressed = true;
            if (cpu !== null) seenCpu = cpu;
          }
          if (probe) {
            const activity = await probe().catch(() => null);
            if (changed(activity, seenActivity)) progressed = true;
            if (activity !== null) seenActivity = activity;
          }
          if (progressed) lastProgress = Date.now();
          else if (Date.now() - lastProgress >= stallMs) stopRun("stalled");
        } finally { probing = false; }
      }, options.progressPollMs ?? AMUX_V22_RUN_PROGRESS_POLL_MS));
      if (options.signal?.aborted) stopRun("operator_stop");
      else options.signal?.addEventListener("abort", () => stopRun("operator_stop"),
        { once: true });
    } else {
      timers.push(setTimeout(() => { timedOut = true; killChildGroup(child); },
        options.deadlineMs ?? AMUX_V22_SIDECAR_DEADLINE_MS));
    }
    let exit;
    try { exit = await closed; } finally {
      for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
      if (transcript) await new Promise((resolve) => transcript.end(resolve));
    }
    if (!started || timedOut || truncated || stopReason !== null || exit.signal !== null) {
      const preserved = started ? await preserveChanges() : null;
      return outcome({ kind: "outcome_unknown", attemptId: request.attemptId,
        cliStarted: started, failure: stopReason ?? (timedOut ? "deadline" :
          truncated ? "output_limit" : "signal"),
        ...(dependencies ? { dependencies } : {}),
        ...(preserved ? { preserved: preservedSummary(preserved) } : {}),
        ...(leftoverPreserved ? { leftoverPreserved } : {}) });
    }
    // The local CLI flow reads the stream line by line (from its transcript
    // file, or the in-memory copy when there is none): the digest, the shape
    // and the final result are taken in one pass and the whole stream is
    // never held, so no run's result is lost to its size.
    let scanned = null;
    let channelParser = null;
    let claudeResult = null;
    if (flow) {
      if (provider !== "anthropic")
        channelParser = createAmuxV22ChannelOutputParser(provider,
          { role: request.role, readRoleShell: flow });
      scanned = await scanAmuxV22Output(transcript ?
        readTranscriptChunks(options.transcriptPath) : [Buffer.concat(chunks)],
      (line) => {
        if (channelParser) { channelParser.push(line); return; }
        if (!line.includes('"result"')) return;
        try {
          const event = JSON.parse(line);
          if (event && typeof event === "object" && !Array.isArray(event) &&
              event.type === "result") claudeResult = event;
        } catch { /* not the result line */ }
      });
    }
    const output = flow ? null : Buffer.concat(chunks);
    // An unreadable stream is dropped with the run; one journal line keeps
    // why and the stream's event names (no text), so the cause is visible.
    const invalidResult = (reason) => {
      let shape = "undecodable";
      if (scanned) shape = scanned.shape;
      else {
        try { shape = amuxV22OutputShape(new TextDecoder("utf-8", { fatal: true }).decode(output)); }
        catch { /* "undecodable" */ }
      }
      try {
        (options.logInvalidOutput ?? ((line) => process.stderr.write(`${line}\n`)))(
          `amux v22 invalid_result attempt=${request.attemptId} provider=${provider} ` +
          `exit=${exit.code} bytes=${scanned ? scanned.bytes : output.length} ` +
          `reason=${reason} shape=${shape}`);
      } catch { /* logging never changes the outcome */ }
      return outcome({ kind: "outcome_unknown", attemptId: request.attemptId,
        cliStarted: true, failure: "invalid_result" });
    };
    try {
      let success;
      let answer;
      let observation;
      let cliFailure;
      if (provider === "anthropic") {
        let result;
        if (flow) {
          if (scanned.undecodable) return invalidResult("undecodable");
          result = claudeResult;
          if (!result) return invalidResult("non_json");
        } else {
          try { result = JSON.parse(output.toString("utf8")); }
          catch { return invalidResult("non_json"); }
        }
        if (result?.type !== "result" || typeof result.subtype !== "string" ||
            typeof result.is_error !== "boolean")
          return invalidResult("result_shape");
        success = exit.code === 0 && result.subtype === "success" &&
          result.is_error === false;
        // Only a normal exit with a valid result reaches here; a signal,
        // deadline, output limit or unparsable result stayed outcome_unknown.
        if (!success) cliFailure = amuxV22ClaudeFailureKind(result.subtype);
        answer = result.result;
        observation = inspectClaudeCliResultUsage(result, {
          exitCode: exit.code, stdoutComplete: true,
          freshPrintInvocation: true,
        });
      } else {
        let parsed;
        if (flow) {
          parsed = scanned.undecodable ? { valid: false, reason: "undecodable" } :
            channelParser.finish({ exitCode: exit.code });
        } else {
          try {
            parsed = parseAmuxV22ChannelOutput(provider,
              new TextDecoder("utf-8", { fatal: true }).decode(output),
              { exitCode: exit.code, role: request.role, readRoleShell: flow });
          } catch { parsed = { valid: false, reason: "undecodable" }; }
        }
        if (!parsed.valid) return invalidResult(parsed.reason ?? "unknown");
        ({ success, resultText: answer, observation } = parsed);
      }
      // The local CLI flow never drops a report for its size: one over the
      // transport backstop keeps its start and its end (the conclusion and an
      // owner question sit on the last lines), and the whole of it stays in
      // the run's transcript.
      let report = success && typeof answer === "string" ?
        (flow ? amuxV22FitReportText(answer) : answer) : null;
      let usageReceipt = null;
      try {
        usageReceipt = makeAmuxCliUsageReceipt({
          invocationId: request.attemptId,
          binding: { kind: "task_attempt", attemptId: request.attemptId },
          worker: request.worker, selectedModelId: request.modelId,
          cliVersion: null, authentication: "unknown",
          startedAt, endedAt: new Date().toISOString(),
          status: success ? "succeeded" : "failed", observation,
          ...(cliFailure ? { cliFailure } : {}),
        });
      } catch { /* An incomplete observation is never promoted to a receipt. */ }
      let changedPaths;
      let patchCandidate;
      let readRoleChanges = null;
      let preserved = null;
      if (!flow) {
        // The earlier flow: a read role's or a lower grade's contract change
        // is discarded and the Task re-runs at frontier.
        changedPaths = request.gradeGuard === true
          ? await (options.captureChangedPaths ?? captureAmuxV52ChangedPaths)(
            config.worktreePath, patchBaseline.baseSha)
          : null;
        if (changedPaths?.ok && changedPaths.files.length > 0 &&
            (request.role !== "implement" ||
              changedPaths.contractPaths.length > 0 &&
                request.executionGrade !== "frontier")) {
          const discarded = await (options.discardAttemptChanges ??
            discardAmuxV52AttemptChanges)(config.worktreePath,
            patchBaseline.baseSha);
          if (!discarded) changedPaths = { ok: false,
            reason: "contract_change_discard_unavailable" };
        }
        patchCandidate = success && request.role === "implement" &&
          (!changedPaths || changedPaths.ok &&
            (changedPaths.contractPaths.length === 0 ||
              request.executionGrade === "frontier"))
          ? await (options.capturePatch ?? captureAmuxV22Patch)(
            config.worktreePath, patchBaseline.baseSha,
            { allowUntracked: request.gradeGuard === true })
          : null;
      } else {
        // The local CLI flow never discards a change. A read role's change
        // goes into its report and the attempt's preserved patch, and only
        // then is the checkout put back on its base. An implement change is
        // always the patch candidate: one a lower grade made on a contract
        // path is judged at frontier in place (review commit below, then the
        // independent review and a person), not thrown away and re-run.
        const inventory = request.gradeGuard === true ||
          (request.role !== "implement" &&
            !(options.syntheticPlatform && !options.captureChangedPaths));
        changedPaths = inventory && patchBaseline?.ok ?
          await (options.captureChangedPaths ?? captureAmuxV52ChangedPaths)(
            config.worktreePath, patchBaseline.baseSha) : null;
        if (request.role !== "implement" && changedPaths?.ok &&
            changedPaths.files.length > 0) {
          // Preserved whole (any size, binary and new files) before the
          // checkout is restored; a change that cannot be kept stays in place.
          const kept = options.syntheticPlatform && !options.preserveWorkingTree ? null :
            await preserveTree(request.attemptId).catch(() => null);
          let restored = false;
          if (kept?.ok && kept.changed)
            restored = await (options.discardAttemptChanges ?? discardAmuxV52AttemptChanges)(
              config.worktreePath, patchBaseline.baseSha).catch(() => false) === true;
          readRoleChanges = { files: changedPaths.files, kept, restored };
          // The diff goes into the report when it is of reading size; a larger
          // one is named by its ref and file, which keep all of it.
          const inline = kept?.patchPath && typeof kept.patchDigest === "string" &&
            kept.patchBytes <= READ_ROLE_DIFF_INLINE_MAX_BYTES ?
            await readFile(kept.patchPath, "utf8").catch(() => null) : null;
          if (report !== null) report = amuxV22FitReportText([
            "Note from the runner: this read-only run left changes in its checkout. " +
              "They are not published" + (restored ?
                `; they are kept in ${kept.ref} and the checkout was put back on its base.` :
                "; they are still in the checkout."),
            ...changedPaths.files.map((path) => `- ${path}`),
            ...(inline !== null ? ["", "```diff", inline.replace(/\n$/, ""), "```"] :
              kept?.ok && kept.changed ? ["", `(The ${kept.patchBytes ?? "full"}-byte diff ` +
                `is kept in ${kept.ref} and in the attempt's preserved patch on the worker host.)`] :
                []),
            "", "---", "", report].join("\n"));
        }
        patchCandidate = success && request.role === "implement" &&
          (!changedPaths || changedPaths.ok)
          ? await (options.capturePatch ?? captureAmuxV22Patch)(
            config.worktreePath, patchBaseline.baseSha,
            { allowUntracked: request.gradeGuard === true })
          : null;
        if (!success && request.role === "implement") preserved = await preserveChanges();
      }
      let resultText = null;
      let resultSha256 = null;
      if (report !== null) {
        const body = Buffer.from(report, "utf8");
        if (body.length >= 1 && body.length <=
            (flow ? AMUX_V22_TRANSPORT_MAX_BYTES : MAX_RESULT_BYTES) &&
            !report.includes("\0")) {
          resultText = report;
          resultSha256 = createHash("sha256").update(body).digest("hex");
        }
        body.fill(0);
      }
      // The patch text alone is the evidence (owner decision 2026-11-15): the
      // app rebuilds every changed file from it and checks the v52 inventory
      // against every path it names, so no file bytes ride beside it.
      const reviewCommit = success && request.gradeGuard === true &&
        request.role === "implement" && changedPaths?.ok &&
        patchCandidate?.ok ?
        await (options.captureReviewCommit ?? captureAmuxV52ReviewCommit)(
          config.worktreePath, patchBaseline.baseSha, request.attemptId,
          changedPaths.files, patchCandidate.patchBody) : null;
      return outcome({ kind: success ? "succeeded" : "failed",
        attemptId: request.attemptId, cliStarted: true,
        ...(patchBaseline ? { recoveryBaseSha: patchBaseline.baseSha } : {}),
        outputDigest: scanned ? scanned.digest :
          createHash("sha256").update(output).digest("hex"),
        elapsedMs: Date.now() - start, usageReceipt,
        resultText, resultSha256,
        ...(request.gradeGuard === true ? {
          gradeGuard: true,
          // A read role publishes nothing, so in the local CLI flow its change
          // is no publication candidate for the grade guard; it is listed
          // apart and shown in its report.
          ...(changedPaths?.ok ? { changedPaths: readRoleChanges ? [] : changedPaths.files } :
            { changedPathsReason: changedPaths?.reason ?? "changed_paths_unavailable" }),
        } : {}),
        ...(readRoleChanges ? { readRoleChangedPaths: readRoleChanges.files,
          readRoleChangesRestored: readRoleChanges.restored,
          ...(readRoleChanges.kept?.ok && readRoleChanges.kept.changed ?
            { readRolePreserved: preservedSummary(readRoleChanges.kept) } : {}) } : {}),
        ...(dependencies ? { dependencies } : {}),
        ...(preserved ? { preserved: preservedSummary(preserved) } : {}),
        ...(leftoverPreserved ? { leftoverPreserved } : {}),
        ...(patchCandidate?.ok ? {
          patchBaseSha: patchCandidate.baseSha,
          patchDigest: patchCandidate.patchDigest,
          patchBody: patchCandidate.patchBody,
        } : patchCandidate ? { patchReason: patchCandidate.reason } : {}),
        ...(reviewCommit?.ok ? {
          reviewCommitSha: reviewCommit.commitSha,
          reviewBaseSha: reviewCommit.baseSha,
          reviewRef: reviewCommit.reviewRef,
          reviewTouchesContract: changedPaths.contractPaths.length > 0,
        } : reviewCommit ? {
          reviewCommitReason: reviewCommit.reason,
        } : {}),
        usageReceiptDigest: usageReceipt ?
          amuxCliUsageReceiptDigest(usageReceipt) : null });
    } finally { output?.fill(0); }
  } catch {
    return outcome({ kind: "outcome_unknown", attemptId: request.attemptId,
      cliStarted: started, failure: started ? "child_io" : "spawn" });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null)
      killChildGroup(child);
    for (const chunk of chunks) chunk.fill(0);
    await cleanupBeforeStart();
  }
}

/** Unix-domain transport is for the isolated bridge account only. The unit
 * must provision a parent directory the bridge group can traverse but not
 * modify, plus a dedicated bridge/worker socket group. */
export function createAmuxV22SidecarServer(socketPath, run,
  { maxRequestBytes = amuxV22LocalCliFlowEnabled() ? FLOW_MAX_REQUEST_BYTES :
    MAX_REQUEST_BYTES } = {}) {
  if (process.platform !== "linux" || typeof socketPath !== "string" ||
      !socketPath.startsWith("/") || typeof run !== "function")
    throw new TypeError("invalid sidecar socket");
  const MAX_REQUEST_BYTES = maxRequestBytes;
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
      // Only a chunk with the newline completes the request; joining every
      // chunk on each arrival would be quadratic for a large prompt.
      if (part.indexOf(10) < 0) return;
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
  protocolCapabilities, modelAccess, provider = "anthropic",
  invocationId = /** @type {string | null} */ (null), recoveryUnit, recoveryWorkspace,
  recoveryJournal = readAmuxV22RecoveryJournal,
  localCliFlow = amuxV22LocalCliFlowEnabled(),
  transcriptRetentionMs = 30 * 24 * 60 * 60_000 }) {
  if (!NAME.test(worker) || typeof stateDir !== "string" ||
      !isAbsolute(stateDir) || typeof run !== "function")
    throw new TypeError("invalid sidecar handler");
  const resultMaxBytes = localCliFlow ? AMUX_V22_TRANSPORT_MAX_BYTES : MAX_RESULT_BYTES;
  /** The operator's stop of a live run (op `stop`, or the unit's SIGTERM). */
  const stoppers = new Map();
  const idleWaiters = [];
  /** Transcripts older than the retention are removed when a new run starts. */
  const pruneTranscripts = async () => {
    const { readdir, stat } = await import("node:fs/promises");
    const cutoff = Date.now() - transcriptRetentionMs;
    for (const name of await readdir(stateDir)) {
      if (!/\.(?:transcript\.jsonl|preserved\.patch)$/.test(name)) continue;
      const path = join(stateDir, name);
      try { if ((await stat(path)).mtimeMs < cutoff) await unlink(path); }
      catch { /* one unreadable entry never stops the run */ }
    }
  };
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
          { patchBody: patch.bytes.toString("utf8") } : {}),
      };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return { kind: "outcome_unknown", attemptId };
    }
  };
  const reportedUsage = (evidence, result, request) => {
    const receipt = amuxCliUsageReceiptSchema.safeParse(result.usageReceipt);
    if (receipt.success && receipt.data.completeness === "reported_complete" &&
        receipt.data.binding.kind === "task_attempt" &&
        receipt.data.binding.attemptId === request.priorAttemptId &&
        receipt.data.invocationId === request.priorAttemptId && receipt.data.worker === worker &&
        amuxCliUsageReceiptDigest(receipt.data) === result.usageReceiptDigest) evidence.usage = {
      status: "reported_complete", projectedCostMicroUsd: null };
  };
  /** Production 2026-11-07: installing a bundle restarts this service, the
   * in-memory terminal is lost, and every later inspection of an earlier run
   * answered legacy_invocation_unbound. A terminal record that this execute
   * path wrote in an earlier invocation still shows that run ended: it is
   * written only after the child exits, it carries the exact recovery
   * binding and claim digest, and the restart ended the unit's whole control
   * group. The current unit must still prove that only this sidecar runs. The
   * earlier role and base are not retained, so any leftover change in the
   * checkout keeps the run unverified, whatever its role. */
  const inspectPriorInvocationJournal = async (request, evidence) => {
    const { proof } = evidence;
    const claim = await recoveryJournal(file(request.priorAttemptId, "claimed"), 65, uid, 0);
    const text = await recoveryJournal(file(request.priorAttemptId, "result"), 131_072, uid, 0);
    let result;
    try { result = text ? JSON.parse(text) : null; } catch { return evidence; }
    const recovery = result?.recovery;
    if (!result || typeof result !== "object" || result.attemptId !== request.priorAttemptId ||
        !["succeeded", "failed", "outcome_unknown"].includes(result.kind) ||
        typeof recovery?.invocationId !== "string" || !/^[a-f0-9]{32}$/.test(recovery.invocationId) ||
        typeof recovery.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(recovery.requestDigest) ||
        claim?.trim() !== recovery.requestDigest ||
        !amuxV22RecoveryBindingMatches(recovery.binding, request)) return evidence;
    proof.terminalOutcome = result.kind === "outcome_unknown" ? "unknown" : result.kind;
    proof.journalBound = true; proof.socketTerminal = true;
    // The invocation that wrote the terminal, not the one answering now.
    evidence.hostInvocationId = recovery.invocationId;
    const workspace = typeof recoveryWorkspace === "function" ? await recoveryWorkspace() : null;
    proof.workspaceClean = workspace?.ok === true;
    // The claim exists only after the request parsed with one of the fixed
    // ROLES. None can send: every shell (implement's, and in the local CLI
    // flow every role's) ran in the no-network jail (or Codex's sandbox) that
    // writes only the checkout, so the clean checkout covers every writer.
    proof.externalEffectsKnown = proof.workspaceClean;
    const unit = typeof recoveryUnit === "function" ? await recoveryUnit() : null;
    for (const key of ["rootOwnedUnit", "controlGroupBound", "processTreeStopped"])
      proof[key] = unit?.[key] === true;
    proof.noActiveExecution = active.size === 0 && !busy;
    if (!proof.noActiveExecution) proof.processTreeStopped = false;
    if (result.kind === "succeeded") evidence.reason = "terminal_success";
    else evidence.reason = Object.entries(proof)
      .filter(([key]) => key !== "terminalOutcome" && key !== "sameLiveInvocation")
      .every(([, value]) => value === true) ? "terminal_journal_proven" : "inspection_unverified";
    reportedUsage(evidence, result, request);
    return evidence;
  };
  const handle = async (raw) => {
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
        if (!memo) return await inspectPriorInvocationJournal(request, evidence);
        if (!/^[a-f0-9]{32}$/.test(invocationId) ||
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
        // Every role that had a shell (implement; in the local CLI flow, all)
        // could write the checkout, so its checkout must be clean on its base.
        const workspace = memo.shell && typeof recoveryWorkspace === "function"
          ? await recoveryWorkspace() : null;
        // A run refused before its CLI started (expired sign-in, base sync)
        // records no base: it changed nothing, so a clean checkout suffices.
        const notStarted = result.kind === "failed" && result.cliStarted === false &&
          memo.baseSha === null;
        proof.workspaceClean = !memo.shell ||
          (workspace?.ok === true && (notStarted || workspace.baseSha === memo.baseSha));
        // The fixed tools cannot send: a shell has no network and writes only
        // the checkout, which must have no leftover modification.
        proof.externalEffectsKnown = Object.hasOwn(ROLES, memo.role) && proof.workspaceClean;
        const unit = typeof recoveryUnit === "function" ? await recoveryUnit() : null;
        for (const key of ["rootOwnedUnit", "controlGroupBound", "processTreeStopped"])
          proof[key] = unit?.[key] === true;
        proof.noActiveExecution = active.size === 0 && !busy;
        if (!proof.noActiveExecution) proof.processTreeStopped = false;
        if (result.kind === "succeeded") evidence.reason = "terminal_success";
        else evidence.reason = Object.entries(proof).filter(([key]) => key !== "terminalOutcome")
          .every(([, value]) => value === true) ? "stopped_proven" : "inspection_unverified";
        reportedUsage(evidence, result, request);
        return evidence;
      } finally { inspecting = false; }
    }
    if (raw?.op === "quota") {
      if (Object.keys(raw).sort().join(",") !== "op,requestId,worker" ||
          !UUID.test(raw.requestId) || raw.worker !== worker) throw new TypeError("invalid quota request");
      let observation = typeof quota === "function" ? await quota() : null;
      // A reading answers only for this sidecar's own provider sign-in.
      if (observation?.provider !== provider) observation = null;
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
        volatilePatches.delete(attemptId);
      }
      return { kind: "confirmed", attemptId };
    }
    // The operator's stop of one live run (local CLI flow). The run ends as a
    // stopped run: its checkout change and transcript are kept.
    if (raw.op === "stop") {
      if (Object.keys(raw).sort().join(",") !== "attemptId,op")
        throw new TypeError("invalid stop");
      const stopper = stoppers.get(attemptId);
      if (!stopper) return active.has(attemptId) ? { kind: "in_progress", attemptId } :
        (await readResult(attemptId)) ?? { kind: "not_found", attemptId };
      stopper.abort();
      return { kind: "stopping", attemptId };
    }
    if (raw.op !== "execute") throw new TypeError("invalid operation");
    const request = { ...raw };
    delete request.op;
    parseAmuxV22OneShotRequest(request, worker, provider, { flow: localCliFlow });
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
      const stopper = localCliFlow ? new AbortController() : null;
      if (stopper) stoppers.set(attemptId, stopper);
      void (async () => {
        try {
          if (localCliFlow) await pruneTranscripts().catch(() => {});
          let result;
          // The local CLI flow keeps the run's whole stream and any change a
          // stop or failure left as files beside the journal (mode 0600),
          // never in the journal itself.
          try {
            result = await run(request, localCliFlow ? {
              localCliFlow: true, signal: stopper.signal,
              transcriptPath: file(attemptId, "transcript.jsonl"),
              preservedPatchPath: file(attemptId, "preserved.patch"),
            } : undefined);
          }
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
              Buffer.byteLength(resultText, "utf8") <= resultMaxBytes &&
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
              Buffer.byteLength(result.patchBody, "utf8") <=
                AMUX_V22_PATCH_MAX_BYTES &&
              createHash("sha256").update(result.patchBody)
                .digest("hex") === result.patchDigest) {
            const bytes = Buffer.from(result.patchBody, "utf8");
            delete durable.publishFilesDigest;
            const timer = setTimeout(() => {
              bytes.fill(0);
              volatilePatches.delete(attemptId);
            }, RESULT_MEMORY_TTL_MS);
            timer.unref?.();
            volatilePatches.set(attemptId,
              { bytes, sha256: result.patchDigest, timer });
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
            shell: !request.readOnlyRetry && amuxV22RoleHasShell(request.role, localCliFlow),
            terminalDigest: createHash("sha256").update(terminalText).digest("hex"),
            baseSha: result.recoveryBaseSha ?? null });
          while (terminals.size > MAX_RECOVERY_TERMINALS) terminals.delete(terminals.keys().next().value);
        } catch { /* The durable claim makes a failed write an unknown result. */ }
        finally {
          stoppers.delete(attemptId);
          active.delete(attemptId); busy = false;
          for (const resolve of idleWaiters.splice(0)) resolve();
        }
      })();
      return { kind: "in_progress", attemptId };
    } finally {
      if (!active.has(attemptId)) busy = false;
    }
  };
  /** The unit's stop (SIGTERM): every live run is stopped as an operator
   * stop and its terminal written before the process exits. */
  handle.stopAll = async () => {
    if (active.size === 0) return;
    const idle = new Promise((resolve) => idleWaiters.push(resolve));
    for (const stopper of stoppers.values()) stopper.abort();
    await idle;
  };
  return handle;
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
