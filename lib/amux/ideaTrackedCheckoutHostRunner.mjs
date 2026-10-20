import { chmod, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { confirmAmuxV19Continue, createAmuxV19StopContact,
  pollAmuxV19Stop } from "./ideaLocalAppRequest.mjs";
import { amuxV4ApprovedAnalysisCliForModel } from
  "./ideaLocalApprovedCliCatalog.mjs";
import { createAmuxV19EgressProxy } from "./ideaLocalEgressProxy.ts";
import { stageAmuxV19ClaudeCli } from "./ideaLocalIsolatedCliRunner.mjs";
import { verifyAmuxV4SandboxSocket } from "./ideaLocalSandboxArgs.mjs";
import { withAmuxTrackedCheckout, withAmuxTrackedCheckouts } from
  "./ideaTrackedCheckoutMaterialize.ts";
import { AmuxTrackedCheckoutManifestError } from
  "./ideaTrackedCheckoutManifestCore.ts";
import { awaitAmuxTrackedCheckoutChild } from
  "./ideaTrackedCheckoutProcessResult.mjs";
import { verifiedAmuxTrackedCheckoutSandbox,
  verifyAmuxPreparedCheckout } from "./ideaTrackedCheckoutSandbox.mjs";
import { launchAmuxV19TracedSandbox } from
  "./ideaTrackedCheckoutTraceRunner.mjs";
import { amuxV19ChannelAdmits, amuxV19CliChannel,
  planAmuxV19ChannelSandbox } from "./ideaV19CliChannels.mjs";
import { amuxV19OutputRevealsSecret, removeAmuxV19StagedAuth,
  removeAmuxV19StagedInstall, stageAmuxV19ChannelAuth,
  stageAmuxV19ChannelInstall, verifyAmuxV19StagedChannel } from
  "./ideaV19CliChannelHost.mjs";
import { createAmuxV19ChannelStreamObserver } from
  "./ideaV19CliChannelOutput.mjs";

export const AMUX_V19_TRACKED_CHECKOUT_CLI_ENV =
  "TOMVERSE_AMUX_V19_TRACKED_CHECKOUT_CLI";
/** Every unknown outcome names why in one fixed word (`reason`); diagnostic
 * mode adds the failure stage and the child's counts. */
const unknown = (reason, cliStarted = false, failureStage = null,
  diagnostics = null) => ({
  kind: "outcome_unknown", reason, cliStarted,
  ...(failureStage ? { failureStage } : {}),
  ...(diagnostics ? { childExitCode: diagnostics.childExitCode,
    approvedConnects: diagnostics.approvedConnects,
    deniedConnects: diagnostics.deniedConnects,
    ...(diagnostics.stderrClass ? {
      stderrClass: diagnostics.stderrClass } : {}),
    ...(diagnostics.cliError ? { cliError: diagnostics.cliError } : {}),
    ...(diagnostics.parserReason ? { parserReason: diagnostics.parserReason } : {}),
    // Local-only names behind a parser refusal; present only when the
    // diagnostic-detail switch is on. The cycle writes it to a local file.
    ...(diagnostics.diagnosticDetail ? {
      diagnosticDetail: diagnostics.diagnosticDetail } : {}) } : {}),
});
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

/** Polls during checkout and staging under the attempt's stop rule
 * (ideaLocalAppRequest.mjs): an explicit stop, or the contact limit with no
 * answer, aborts the checkout; a short drop does not. */
function watchStopDuringCheckout(stopCheck, contact, onStop) {
  const controller = new AbortController();
  let closed = false;
  let timer;
  const poll = async () => {
    if (closed) return;
    const reason = await pollAmuxV19Stop(stopCheck, contact, controller.signal);
    if (closed) return;
    if (reason) {
      onStop(reason);
      controller.abort();
    } else timer = setTimeout(() => { void poll(); }, STOP_POLL_INTERVAL_MS);
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

/** One read-only CLI attempt over exact fixed-SHA source roots, on the
 * reservation's subscription channel (`provider`, default anthropic). The app
 * must first own admission, budget reservation and stop state. It never writes
 * a result to the app and its independent switch defaults closed. */
export async function runAmuxV19TrackedCheckoutAnalysis(input) {
  const provider = input?.provider ?? "anthropic";
  const channel = amuxV19CliChannel(provider);
  const egressHosts = channel?.pinned
    ? amuxV4ApprovedAnalysisCliForModel(input?.modelId)?.egressHosts
    : channel?.egressHosts;
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
      !channel || !amuxV19ChannelAdmits({ provider, modelId: input?.modelId,
        reasoningEffort: input?.reasoningEffort }) ||
      !Array.isArray(egressHosts) || egressHosts.length < 1 ||
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
  // One contact record per attempt. Before the CLI, every gate needs an
  // explicit continue; while it runs, only an explicit stop or the contact
  // limit stops it. The first reason seen is the one reported.
  const contact = createAmuxV19StopContact();
  const detail = input.diagnostic === true && input.diagnosticDetail === true;
  let stopReason = null;
  const gate = async (signal) => {
    let reason = signal?.aborted ? "stop_aborted"
      : await confirmAmuxV19Continue(input.stopCheck, contact, signal);
    if (!reason && signal?.aborted) reason = "stop_aborted";
    if (reason) stopReason ??= reason;
    return reason ? stopReason : null;
  };
  const before = await gate();
  if (before) return unknown(before);

  let cliStarted = false;
  const connectCounts = { approved: 0, denied: 0 };
  const watcher = watchStopDuringCheckout(input.stopCheck, contact,
    (reason) => { stopReason ??= reason; });
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
    let installPath;
    let install;
    let auth;
    let proxy;
    let listening = false;
    let child;
    let traced;
    const connections = new Set();
    let failure;
    try {
      const checkedOut = await gate(watcher.signal);
      if (checkedOut) return unknown(checkedOut);
      socketDirectory = await mkdtemp("/tmp/amux-v4-socket-");
      cliDirectory = await mkdtemp("/tmp/amux-v4-cli-");
      socketPath = join(socketDirectory, "proxy.sock");
      await Promise.all([chmod(socketDirectory, 0o700),
        chmod(cliDirectory, 0o700)]);
      let cliSha256;
      let sandboxArgs;
      if (channel.pinned) {
        cliPath = join(cliDirectory, "claude");
        const stagedCli = await stageAmuxV19ClaudeCli(cliPath);
        // The stager also returns the dedicated Max OAuth token path. The binary
        // verifier accepts only path and digest; auth is checked separately.
        const cliMount = { path: stagedCli.path, sha256: stagedCli.sha256 };
        cliSha256 = stagedCli.sha256;
        sandboxArgs = () => verifiedAmuxTrackedCheckoutSandbox({
          socketDirectory, cliMount, authPath: stagedCli.authPath,
          checkoutDirectory: checkout.directory, modelId: input.modelId,
          reasoningEffort: input.reasoningEffort,
        }, checkout);
      } else {
        // Set before staging so a partial copy is still removed below.
        installPath = join(cliDirectory, channel.staged);
        install = await stageAmuxV19ChannelInstall(provider, cliDirectory);
        auth = await stageAmuxV19ChannelAuth(provider);
        cliSha256 = install.sha256;
        sandboxArgs = async () => {
          const planned = planAmuxV19ChannelSandbox({ provider, socketDirectory,
            installPath: install.path, authFile: auth.file,
            checkoutDirectory: checkout.directory, modelId: input.modelId,
            reasoningEffort: input.reasoningEffort });
          await Promise.all([verifyAmuxV4SandboxSocket(socketDirectory),
            verifyAmuxPreparedCheckout(checkout),
            verifyAmuxV19StagedChannel({ installPath: install.path,
              authDirectory: auth.directory, authFile: auth.file })]);
          return planned.args;
        };
      }
      proxy = createAmuxV19EgressProxy(egressHosts, {
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
      const staged = await gate(watcher.signal);
      if (staged) return unknown(staged);
      const args = await sandboxArgs();
      const launching = await gate(watcher.signal);
      if (launching) return unknown(launching);
      watcher.close();
      traced = await launchAmuxV19TracedSandbox({
        args, directory: checkout.directory, files: checkout.files,
        diagnostic: input.diagnostic === true, detail,
      });
      child = traced.child;
      // A PID is available synchronously when the host process started. Treat
      // even an immediate sandbox/CLI failure as possible provider usage.
      cliStarted = Number.isSafeInteger(child.pid) && child.pid > 0;
      child.once("spawn", () => { cliStarted = true; });
      const observed = await awaitAmuxTrackedCheckoutChild({
        child, prompt: input.prompt,
        diagnostic: input.diagnostic === true, detail,
        // The child runner kills the process group on `true`. Its signal
        // aborts only once the child has closed, which is not a stop.
        stopCheck: async (signal) => {
          const reason = await pollAmuxV19Stop(input.stopCheck, contact, signal);
          if (reason && reason !== "stop_aborted") stopReason ??= reason;
          return reason !== null;
        },
        directory: checkout.directory, files: checkout.files,
        modelId: input.modelId, provider,
        ...(channel.pinned ? {} : {
          createObserver: createAmuxV19ChannelStreamObserver }),
        finishOpenTrace: (exit) => traced.finishTrace(exit),
      });
      if (observed.kind !== "verified_success") return unknown(
        stopReason ?? "cli_unverified", cliStarted,
        input.diagnostic === true ? observed.failureStage ??
          "parser_rejected" : null,
        input.diagnostic === true ? {
          childExitCode: observed.childExitCode ?? null,
          approvedConnects: connectCounts.approved,
          deniedConnects: connectCounts.denied,
          stderrClass: observed.stderrClass ?? null,
          cliError: observed.cliError ?? null,
          parserReason: observed.parserReason ?? null,
          diagnosticDetail: detail ? observed.diagnosticDetail ?? null : null,
        } : null);
      // The credential boundary: an answer that repeats a staged credential
      // never leaves the runner.
      if (auth && amuxV19OutputRevealsSecret(observed.rawModelOutput,
        auth.secrets)) return unknown("secret_in_output", cliStarted,
        input.diagnostic === true ? "secret_in_output" : null);
      // A fresh confirmation, not an earlier poll's reason: the answer is
      // released only while the app still allows this claim.
      const released = await confirmAmuxV19Continue(input.stopCheck, contact);
      if (released) return unknown(released, cliStarted,
        input.diagnostic === true ? "post_result_stop" : null);
      const { modelAttestation, ...verified } = observed;
      return { ...verified, cliStarted,
        // Recorded with the result: the channel, whether its CLI named the
        // model that answered, and the sha256 of the exact CLI copy that ran.
        cliAttestation: Object.freeze({ provider,
          modelAttestation: channel.pinned ? "served" : modelAttestation,
          cliSha256 }),
        ...(multiple ? { references: checkout.references } : {
          commitSha: input.commitSha,
          excludedCount: checkout.excludedCount,
          excludedPathDigest: checkout.excludedPathDigest,
          excludedReasons: checkout.excludedReasons,
        }) };
    } catch (error) {
      failure = error;
      return unknown("host_error", cliStarted,
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
      if (installPath) await cleanup(() => removeAmuxV19StagedInstall(installPath));
      if (auth) await cleanup(() => removeAmuxV19StagedAuth(auth));
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
         error.code === "invalid_tree")) return unknown(
      stopReason ?? "checkout_unavailable", cliStarted);
    throw new AmuxTrackedCheckoutHostError(error, cliStarted);
  } finally { watcher.close(); }
}
