import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export const AMUX_V22_SIDECAR_CODE_LATCH = false;
export const AMUX_V22_SIDECAR_ENV = "TOMVERSE_AMUX_V22_SIDECAR";
export const AMUX_V22_SIDECAR_DEADLINE_MS = 600_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
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

/** Runs one bounded CLI process. The sidecar owns the binary, checkout and
 * credentials; none of those can be named by the bridge request. The basic
 * path returns no model text or usage claim; the app's existing receipt gate
 * continues to block automated positive settlement until telemetry is added. */
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
  const spawnChild = options.spawnChild ?? spawn;
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
      return { kind: success ? "succeeded" : "failed",
        attemptId: request.attemptId, cliStarted: true,
        outputDigest: createHash("sha256").update(output).digest("hex"),
        elapsedMs: Date.now() - start };
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
      return value?.attemptId === attemptId ? value : { kind: "outcome_unknown",
        attemptId };
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
          const resultPath = file(attemptId, "result");
          const temporary = file(attemptId, "result.tmp");
          const handle = await open(temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600);
          try { await handle.writeFile(JSON.stringify(result)); await handle.sync(); }
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
