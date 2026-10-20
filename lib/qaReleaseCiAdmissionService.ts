/**
 * One CI admission round (docs/policy/qa-release-agent.md section 8 item 13),
 * run by the merge lane service after its develop round and the release
 * train. The cron fires every 10 minutes; inside that run admission polls
 * once a minute until its deadline, so a runner that frees up is used within
 * about a minute rather than at the next cron.
 *
 * Each poll reads the repository's queued and running jobs and the open pull
 * requests, judges with lib/qaReleaseCiAdmissionCore.ts, and in `on` mode
 * marks the admitted drafts ready for review. That is the only GitHub write:
 * no label, comment or status. `shadow` mode judges and logs only. A failed
 * read ends the round without admitting; a failed write is reported and not
 * retried, and the next poll re-reads the pull request (a pull request that
 * did become ready is no longer a draft, so it drops out of the line).
 */
import {
  decideQaReleaseCiAdmission,
  qaReleaseCiLine,
  type QaReleaseCiActiveJob,
  type QaReleaseCiAdmission,
  type QaReleaseCiQueuedPullRequest,
} from "./qaReleaseCiAdmissionCore.ts";
import { decideQaReleaseCiAdmissionStart } from "./qaReleaseServiceEnvCore.ts";

export const QA_RELEASE_CI_ADMISSION_POLL_MS = 60 * 1000;

export type QaReleaseCiAdmissionPorts = {
  github: {
    activeJobs(): Promise<QaReleaseCiActiveJob[]>;
    queuedPullRequests(): Promise<QaReleaseCiQueuedPullRequest[]>;
    markReady(nodeId: string): Promise<void>;
  };
  now(): number;
  sleep(ms: number): Promise<void>;
  /** One line per poll: numbers and codes only, never a title or body. */
  log(entry: Record<string, unknown>): void;
};

export type QaReleaseCiAdmissionOutcome =
  | { exitCode: 0; admission: "disabled" }
  | { exitCode: 1; admission: "refused_to_start" }
  | {
      exitCode: 0 | 1;
      admission: "shadow" | "on";
      polls: number;
      admitted: number[];
      failures: string[];
    };

const code = (error: unknown) => (error instanceof Error ? error.message : "unknown").slice(0, 60);

export async function runQaReleaseCiAdmissionRound(
  env: Readonly<Record<string, string | undefined>>,
  ports: QaReleaseCiAdmissionPorts,
  deadlineMs: number,
): Promise<QaReleaseCiAdmissionOutcome> {
  const start = decideQaReleaseCiAdmissionStart(env);
  if (start.decision === "disabled") return { exitCode: 0, admission: "disabled" };
  if (start.decision === "refuse" || start.mode === "off") return { exitCode: 1, admission: "refused_to_start" };
  const mode = start.mode;

  const recent: QaReleaseCiAdmission[] = [];
  const failures: string[] = [];
  let polls = 0;
  for (;;) {
    const nowMs = ports.now();
    if (nowMs >= deadlineMs) break;
    polls += 1;
    let activeJobs: QaReleaseCiActiveJob[];
    let pulls: QaReleaseCiQueuedPullRequest[];
    try {
      [activeJobs, pulls] = await Promise.all([ports.github.activeJobs(), ports.github.queuedPullRequests()]);
    } catch (error) {
      failures.push(`read:${code(error)}`);
      ports.log({ admission: mode, poll: polls, outcome: "read_failed", failure: code(error) });
      break;
    }
    const line = qaReleaseCiLine(pulls);
    const decision = decideQaReleaseCiAdmission({ line, activeJobs, recent, nowMs });
    const admittedNow: number[] = [];
    for (const entry of decision.admit) {
      if (mode === "on") {
        try {
          await ports.github.markReady(entry.nodeId);
        } catch (error) {
          failures.push(`ready:${entry.number}:${code(error)}`);
          continue;
        }
      }
      recent.push({ number: entry.number, headSha: entry.headSha, estimate: entry.estimate, atMs: nowMs });
      admittedNow.push(entry.number);
    }
    ports.log({
      admission: mode,
      poll: polls,
      activeJobs: activeJobs.length,
      committed: decision.committed,
      free: decision.free,
      line: line.length,
      admitted: admittedNow,
      blocked: decision.blocked,
    });
    if (ports.now() + QA_RELEASE_CI_ADMISSION_POLL_MS >= deadlineMs) break;
    await ports.sleep(QA_RELEASE_CI_ADMISSION_POLL_MS);
  }
  return {
    exitCode: failures.length === 0 ? 0 : 1,
    admission: mode,
    polls,
    admitted: recent.map((a) => a.number),
    failures,
  };
}
