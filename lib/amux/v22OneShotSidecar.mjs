import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { inspectClaudeCliResultUsage } from "./cliUsageObservationCore.ts";
import { amuxCliUsageReceiptDigest, makeAmuxCliUsageReceipt } from
  "./cliUsageLedgerCore.ts";
import { assertAmuxV22LocalCliTools } from "./v22ExternalAuthorityCore.ts";
import { captureAmuxV22Patch, captureAmuxV22PatchBaseline } from
  "./v22PatchCapture.mjs";

export const AMUX_V22_SIDECAR_CODE_LATCH = false;
export const AMUX_V22_SIDECAR_ENV = "TOMVERSE_AMUX_V22_SIDECAR";
export const AMUX_V22_SIDECAR_DEADLINE_MS = 600_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const RESULT_MEMORY_TTL_MS = 15 * 60_000;
const MAX_BUDGET_MICROUSD = 5_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9._:-]{1,120}$/;
const MODEL = /^claude-[A-Za-z0-9._-]{1,120}$/;
const ROLES = Object.freeze({
  design: "Read,Grep,Glob",
  investigate: "Read,Grep,Glob",
  review: "Read,Grep,Glob",
  implement: "Read,Grep,Glob,Edit,Write",
});

export function amuxV22SidecarEnabled(value) {
  return AMUX_V22_SIDECAR_CODE_LATCH && value === "1";
}

export function parseAmuxV22OneShotRequest(raw, assignedWorker) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !==
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
  return raw;
}

function budgetUsd(microusd) {
  const dollars = Math.floor(microusd / 1_000_000);
  const fraction = String(microusd % 1_000_000).padStart(6, "0");
  return `${dollars}.${fraction}`;
}

export function amuxV22ClaudeArgs(request) {
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

/** The sidecar owns the binary, checkout and credentials; none of those can
 * be named by the bridge request. Plaintext result is transient and never
 * enters the durable journal. */
export async function runAmuxV22OneShot(raw, config, options = {}) {
  const request = parseAmuxV22OneShotRequest(raw, config?.worker);
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
      return { kind: "failed", attemptId: request.attemptId,
        cliStarted: false, failure: `patch_baseline_${patchBaseline.reason}` };
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
      return { kind: "outcome_unknown", attemptId: request.attemptId,
        cliStarted: started, failure: timedOut ? "deadline" :
          truncated ? "output_limit" : "signal" };
    }
    const output = Buffer.concat(chunks);
    try {
      let result;
      try { result = JSON.parse(output.toString("utf8")); }
      catch { return { kind: "outcome_unknown", attemptId: request.attemptId,
        cliStarted: true, failure: "invalid_result" }; }
      if (result?.type !== "result" || typeof result.subtype !== "string" ||
          typeof result.is_error !== "boolean")
        return { kind: "outcome_unknown", attemptId: request.attemptId,
          cliStarted: true, failure: "invalid_result" };
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
      return { kind: success ? "succeeded" : "failed",
        attemptId: request.attemptId, cliStarted: true,
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
          amuxCliUsageReceiptDigest(usageReceipt) : null };
    } finally { output.fill(0); }
  } catch {
    return { kind: "outcome_unknown", attemptId: request.attemptId,
      cliStarted: started, failure: started ? "child_io" : "spawn" };
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
export function createAmuxV22SidecarHandler({ worker, stateDir, run }) {
  if (!NAME.test(worker) || typeof stateDir !== "string" ||
      !isAbsolute(stateDir) || typeof run !== "function")
    throw new TypeError("invalid sidecar handler");
  const active = new Set();
  const volatileResults = new Map();
  const volatilePatches = new Map();
  let busy = false;
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
    if (busy) return { kind: "busy", attemptId };
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
              !["succeeded", "failed", "outcome_unknown"].includes(result.kind))
            result = { kind: "outcome_unknown", attemptId };
          const resultText = result.resultText;
          const resultSha256 = result.resultSha256;
          const durable = { ...result };
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
          try { await handle.writeFile(JSON.stringify(durable)); await handle.sync(); }
          finally { await handle.close(); }
          await rename(temporary, resultPath);
          await syncDirectory();
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
