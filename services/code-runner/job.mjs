// One cloud job on this runner, from claim to finish (docs/ops/desktop-cloud-execution.md).
//
//  1. Read the job's git bundle from the Tomverse server with the claim's job token and check its size and SHA-256.
//  2. Fetch it twice: into a bare "pristine" repository only this process reads, and into the working copy the agent
//     gets (with its own .git). Both are made before the agent runs, from the bundle only; nothing is checked out from
//     the agent's repository afterwards.
//  3. Start the model adapter on a socket in the job folder and the worker in the sandbox (isolation.mjs).
//  4. Every heartbeat: send new progress lines, extend the claim, and stop the worker if the person cancelled, the
//     reservation ended or the time is up.
//  5. Compute the patch against the snapshot with the pristine repository and a temporary index: system and global git
//     configuration ignored, no hooks, no external diff or text conversion, so nothing the agent wrote is run here.
//  6. Report the outcome, summary and patch, and remove the job folder.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelAdapter } from "./model-adapter.mjs";
import { sandboxCommand } from "./isolation.mjs";

export const PATCH_MAX_BYTES = 6 * 1024 * 1024;
const LOG_BATCH = 50;

const gitEnv = (home) => ({
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
});
const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "diff.external=", "-c", "core.attributesFile=/dev/null"];

function git(args, { cwd, env, input, maxBuffer = 64 * 1024 * 1024 }) {
  const result = spawnSync("git", [...SAFE_GIT, ...args], { cwd, env, input, maxBuffer, windowsHide: true });
  if (result.status !== 0) throw Object.assign(new Error(`git ${args[0]} failed`), { stderr: String(result.stderr ?? "").slice(0, 400) });
  return result.stdout;
}

/** The working copy and the pristine repository, both from the bundle. Throws a coded error on a bad bundle. */
export function checkoutBundle({ dir, bundlePath, baseCommit }) {
  const home = join(dir, "git-home"), pristine = join(dir, "pristine.git"), work = join(dir, "work");
  const env = gitEnv(home);
  const fetchInto = (args) => {
    git([...args, "fetch", "--quiet", "--no-tags", bundlePath, "+refs/heads/*:refs/tomverse/snapshot/*"], { cwd: dir, env });
    let head = "";
    try {
      head = String(git([...args, "rev-parse", "--verify", "--quiet", `${baseCommit}^{commit}`], { cwd: dir, env })).trim();
    } catch { /* not in the bundle */ }
    if (head !== baseCommit) throw Object.assign(new Error("snapshot mismatch"), { code: "CODE_CLOUD_BUNDLE_INVALID" });
  };
  git(["init", "--quiet", "--bare", pristine], { cwd: dir, env });
  fetchInto(["--git-dir", pristine]);
  git(["init", "--quiet", work], { cwd: dir, env });
  fetchInto(["-C", work]);
  git(["-C", work, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", baseCommit], { cwd: dir, env });
  return { work, pristine, env };
}

/** Everything the agent changed in the working copy, as a binary-safe patch against the snapshot commit. */
export function snapshotPatch({ dir, pristine, work, baseCommit, env }) {
  const index = { ...env, GIT_INDEX_FILE: join(dir, "result.index") };
  const repo = ["--git-dir", pristine, "--work-tree", work];
  git([...repo, "read-tree", baseCommit], { cwd: work, env: index });
  git([...repo, "add", "--all", "--", "."], { cwd: work, env: index });
  return git([...repo, "diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", baseCommit, "--"], { cwd: work, env: index, maxBuffer: PATCH_MAX_BYTES + 1 });
}

/**
 * Ends the worker and everything it started. Under bubblewrap, killing bwrap ends the job's PID namespace and with it
 * every process inside. Without a sandbox (local development) the worker leads its own process group, or on Windows
 * the tree is ended with taskkill.
 */
function killTree(child) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* not a group leader */ }
  }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

const OUTCOMES = { success: "completed", cancelled: "cancelled" };
const STOP_CODES = { time_limit: "CODE_CLOUD_TIME_LIMIT", runner_stopped: "CODE_CLOUD_RUNNER_STOPPED", reservation_ended: "CODE_CLOUD_RESERVATION_ENDED" };
const failureCode = (outcome) => `CODE_CLOUD_AGENT_${String(outcome).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`.slice(0, 64);

/**
 * Runs one claimed job. `server` is runner.mjs's client (post, bundle); `config` names the worker, the CLI engine,
 * the isolation and the limits. Resolves when the job has been reported; never throws.
 */
export async function runJob(job, { server, config, log = () => {} }) {
  const dir = await mkdtemp(join(config.workRoot ?? tmpdir(), "tomverse-cloud-"));
  const lines = [];
  const push = (text) => { if (text) lines.push(String(text)); };
  let stopReason = null, worker = null, adapter = null, heartbeatTimer = null, deadline = null;
  const kill = (reason) => {
    stopReason ??= reason;
    if (worker && worker.exitCode === null) killTree(worker);
  };
  const report = async (body) => server.post({ action: "finish", jobId: job.jobId, ...body, logs: lines.splice(0, LOG_BATCH) }, job.token).catch((error) => log(`finish failed: ${error.message}`));
  try {
    push("Preparing the working copy");
    const bundle = await server.bundle(job.jobId, job.token);
    if (bundle.byteLength !== job.bundleBytes || createHash("sha256").update(bundle).digest("hex") !== job.bundleSha256)
      return await report({ outcome: "failed", failureCode: "CODE_CLOUD_BUNDLE_INVALID" });
    const bundlePath = join(dir, "snapshot.bundle");
    await writeFile(bundlePath, bundle);
    let checkout;
    try {
      checkout = checkoutBundle({ dir, bundlePath, baseCommit: job.baseCommit });
    } catch (error) {
      return await report({ outcome: "failed", failureCode: error.code ?? "CODE_CLOUD_CHECKOUT_FAILED" });
    }
    await rm(bundlePath, { force: true });
    // The sandbox gets the working copy, a home and this io folder (request, result, model socket); never the pristine
    // repository or anything else in the job folder.
    const home = join(dir, "home"), io = join(dir, "io");
    await mkdir(home, { recursive: true });
    await mkdir(io, { recursive: true });
    const socket = process.platform === "win32" ? `\\\\.\\pipe\\tomverse-cloud-${job.jobId}-${randomUUID().slice(0, 8)}` : join(io, "model.sock");
    let credits = 0;
    adapter = createModelAdapter({
      model: job.executor,
      callModel: async (call) => {
        try {
          const answer = await server.post({ action: "model", jobId: job.jobId, ...call }, job.token);
          return { ok: true, value: answer.value, usage: answer.usage, callCredits: answer.callCredits };
        } catch (error) {
          return { ok: false, status: error.status ?? 503, code: error.code ?? "CODE_CLOUD_UNAVAILABLE", dispatchState: error.dispatchState ?? "dispatched" };
        }
      },
      onCall: (result) => {
        if (result.ok) {
          credits += result.callCredits ?? 0;
          push(`Model call settled: ${result.callCredits ?? 0} credits (${credits} so far)`);
        } else push(`Model call refused: ${result.code}`);
      },
    });
    await adapter.listen(socket);
    const resultFile = join(io, "result.json"), requestFile = join(io, "request.json");
    await writeFile(requestFile, JSON.stringify({ runtime: config.cliRuntime, workDir: checkout.work, socket, resultFile, instruction: job.instruction,
      timeoutMs: Math.max(60_000, job.limits.maxRuntimeMs - 120_000), commandTimeoutMs: 10 * 60_000 }));
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, TOMVERSE_HOME: join(home, ".tomverse"), TMPDIR: home, LANG: "C.UTF-8",
      ...(process.platform === "win32" ? { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: home, TMP: home, USERPROFILE: home } : {}) };
    const command = sandboxCommand({ isolation: config.isolation, node: process.execPath, args: [config.workerScript, requestFile], cwd: checkout.work, env,
      paths: { readOnly: config.readOnlyPaths, writable: [checkout.work, home, io] } });
    push(command.isolated ? "Started in an isolated sandbox with no network" : "Started without a sandbox (local development runner)");
    worker = spawn(command.command, command.args, { cwd: checkout.work, env: command.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !command.isolated && process.platform !== "win32" });
    let buffered = "";
    worker.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      let at;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        try { push(JSON.parse(line).text); } catch { /* not a progress line */ }
      }
    });
    let stderr = "";
    worker.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    const exited = new Promise((resolveExit) => worker.on("close", (code) => resolveExit(code)));
    deadline = setTimeout(() => kill("time_limit"), job.limits.maxRuntimeMs);
    let lastBeat = Date.now();
    const beat = async () => {
      try {
        const answer = await server.post({ action: "heartbeat", jobId: job.jobId, logs: lines.splice(0, LOG_BATCH) }, job.token);
        lastBeat = Date.now();
        if (answer.cancel) kill("cancelled");
        else if (answer.stop) kill(answer.reason ?? "stopped");
      } catch (error) {
        // The server dropped the claim (404/409), or it has not been reachable for longer than the claim lasts.
        if (error.status === 404 || error.status === 409 || Date.now() - lastBeat > job.limits.leaseMs) kill("lost");
      }
    };
    if (job.cancelRequested) kill("cancelled");
    // The runner is shutting down (a deploy): the job ends as failed and the person can start it again.
    if (config.signal?.aborted) kill("runner_stopped");
    config.signal?.addEventListener("abort", () => kill("runner_stopped"), { once: true });
    heartbeatTimer = setInterval(() => { void beat(); }, job.limits.heartbeatMs);
    const code = await exited;
    clearInterval(heartbeatTimer);
    clearTimeout(deadline);
    if (stopReason === "lost") return;
    if (stopReason === "cancelled") return await report({ outcome: "cancelled" });
    if (stopReason) return await report({ outcome: "failed", failureCode: STOP_CODES[stopReason] ?? "CODE_CLOUD_RESERVATION_ENDED" });
    let result = null;
    try { result = JSON.parse(await readFile(resultFile, "utf8")); } catch { /* the worker died before writing it */ }
    if (!result) {
      log(`worker exited ${code}: ${stderr.slice(-300)}`);
      return await report({ outcome: "failed", failureCode: "CODE_CLOUD_WORKER_FAILED" });
    }
    const status = OUTCOMES[result.outcome] ?? "failed";
    if (status !== "completed") return await report({ outcome: status, summary: result.summary || undefined, ...(status === "failed" ? { failureCode: failureCode(result.outcome) } : {}) });
    let patch;
    try {
      patch = snapshotPatch({ dir, pristine: checkout.pristine, work: checkout.work, baseCommit: job.baseCommit, env: checkout.env });
    } catch {
      return await report({ outcome: "failed", failureCode: "CODE_CLOUD_PATCH_FAILED" });
    }
    if (patch.byteLength > PATCH_MAX_BYTES) return await report({ outcome: "failed", failureCode: "CODE_CLOUD_PATCH_TOO_LARGE", summary: result.summary || undefined });
    push(patch.byteLength ? `Prepared a patch of ${patch.byteLength} bytes` : "No files were changed");
    return await report({ outcome: "completed", summary: result.summary || undefined,
      ...(patch.byteLength ? { patchBase64: patch.toString("base64"), patchSha256: createHash("sha256").update(patch).digest("hex") } : {}) });
  } catch (error) {
    log(`job failed: ${error.message}`);
    return await report({ outcome: "failed", failureCode: "CODE_CLOUD_RUNNER_ERROR" });
  } finally {
    clearInterval(heartbeatTimer);
    clearTimeout(deadline);
    if (worker && worker.exitCode === null) killTree(worker);
    await adapter?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
