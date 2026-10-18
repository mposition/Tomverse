import { chmod, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { amuxV4ApprovedAnalysisCliForModel } from
  "./ideaLocalApprovedCliCatalog.mjs";
import { createAmuxV19EgressProxy } from "./ideaLocalEgressProxy.ts";
import { stageAmuxV19ClaudeCli } from "./ideaLocalIsolatedCliRunner.mjs";
import { withAmuxTrackedCheckout, withAmuxTrackedCheckouts } from
  "./ideaTrackedCheckoutMaterialize.ts";
import { AmuxTrackedCheckoutManifestError } from
  "./ideaTrackedCheckoutManifestCore.ts";
import { awaitAmuxTrackedCheckoutChild } from
  "./ideaTrackedCheckoutProcessResult.mjs";
import { verifiedAmuxTrackedCheckoutSandbox } from
  "./ideaTrackedCheckoutSandbox.mjs";
import { launchAmuxV19TracedSandbox } from
  "./ideaTrackedCheckoutTraceRunner.mjs";

export const AMUX_V19_TRACKED_CHECKOUT_CLI_ENV =
  "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI";
const unknown = (cliStarted = false, failureStage = null,
  diagnostics = null) => ({
  kind: "outcome_unknown", cliStarted,
  ...(failureStage ? { failureStage } : {}),
  ...(diagnostics ? { childExitCode: diagnostics.childExitCode,
    approvedConnects: diagnostics.approvedConnects,
    deniedConnects: diagnostics.deniedConnects,
    ...(diagnostics.stderrClass ? {
      stderrClass: diagnostics.stderrClass } : {}) } : {}),
});
const STOP_READ_TIMEOUT_MS = 8_000;
const STOP_POLL_INTERVAL_MS = 5_000;

/** Cleanup failures must stay visible while still carrying the conservative
 * provider-use signal needed to settle an uncertain reservation. */
export class AmuxTrackedCheckoutHostError extends Error {
  constructor(cause, cliStarted) {
    super("AMUX tracked checkout host attempt failed", { cause });
    this.name = "AmuxTrackedCheckoutHostError";
    this.cliStarted = cliStarted;
  }
}

/** A stalled stop read is uncertain and therefore stops the attempt. This is
 * a poll deadline, not an elapsed-time limit on the approved CLI invocation. */
export async function amuxV19StopRequested(stopCheck, parentSignal,
  timeoutMs = STOP_READ_TIMEOUT_MS) {
  if (typeof stopCheck !== "function" ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError("invalid v19 stop check");
  if (parentSignal?.aborted) return true;
  const controller = new AbortController();
  let timer;
  let onParentAbort;
  try {
    const checked = Promise.resolve().then(() =>
      controller.signal.aborted ? true : stopCheck(controller.signal))
      .then((value) => value !== false, () => true);
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(true); }, timeoutMs);
    });
    const parentAborted = parentSignal ? new Promise((resolve) => {
      onParentAbort = () => { controller.abort(); resolve(true); };
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      if (parentSignal.aborted) onParentAbort();
    }) : null;
    return await Promise.race(parentAborted
      ? [checked, expired, parentAborted] : [checked, expired]);
  } finally {
    clearTimeout(timer);
    if (onParentAbort) parentSignal.removeEventListener("abort", onParentAbort);
    controller.abort();
  }
}

function watchStopDuringCheckout(stopCheck) {
  const controller = new AbortController();
  let closed = false;
  let timer;
  const poll = async () => {
    if (closed) return;
    if (await amuxV19StopRequested(stopCheck, controller.signal)) {
      if (!closed) controller.abort();
    } else if (!closed) timer = setTimeout(() => { void poll(); }, STOP_POLL_INTERVAL_MS);
  };
  void poll();
  return Object.freeze({
    signal: controller.signal,
    close() { closed = true; clearTimeout(timer); controller.abort(); },
  });
}
const listen = (server, path) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(path, () => { server.off("error", reject); resolve(); });
});
const close = (server) => new Promise((resolve) => server.close(resolve));

/** One file-tool-only CLI attempt over exact fixed-SHA source roots. The app
 * must first own admission, budget reservation and stop state. It never writes a
 * result to the app and its independent switch defaults closed. */
export async function runAmuxV19TrackedCheckoutAnalysis(input) {
  const approved = amuxV4ApprovedAnalysisCliForModel(input?.modelId);
  const multiple = Array.isArray(input?.references);
  const validReference = (reference, ordinal) =>
    reference?.referenceOrdinal === ordinal &&
    typeof reference.repositoryPath === "string" &&
    isAbsolute(reference.repositoryPath) &&
    !reference.repositoryPath.includes("\0") &&
    typeof reference.commitSha === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(reference.commitSha);
  if (process.platform !== "linux" ||
      process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] !== "enabled" ||
      approved?.provider !== "anthropic" ||
      approved.reasoningEffort !== input?.reasoningEffort ||
      !Array.isArray(approved.egressHosts) ||
      approved.egressHosts.length !== 1 ||
      approved.egressHosts[0] !== "api.anthropic.com" ||
      !Buffer.isBuffer(input?.prompt) || input.prompt.length === 0 ||
      typeof input?.stopCheck !== "function" ||
      (multiple ? input.repositoryPath !== undefined ||
        input.commitSha !== undefined ||
        input.references.length === 0 ||
        input.references.length > 2_147_483_647 ||
        input.references.some((reference, ordinal) =>
          !validReference(reference, ordinal)) :
        !validReference({ referenceOrdinal: 0,
          repositoryPath: input.repositoryPath,
          commitSha: input.commitSha }, 0)) ||
      typeof input.digestSecret !== "string" ||
      Buffer.byteLength(input.digestSecret, "utf8") < 32)
    return { kind: "refused" };
  if (await amuxV19StopRequested(input.stopCheck)) return unknown();

  let cliStarted = false;
  const connectCounts = { approved: 0, denied: 0 };
  const watcher = watchStopDuringCheckout(input.stopCheck);
  const withCheckout = multiple
    ? (run) => withAmuxTrackedCheckouts({ references: input.references,
      digestSecret: input.digestSecret, signal: watcher.signal }, run)
    : (run) => withAmuxTrackedCheckout({
      repositoryPath: input.repositoryPath, commitSha: input.commitSha,
      digestSecret: input.digestSecret, signal: watcher.signal }, run);
  try { return await withCheckout(async (checkout) => {
    let socketDirectory;
    let cliDirectory;
    let socketPath;
    let cliPath;
    let proxy;
    let listening = false;
    let child;
    let traced;
    const connections = new Set();
    let failure;
    try {
      if (watcher.signal.aborted ||
          await amuxV19StopRequested(input.stopCheck, watcher.signal) ||
          watcher.signal.aborted) return unknown();
      socketDirectory = await mkdtemp("/tmp/amux-v4-socket-");
      cliDirectory = await mkdtemp("/tmp/amux-v4-cli-");
      socketPath = join(socketDirectory, "proxy.sock");
      cliPath = join(cliDirectory, "claude");
      await Promise.all([chmod(socketDirectory, 0o700),
        chmod(cliDirectory, 0o700)]);
      const stagedCli = await stageAmuxV19ClaudeCli(cliPath);
      // The stager also returns the dedicated Max OAuth token path. The binary
      // verifier accepts only path and digest; auth is checked separately.
      const cliMount = { path: stagedCli.path, sha256: stagedCli.sha256 };
      proxy = createAmuxV19EgressProxy(approved.egressHosts, {
        onConnectDecision(decision) {
          const next = connectCounts[decision];
          if (next < 2_147_483_647) connectCounts[decision] = next + 1;
        },
      });
      proxy.on("connection", (socket) => {
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
      });
      await listen(proxy, socketPath);
      listening = true;
      await chmod(socketPath, 0o600);
      if (watcher.signal.aborted ||
          await amuxV19StopRequested(input.stopCheck, watcher.signal)) return unknown();
      const args = await verifiedAmuxTrackedCheckoutSandbox({
        socketDirectory, cliMount, authPath: stagedCli.authPath,
        checkoutDirectory: checkout.directory,
        modelId: approved.modelId,
        reasoningEffort: approved.reasoningEffort,
      }, checkout);
      if (watcher.signal.aborted ||
          await amuxV19StopRequested(input.stopCheck, watcher.signal) ||
          watcher.signal.aborted) return unknown();
      watcher.close();
      traced = await launchAmuxV19TracedSandbox({
        args, directory: checkout.directory, files: checkout.files,
      });
      child = traced.child;
      // A PID is available synchronously when the host process started. Treat
      // even an immediate sandbox/CLI failure as possible provider usage.
      cliStarted = Number.isSafeInteger(child.pid) && child.pid > 0;
      child.once("spawn", () => { cliStarted = true; });
      const observed = await awaitAmuxTrackedCheckoutChild({
        child, prompt: input.prompt,
        diagnostic: input.diagnostic === true,
        stopCheck: (signal) => amuxV19StopRequested(input.stopCheck, signal),
        directory: checkout.directory, files: checkout.files,
        modelId: approved.modelId,
        finishOpenTrace: (exit) => traced.finishTrace(exit),
      });
      if (observed.kind !== "verified_success") return unknown(cliStarted,
        input.diagnostic === true ? observed.failureStage ??
          "parser_rejected" : null,
        input.diagnostic === true ? {
          childExitCode: observed.childExitCode ?? null,
          approvedConnects: connectCounts.approved,
          deniedConnects: connectCounts.denied,
          stderrClass: observed.stderrClass ?? null,
        } : null);
      if (await amuxV19StopRequested(input.stopCheck)) return unknown(
        cliStarted, input.diagnostic === true ? "post_result_stop" : null);
      return { ...observed, cliStarted,
        ...(multiple ? { references: checkout.references } : {
          commitSha: input.commitSha,
          excludedCount: checkout.excludedCount,
          excludedPathDigest: checkout.excludedPathDigest,
          excludedReasons: checkout.excludedReasons,
        }) };
    } catch (error) {
      failure = error;
      return unknown(cliStarted,
        input.diagnostic === true ? "host_error" : null);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { try { child.kill("SIGKILL"); } catch { /* Already closed. */ } }
      }
      for (const socket of connections) socket.destroy();
      const errors = [];
      const cleanup = async (step) => {
        try { await step(); } catch (error) { errors.push(error); }
      };
      if (traced) await cleanup(() => traced.cleanup());
      if (listening) await cleanup(() => close(proxy));
      for (const path of [socketPath, cliPath].filter(Boolean)) {
        await cleanup(async () => {
          try { await unlink(path); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        });
      }
      for (const path of [socketDirectory, cliDirectory].filter(Boolean))
        await cleanup(() => rmdir(path));
      if (errors.length > 0) throw new AggregateError(
        failure ? [failure, ...errors] : errors,
        "AMUX v19 tracked checkout CLI cleanup failed");
    }
  }); } catch (error) {
    // A stopped Git read may surface a manifest error from a separately
    // loaded TS module in the host test/runtime loader. Its stable code is
    // sufficient here: either way the CLI has not provided a trusted result.
    if (error instanceof AmuxTrackedCheckoutManifestError ||
        (error?.name === "AmuxTrackedCheckoutManifestError" &&
         error.code === "invalid_tree")) return unknown(cliStarted);
    throw new AmuxTrackedCheckoutHostError(error, cliStarted);
  } finally { watcher.close(); }
}
