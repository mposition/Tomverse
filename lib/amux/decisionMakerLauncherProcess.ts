import { spawn, type ChildProcess } from "node:child_process";

import {
  DM_LAUNCH_OUTPUT_MAX_BYTES,
  DM_LAUNCH_STDOUT_MAX_BYTES,
  dmClassifyProcess,
  dmExecutionPlan,
  isDmLauncherInstance,
  type DmCleanupOutcome,
  type DmCommand,
  type DmExecutionPlan,
  type DmLaunchResult,
  type DmProcessObservation,
} from "./decisionMakerLauncherCore.ts";
import {
  DM_SYSTEM_HOST,
  dmCleanup,
  dmHostPath,
  dmPreflightRefusals,
  dmReadOutputFile,
  type DmLauncherHost,
} from "./decisionMakerLauncherFs.ts";

/**
 * The AMUX Decision Maker launcher's process half, the minimum:
 * docs/policy/amux-decision-maker.md policy version 2, §5 ("hard timeout",
 * "요청 디렉터리 삭제") and §5a, stage S2-3a.
 *
 * One call is one request: plan, preflight (every check, all reported), and
 * only on an empty refusal list start the planned command with the question
 * on stdin; kill the process group at the hard timeout; read the result from
 * its one place; and on every exit path -- refusal, spawn failure, a fault in
 * this module, a timeout -- delete the request's directories and the vendor
 * account's CLI state and verify that nothing is left. The report carries the
 * result and the cleanup outcome separately: `cleanup_unknown` is the
 * broker's to report (§5 latches the instance `off`), whatever the result.
 *
 * Not here: the broker daemon, the bridge socket, the app routes, the
 * snapshot (S2b), the installation (root-owned files, accounts, units,
 * sudoers). The process is started detached in its own process group so the
 * whole group can be killed; if this launcher itself dies, the group
 * outlives it, so the unit that runs the launcher must contain it (next
 * slice).
 */

/** §5: "질문당 30분이 지나면 DM 프로세스를 강제 종료한다". */
export const DM_LAUNCH_HARD_TIMEOUT_MS = 30 * 60 * 1000;

/** How long stdout may stay open after the process exited and its group was killed. Not in the policy. */
export const DM_LAUNCH_STDOUT_CLOSE_GRACE_MS = 5_000;

export type DmLaunchInput = {
  instance: unknown;
  paths: unknown;
  /** The transmissions route's recorded answer (lib/amux/decisionMakerLauncherCore.ts `DmTransmitIntentEvidence`). */
  evidence: unknown;
  /** K_R, from the assignment response. */
  requestKey: unknown;
  /** The exact bytes the process reads on stdin, and whose digest the intent recorded. */
  payload: Uint8Array;
};

export type DmLaunchReport = { result: DmLaunchResult; cleanup: DmCleanupOutcome };

export type DmLaunchOptions = {
  host?: DmLauncherHost;
  /** A test host only. */
  timeoutMs?: number;
  /** A test host only. */
  expectedExecutableSha256?: string;
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
  payload: Uint8Array,
  timeoutMs: number,
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
      outputFile:
        plan.cli === "codex" && plan.paths.outputFile !== null
          ? dmReadOutputFile(dmHostPath(host, plan.paths.outputFile), DM_LAUNCH_OUTPUT_MAX_BYTES)
          : null,
    });

    let child: ChildProcess;
    try {
      child = spawn(dmHostPath(host, command.executable), command.argv.slice(1), {
        argv0: command.argv[0],
        cwd: dmHostPath(host, plan.workingDirectory),
        env: Object.fromEntries(command.environment),
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
      child.stdin?.on("error", () => {
        stdinFailed = true;
      });
      child.stdin?.end(Buffer.from(payload));
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
 * One request, start to cleanup. Never throws for anything the request can
 * cause; a fault here is `launcher_fault`, and cleanup still runs.
 */
export async function launchDecisionMaker(
  input: DmLaunchInput,
  options: DmLaunchOptions = {},
): Promise<DmLaunchReport> {
  const host = options.host ?? DM_SYSTEM_HOST;
  // Both test seams are refused on the system host before anything is read or deleted.
  const timeoutMs = timeoutFor(host, options.timeoutMs);
  if (options.expectedExecutableSha256 !== undefined && host.root === null) {
    throw new Error("AMUX Decision Maker executable sha256 is fixed on the system host");
  }
  if (!isDmLauncherInstance(input.instance)) {
    return {
      result: { outcome: "refused", refusals: ["instance_unknown"] },
      cleanup: { status: "cleanup_unknown", residue: [{ kind: "instance_unknown", path: "" }] },
    };
  }
  const instance = input.instance;
  const planned = dmExecutionPlan(instance, input.paths);
  if (!planned.ok) {
    return { result: { outcome: "refused", refusals: [planned.refusal] }, cleanup: dmCleanup(host, instance, null) };
  }
  const { plan } = planned;
  const command: DmCommand = { executable: plan.executable, argv: plan.argv, environment: plan.environment };
  let result: DmLaunchResult;
  try {
    const refusals = dmPreflightRefusals(
      host,
      { plan, command, evidence: input.evidence, requestKey: input.requestKey, payload: input.payload },
      options.expectedExecutableSha256 === undefined ? {} : { expectedExecutableSha256: options.expectedExecutableSha256 },
    );
    result =
      refusals.length > 0
        ? { outcome: "refused", refusals }
        : dmClassifyProcess(plan.cli, await runProcess(host, plan, command, input.payload, timeoutMs));
  } catch {
    result = { outcome: "unavailable", reason: "launcher_fault" };
  }
  return { result, cleanup: dmCleanup(host, instance, plan.paths) };
}
