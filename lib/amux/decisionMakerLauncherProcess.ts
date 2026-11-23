import { spawn, type ChildProcess } from "node:child_process";

import {
  DM_LAUNCH_OUTPUT_MAX_BYTES,
  DM_LAUNCH_STDOUT_MAX_BYTES,
  dmClassifyProcess,
  dmExecutionPlan,
  dmToolSummary,
  isDmLauncherInstance,
  type DmCleanupOutcome,
  type DmCommand,
  type DmExecutionPlan,
  type DmLaunchResult,
  type DmProcessObservation,
  type DmToolSummary,
} from "./decisionMakerLauncherCore.ts";
import {
  DM_SYSTEM_HOST,
  dmCleanupVendor,
  dmCreateTemporaryDirectory,
  dmHostPath,
  dmPreflightRefusals,
  dmReadRequestOutput,
  type DmLauncherHost,
} from "./decisionMakerLauncherFs.ts";
import {
  dmInstallWorkDependencies,
  dmPrepareWorkDirectory,
  dmWatchWorkDisk,
  type DmDependencySummary,
  type DmWorkOptions,
} from "./decisionMakerWorkCopy.ts";

/**
 * The AMUX Decision Maker launcher's process half, the minimum:
 * docs/policy/amux-decision-maker.md policy version 2, §5 ("hard timeout",
 * "요청 디렉터리 삭제") and §5a, stage S2-3a. It runs as the vendor account.
 *
 * One call is one request: copy the payload, plan, preflight (every check,
 * all reported), and only on an empty refusal list make the account's
 * temporary directory, copy the workspace into its work directory with the
 * command jail beside it and install the dependencies
 * (lib/amux/decisionMakerWorkCopy.ts), and start the planned command with the
 * copied payload on stdin; kill the process group at the hard timeout; read the result from
 * its one place; and on every exit path -- refusal, spawn failure, a fault in
 * this module, a timeout -- delete the temporary directory and the account's
 * CLI state and verify that nothing is left. The report carries the result
 * and the cleanup outcome separately: `cleanup_unknown` is the broker's to
 * report (§5 latches the instance `off`), whatever the result.
 *
 * The request directory is the broker's: the broker deletes it with
 * `dmCleanupRequestDirectory()` (lib/amux/decisionMakerLauncherFs.ts) after
 * this returns, on every path. This function never throws for anything a
 * request can cause, so that call is always reached; it throws only when a
 * caller passes a test seam on the system host.
 *
 * Not here: the broker daemon, the bridge socket, the app routes, the
 * snapshot (S2b), the installation (root-owned files, accounts, units,
 * sudoers). The process is started detached in its own process group so the
 * whole group can be killed; if this launcher itself dies, the group
 * outlives it, so the unit that runs the launcher must contain it (next
 * slice).
 */

/**
 * §5's hard timeout: the DM process is killed after two hours (owner
 * direction 2026-11-16: a DM reads its workspace the way a local CLI does, so
 * its run has the time a long local run has; it was 30 minutes). Not longer:
 * the relay carries one question at a time and waits for this run's answer,
 * so a CLI that hangs holds every other question and delivery until it is
 * killed. The unit's `RuntimeMaxSec` is the backstop
 * (DM_LAUNCHER_UNIT_RUNTIME_MAX_MS).
 */
export const DM_LAUNCH_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** How long stdout may stay open after the process exited and its group was killed. Not in the policy. */
export const DM_LAUNCH_STDOUT_CLOSE_GRACE_MS = 5_000;

export type DmLaunchInput = {
  instance: unknown;
  /** The app's request id. The request's two directories derive from it. */
  requestId: unknown;
  /** The transmissions route's recorded answer (lib/amux/decisionMakerLauncherCore.ts `DmTransmitIntentEvidence`). */
  evidence: unknown;
  /** K_R, from the assignment response. */
  requestKey: unknown;
  /** The bytes whose digest the intent recorded. Copied once, at the call; later changes to it are not sent. */
  payload: Uint8Array;
};

/**
 * `tools`: what the CLI's tools did (counts only); absent when no process ran
 * or the CLI reports none. `dependencies`: what the launcher installed in the
 * work directory (codes only); absent when it made none.
 */
export type DmLaunchReport = {
  result: DmLaunchResult;
  cleanup: DmCleanupOutcome;
  tools?: DmToolSummary;
  dependencies?: DmDependencySummary;
};

export type DmLaunchOptions = {
  host?: DmLauncherHost;
  /** A test host only. */
  timeoutMs?: number;
  /** A test host only. */
  expectedExecutableSha256?: string;
  /** Test host only: the work directory's jail check and jailed steps. */
  work?: DmWorkOptions;
};

const timeoutFor = (host: DmLauncherHost, override: number | undefined) => {
  if (override === undefined) return DM_LAUNCH_HARD_TIMEOUT_MS;
  if (host.root === null) throw new Error("AMUX Decision Maker hard timeout is fixed on the system host");
  if (!Number.isSafeInteger(override) || override < 1) throw new Error("AMUX Decision Maker timeout must be positive");
  return override;
};

const killGroup = (child: ChildProcess) => {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
};

const runProcess = (
  host: DmLauncherHost,
  plan: DmExecutionPlan,
  command: DmCommand,
  payload: Buffer,
  timeoutMs: number,
  /** The disk watch: kills the whole group, like the hard timeout. */
  stopSignal?: AbortSignal,
): Promise<DmProcessObservation> =>
  new Promise((resolve) => {
    let spawned = false;
    let timedOut = false;
    let stdinFailed = false;
    let stdoutTruncated = false;
    let stdoutClosed = false;
    let stdoutBytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const observe = (exitCode: number | null, signal: string | null): DmProcessObservation => ({
      spawned,
      timedOut,
      exitCode,
      signal,
      stdinFailed,
      stdout: Buffer.concat(chunks),
      stdoutTruncated,
      stdoutClosed,
      outputFile: dmReadRequestOutput(host, plan, DM_LAUNCH_OUTPUT_MAX_BYTES),
    });

    let child: ChildProcess;
    try {
      child = spawn(dmHostPath(host, command.executable), command.argv.slice(1), {
        argv0: command.argv[0],
        cwd: dmHostPath(host, plan.workingDirectory),
        // Exactly the fixed variables (§5a). Next's augmentation makes
        // ProcessEnv require NODE_ENV; adding it would break the fixed
        // environment, so only the type is widened here.
        env: Object.fromEntries(command.environment) as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve(observe(null, null));
      return;
    }

    let timer: NodeJS.Timeout | null = null;
    const stdoutDone = new Promise<void>((done) => {
      child.stdout?.once("close", () => {
        stdoutClosed = true;
        done();
      });
    });
    const stdinDone = new Promise<void>((done) => {
      if (!child.stdin) return done();
      child.stdin.once("close", () => done());
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      if (stdoutBytes + chunk.length > DM_LAUNCH_STDOUT_MAX_BYTES) {
        stdoutTruncated = true;
        chunks.length = 0;
        return;
      }
      stdoutBytes += chunk.length;
      chunks.push(chunk);
    });

    child.once("error", () => {
      if (spawned || settled) return;
      settled = true;
      resolve(observe(null, null));
    });

    child.once("spawn", () => {
      spawned = true;
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child);
      }, timeoutMs);
      if (stopSignal?.aborted) killGroup(child);
      stopSignal?.addEventListener("abort", () => killGroup(child), { once: true });
      child.stdin?.on("error", () => {
        stdinFailed = true;
      });
      // The launcher's own copy, the one the intent check digested.
      child.stdin?.end(payload);
    });

    child.once("exit", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      // Nothing of the group may outlive the request (§5a "강제 종료" observed none; this makes it so).
      killGroup(child);
      let graceTimer: NodeJS.Timeout | null = null;
      const grace = new Promise<void>((done) => {
        graceTimer = setTimeout(done, DM_LAUNCH_STDOUT_CLOSE_GRACE_MS);
      });
      void Promise.race([Promise.all([stdoutDone, stdinDone]), grace]).then(() => {
        if (graceTimer) clearTimeout(graceTimer);
        if (!stdoutClosed) child.stdout?.destroy();
        if (settled) return;
        settled = true;
        resolve(observe(exitCode, signal));
      });
    });
  });

/**
 * One request, start to the vendor account's cleanup. Never throws for
 * anything the request can cause; a fault here is `launcher_fault`, and
 * cleanup still runs.
 */
export async function launchDecisionMaker(
  input: DmLaunchInput,
  options: DmLaunchOptions = {},
): Promise<DmLaunchReport> {
  // §2-4 "그 바이트 그대로": one copy, taken before anything asynchronous, is
  // what the intent check digests and what stdin receives. The caller's
  // buffer is not read again.
  const payload: Buffer | null = input.payload instanceof Uint8Array ? Buffer.from(input.payload) : null;
  const host = options.host ?? DM_SYSTEM_HOST;
  // The hard timeout counts from here: copying the workspace and installing
  // its dependencies spend part of it, so the unit's RuntimeMaxSec stays the backstop.
  const startedAt = Date.now();
  // Every test seam is refused on the system host before anything is read or deleted.
  const timeoutMs = timeoutFor(host, options.timeoutMs);
  if (options.expectedExecutableSha256 !== undefined && host.root === null) {
    throw new Error("AMUX Decision Maker executable sha256 is fixed on the system host");
  }
  if (options.work !== undefined && host.root === null) {
    throw new Error("AMUX Decision Maker work directory steps are fixed on the system host");
  }
  if (!isDmLauncherInstance(input.instance)) {
    return {
      result: { outcome: "refused", refusals: ["instance_unknown"] },
      cleanup: { status: "cleanup_unknown", residue: [{ kind: "instance_unknown", path: "" }] },
    };
  }
  const instance = input.instance;
  const planned = dmExecutionPlan(instance, input.requestId);
  if (!planned.ok) {
    return { result: { outcome: "refused", refusals: [planned.refusal] }, cleanup: dmCleanupVendor(host, instance, null) };
  }
  const { plan } = planned;
  const command: DmCommand = { executable: plan.executable, argv: plan.argv, environment: plan.environment };
  let result: DmLaunchResult;
  let tools: DmToolSummary | null = null;
  let dependencies: DmDependencySummary | null = null;
  try {
    const refusals = dmPreflightRefusals(
      host,
      { plan, command, evidence: input.evidence, requestKey: input.requestKey, payload },
      options.expectedExecutableSha256 === undefined ? {} : { expectedExecutableSha256: options.expectedExecutableSha256 },
    );
    const work = refusals.length > 0 || payload === null || !dmCreateTemporaryDirectory(host, plan)
      ? null
      : dmPrepareWorkDirectory(host, plan, options.work);
    if (refusals.length > 0) result = { outcome: "refused", refusals };
    else if (payload === null) result = { outcome: "refused", refusals: ["transmit_intent_mismatch"] };
    // No temporary directory, no copy of the workspace, or no jail: nothing starts (§0b-6).
    else if (work === null || !work.ok) {
      result = { outcome: "refused", refusals: [work?.ok === false && work.reason === "disk" ? "disk_space_low" : "request_directories_unusable"] };
    } else {
      const deadlineAt = startedAt + timeoutMs;
      // The copy is outside the request root's size-limited filesystem: from here the launcher bounds it.
      const stop = new AbortController();
      const watch = dmWatchWorkDisk(host, plan, () => stop.abort(), options.work);
      try {
        dependencies = await dmInstallWorkDependencies(host, plan, work, { deadlineAt, signal: stop.signal }, options.work);
        if (stop.signal.aborted) result = { outcome: "unavailable", reason: "disk_limit" };
        else {
          const observation = await runProcess(host, plan, command, payload, Math.max(1, deadlineAt - Date.now()), stop.signal);
          result = watch.exceeded() ? { outcome: "unavailable", reason: "disk_limit" } : dmClassifyProcess(plan.cli, observation);
          tools = dmToolSummary(plan.cli, observation.stdout);
        }
      } finally {
        watch.stop();
      }
    }
  } catch {
    result = { outcome: "unavailable", reason: "launcher_fault" };
  }
  const cleanup = dmCleanupVendor(host, instance, plan.requestId);
  return {
    result,
    cleanup,
    ...(tools === null ? {} : { tools }),
    ...(dependencies === null ? {} : { dependencies }),
  };
}
