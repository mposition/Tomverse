import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, open, rmdir, unlink,
  writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inspectAmuxV4AnalysisCliResult,
  planAmuxV4AnalysisCliInvocation } from "./ideaLocalCliContract.mjs";
import { createCodexCliUsageObserver,
  inspectClaudeCliResultUsage } from "./cliUsageObservationCore.ts";
import { createAmuxV4EgressProxy } from "./ideaLocalEgressProxy.ts";
import { amuxV4VerifiedSandboxArgs } from "./ideaLocalSandboxArgs.mjs";
import { amuxV4CodexNoToolsCatalogJson } from "./ideaLocalCodexNoToolsCore.mjs";
import { amuxV4ApprovedAnalysisCliForModel,
  amuxV4CanClaimAnalysisCli } from
  "./ideaLocalApprovedCliCatalog.mjs";
import { claimAmuxV4SyntheticS0Once } from "./ideaLocalS0Once.mjs";

export const AMUX_V4_CLI_HARD_DEADLINE_MS = 600_000;
// Synthetic S0 is closed after the one-call 2026-10-04 price-cap probe.
// Synthetic S0 remains permanently closed. Live analysis was code-activated
// by v15, but its independent environment and app write gates remain required.
export const AMUX_V4_CODEX_S0_ENABLED = false;
export const AMUX_V4_CLAUDE_S0_ENABLED = false;
export const AMUX_V4_LIVE_ANALYSIS_CLI_ENABLED = true;
export const AMUX_V4_LIVE_ANALYSIS_CLI_ENV =
  "TOMVERSE_AMUX_V4_LIVE_ANALYSIS_CLI";
export const amuxV4LiveAnalysisCliEnabled = (value) =>
  AMUX_V4_LIVE_ANALYSIS_CLI_ENABLED && value === "enabled";
const S0_APPROVAL_EXPIRES_AT = Date.parse("2026-10-05T00:00:00.000Z");
const S0_CLAIM_DIRECTORY = "/home/tommy/.amux-cli-profiles";
const S0_MARKER = Object.freeze({
  anthropic: "s0-claude-api-20261004-03.claimed",
  openai: "s0-codex-20261004-original.claimed",
});
const MAX_STDOUT_BYTES = 128 * 1024;
const CLI_PROFILE = Object.freeze({
  openai: Object.freeze({
    source: "/home/tommy/.codex/packages/standalone/releases/0.155.1-x86_64-unknown-linux-musl/bin/codex",
    sha256: "0753dfe1d8b87a52436deb13eb1c549661ef4c84fee2c5aa688385eebeccb761",
    auth: "/home/tommy/.amux-cli-profiles/codex/auth.json", binary: "codex",
    version: "0.155.1", authentication: "subscription",
  }),
  anthropic: Object.freeze({
    source: "/home/tommy/.local/share/claude/versions/2.1.288",
    sha256: "0298068b686e7fdbaf9402a7a587bb7f49c0b0e084de09f69145a0719207640c",
    auth: "/home/tommy/.amux-cli-profiles/claude-api/anthropic-api-key", binary: "claude",
    version: "2.1.288", authentication: "api_key",
  }),
});
// These are fixed synthetic probes, never live model or egress admission.
const S0_SELECTION = Object.freeze({
  openai: Object.freeze({ modelId: "gpt-5.6-sol", reasoningEffort: "high",
    egressHosts: Object.freeze(["chatgpt.com", "api.openai.com", "auth.openai.com"]) }),
  anthropic: Object.freeze({ modelId: "claude-opus-5-5", reasoningEffort: "high",
    egressHosts: Object.freeze(["api.anthropic.com"]) }),
});

const listen = (server, path) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(path, () => { server.off("error", reject); resolve(); });
});
const close = (server) => new Promise((resolve) => server.close(resolve));

/** Also used by a no-provider-call fault test. The real call always passes
 * AMUX_V4_CLI_HARD_DEADLINE_MS; no caller controls its live deadline. */
export async function awaitAmuxV4BoundedChild(child, deadlineMs) {
  if (process.platform !== "linux" || !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 || !child || typeof child.once !== "function") {
    throw new TypeError("invalid AMUX v4 child deadline");
  }
  // A failed spawn has no PID. Listen for its error before checking the PID,
  // otherwise an ENOENT can surface as an unhandled EventEmitter error.
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (typeof child.pid !== "number" || child.pid < 1) return await completion;
  let timedOut = false;
  const killGroup = () => {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, deadlineMs);
  try {
    const exit = await completion;
    return { ...exit, timedOut };
  } finally { clearTimeout(timer); }
}

/** Metadata-only diagnosis; never includes stderr, prompt, auth or output. */
export function amuxV4CliExitFailureStage(exit, tooLarge) {
  if (exit.timedOut) return "deadline";
  if (tooLarge) return "stdout_limit";
  if (exit.code !== 0 || exit.signal !== null) return "child_nonzero";
  return null;
}

export function amuxV4CliCaughtFailureStage(childSpawned) {
  return childSpawned ? "child_io_error" : "setup_or_spawn_error";
}

export function amuxV4CliInspectionFailureStage(inspected) {
  return inspected.kind === "outcome_unknown" ? "parser_rejected" : null;
}

/** Count-only failure receipt. It must not include output, hosts or stderr. */
export function amuxV4CliUnknownResult(failureStage, exitCode, connectCounts,
  parserReason = null, rejectionPoint = null) {
  return { kind: "outcome_unknown", failureStage,
    parserReason: failureStage === "parser_rejected" ? parserReason : null,
    rejectionPoint: failureStage === "parser_rejected" &&
      parserReason === "output_contract_mismatch" ? rejectionPoint : null,
    childExitCode: Number.isSafeInteger(exitCode) && exitCode >= 0 &&
      exitCode <= 255 ? exitCode : null,
    approvedConnects: connectCounts.approved,
    deniedConnects: connectCounts.denied };
}

const codexS0AnswerMatches = (stdout) => {
  let answers = 0;
  let matched = false;
  try {
    for (const line of stdout.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event?.type === "item.completed" &&
          event.item?.type === "agent_message") {
        answers += 1;
        matched = event.item.text?.trim() === "S0_OK";
      }
    }
  } catch { return false; }
  return answers === 1 && matched;
};

/** A bounded, content-free usage projection. Parsing errors leave usage
 * unknown; they never turn a failed invocation into a zero-token call. */
function inspectIsolatedUsage(provider, stdout, exitCode, stdoutComplete) {
  if (provider === "openai") {
    const observer = createCodexCliUsageObserver();
    for (const line of stdout.toString("utf8").split("\n")) {
      if (line.trim()) observer.observeLine(line);
    }
    return observer.finish({ exitCode, stdoutComplete,
      freshEphemeralSession: true });
  }
  let result = null;
  try {
    for (const line of stdout.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      if (parsed?.type === "result") {
        if (result !== null) return inspectClaudeCliResultUsage(null, {
          exitCode, stdoutComplete: false, freshPrintInvocation: true });
        result = parsed;
      }
    }
  } catch { result = null; }
  return inspectClaudeCliResultUsage(result, { exitCode, stdoutComplete,
    freshPrintInvocation: true });
}
async function stageCli(source, path, expectedSha256) {
  await copyFile(source, path, constants.COPYFILE_EXCL);
  await chmod(path, 0o500);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        stat.size < 1 || stat.size > 512 * 1024 * 1024) {
      throw new TypeError("unsafe AMUX v4 CLI binary");
    }
    const hash = createHash("sha256");
    for await (const part of handle.createReadStream({ autoClose: false })) hash.update(part);
    if (hash.digest("hex") !== expectedSha256) {
      throw new TypeError("AMUX v4 CLI binary is not approved");
    }
  } finally { await handle.close(); }
}

/** The only spawn path. Callers cannot choose a binary, credential or proxy
 * destination; S0 and live admission choose those in code before entering. */
async function runIsolatedCliOnce(provider, input, selection, isS0) {
  const binary = CLI_PROFILE[provider];
  const plan = planAmuxV4AnalysisCliInvocation({ provider,
    modelId: selection.modelId, reasoningEffort: selection.reasoningEffort });
  const socketDirectory = await mkdtemp("/tmp/amux-v4-socket-");
  const cliDirectory = await mkdtemp("/tmp/amux-v4-cli-");
  const socketPath = join(socketDirectory, "proxy.sock");
  const cliPath = join(cliDirectory, binary.binary);
  const catalogPath = provider === "openai" ? join(cliDirectory,
    "model-catalog.json") : null;
  const connectCounts = { approved: 0, denied: 0 };
  const proxy = createAmuxV4EgressProxy(selection.egressHosts, {
    onConnectDecision: (decision) => { connectCounts[decision] += 1; },
  });
  const connections = new Set();
  proxy.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  let listening = false;
  let child;
  let childSpawned = false;
  let failure;
  const chunks = [];
  try {
    await Promise.all([chmod(socketDirectory, 0o700),
      chmod(cliDirectory, 0o700)]);
    await stageCli(binary.source, cliPath, binary.sha256);
    if (catalogPath) await writeFile(catalogPath,
      amuxV4CodexNoToolsCatalogJson(plan.modelId), {
        flag: "wx", mode: 0o400,
      });
    await listen(proxy, socketPath);
    listening = true;
    await chmod(socketPath, 0o600);
    const args = await amuxV4VerifiedSandboxArgs(socketDirectory, plan.command,
      { path: cliPath, sha256: binary.sha256 },
      { provider: plan.provider, modelId: plan.modelId,
        reasoningEffort: plan.reasoningEffort, authPath: binary.auth });
    child = spawn("/usr/bin/bwrap", args, {
      cwd: "/tmp", env: { PATH: "/usr/bin:/bin" }, detached: true,
      stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    child.once("spawn", () => { childSpawned = true; });
    const killGroup = () => {
      if (!child?.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    let tooLarge = false;
    let outputBytes = 0;
    child.stdout.on("data", (bytes) => {
      outputBytes += bytes.length;
      if (outputBytes > MAX_STDOUT_BYTES) { tooLarge = true; killGroup(); }
      else chunks.push(bytes);
    });
    // Stderr may contain raw input, authentication or provider diagnostics.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const exit = await awaitAmuxV4BoundedChild(child, AMUX_V4_CLI_HARD_DEADLINE_MS);
    const exitStage = amuxV4CliExitFailureStage(exit, tooLarge);
    const stdout = Buffer.concat(chunks);
    const usageObservation = inspectIsolatedUsage(provider, stdout,
      exit.code, !tooLarge);
    if (exitStage) {
      stdout.fill(0);
      return { ...amuxV4CliUnknownResult(exitStage, exit.code, connectCounts),
        cliStarted: childSpawned, usageObservation };
    }
    try {
      const inspected = inspectAmuxV4AnalysisCliResult(plan, stdout, exit.code,
        { diagnostic: true, syntheticEventType: isS0 });
      const inspectionFailure = amuxV4CliInspectionFailureStage(inspected);
      if (inspectionFailure) {
        const unknown = amuxV4CliUnknownResult(inspectionFailure, exit.code,
          connectCounts, inspected.failureReason, inspected.rejectionPoint);
        return isS0 && (inspected.unexpectedEventType || inspected.syntheticTrace)
          ? { ...unknown,
            ...(inspected.syntheticTrace ? { syntheticTrace: inspected.syntheticTrace } : {}),
            ...(inspected.unexpectedEventType ? {
              unexpectedEventType: inspected.unexpectedEventType,
            unexpectedEventPhase: inspected.unexpectedEventPhase,
            ...(inspected.unexpectedSystemSubtype ? {
              unexpectedSystemSubtype: inspected.unexpectedSystemSubtype,
              unexpectedSystemSubtypeDigest:
                inspected.unexpectedSystemSubtypeDigest,
              unexpectedSystemHasCapabilities:
                inspected.unexpectedSystemHasCapabilities,
              unexpectedSystemHasFreeText:
                inspected.unexpectedSystemHasFreeText,
            } : {}),
            } : {}), cliStarted: childSpawned, usageObservation }
          : { ...unknown, cliStarted: childSpawned, usageObservation };
      }
      return inspected.kind === "model_unverified" && isS0
        ? { ...inspected, answerMatchesS0: codexS0AnswerMatches(stdout),
          cliStarted: childSpawned, usageObservation }
        : { ...inspected, cliStarted: childSpawned, usageObservation };
    }
    finally { stdout.fill(0); }
  } catch (error) {
    failure = error;
    const unknown = amuxV4CliUnknownResult(
      amuxV4CliCaughtFailureStage(childSpawned), null, connectCounts);
    return childSpawned ? { ...unknown, cliStarted: true,
      usageObservation: inspectIsolatedUsage(provider, Buffer.alloc(0), null, false) }
      : unknown;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    if (child && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    for (const socket of connections) socket.destroy();
    const errors = [];
    const cleanup = async (step) => { try { await step(); } catch (error) { errors.push(error); } };
    if (listening) await cleanup(() => close(proxy));
    for (const path of [socketPath, cliPath, catalogPath].filter(Boolean)) {
      await cleanup(async () => {
        try { await unlink(path); } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      });
    }
    for (const path of [socketDirectory, cliDirectory]) {
      await cleanup(() => rmdir(path));
    }
    if (errors.length > 0) throw new AggregateError(
      failure ? [failure, ...errors] : errors, "AMUX v4 CLI cleanup failed");
  }
}

/** The synthetic S0 probe can only use its fixed prompt and candidate hosts. */
export async function runAmuxV4IsolatedSyntheticCliS0(provider) {
  if (process.platform !== "linux" || typeof provider !== "string" ||
      !Object.hasOwn(CLI_PROFILE, provider) ||
      !(provider === "openai" ? AMUX_V4_CODEX_S0_ENABLED : AMUX_V4_CLAUDE_S0_ENABLED) ||
      process.env.AMUX_V4_SYNTHETIC_S0_APPROVED !== "1") {
    return { kind: "refused" };
  }
  // The exported runner owns admission too: bypassing the operator script
  // must not bypass the one-call marker or its expiry.
  const claimed = await claimAmuxV4SyntheticS0Once({
    directory: S0_CLAIM_DIRECTORY, markerName: S0_MARKER[provider],
    expiresAt: S0_APPROVAL_EXPIRES_AT,
  });
  if (!claimed) return { kind: "refused" };
  const input = Buffer.from("Reply with exactly S0_OK and nothing else.", "utf8");
  try { return await runIsolatedCliOnce(provider, input, S0_SELECTION[provider], true); }
  finally { input.fill(0); }
}

/** Live connector admits only the reviewed exact tuple and an explicit
 * environment switch. An unset switch cannot reach the model. */
export async function runAmuxV4IsolatedApprovedAnalysis(selection) {
  if (!amuxV4LiveAnalysisCliEnabled(
        process.env[AMUX_V4_LIVE_ANALYSIS_CLI_ENV]) ||
      process.platform !== "linux" ||
      !selection || typeof selection !== "object" || Array.isArray(selection) ||
      !Buffer.isBuffer(selection.prompt) || selection.prompt.length < 1 ||
      selection.prompt.length > 32_768) return { kind: "refused" };
  const approved = amuxV4ApprovedAnalysisCliForModel(selection.modelId);
  const binary = approved && CLI_PROFILE[approved.provider];
  if (!amuxV4CanClaimAnalysisCli(approved, selection.modelId) ||
      !binary || selection.provider !== approved.provider ||
      selection.reasoningEffort !== approved.reasoningEffort ||
      !Array.isArray(approved.egressHosts) || approved.egressHosts.length < 1) {
    return { kind: "catalog_unapproved" };
  }
  const result = await runIsolatedCliOnce(approved.provider, selection.prompt,
    approved, false);
  return result.cliStarted ? { ...result, cliVersion: binary.version,
    authentication: binary.authentication } : result;
}
