/**
 * CI admission's judgements (docs/policy/qa-release-agent.md section 8 item
 * 13). GitHub hands runners out per job, so a pull request whose later jobs
 * queue behind every newcomer's first jobs finishes late, and so does every
 * other one. Admission keeps finished pull requests in draft (draft runs no
 * CI) while they wait in line, and marks the head of the line ready for
 * review only when the account's concurrent-job limit has room for it.
 *
 * Owner decisions 2026-10-20: a pull request joins the line with the
 * `ci:queued` label; order is hotfix, owner priority label, main release,
 * develop, then the time the label was added; a smaller pull request may use
 * room the head of the line does not fit, until the head has waited 20
 * minutes; pushes to develop and main are never held, so a reserve of runners
 * stays free for them.
 *
 * Pure: no clock, network or database. The round
 * (lib/qaReleaseCiAdmissionService.ts) passes what it read.
 */

export const QA_RELEASE_CI_QUEUED_LABEL = "ci:queued";
export const QA_RELEASE_CI_PRIORITY_LABEL = "ci:priority";

export type QaReleaseCiAdmissionMode = "off" | "shadow" | "on";

/** The mode, or null when the value is not one of the three. Undeclared or empty is off. */
export function parseQaReleaseCiAdmissionMode(text: string | undefined): QaReleaseCiAdmissionMode | null {
  const value = (text ?? "").trim();
  if (value === "") return "off";
  return value === "off" || value === "shadow" || value === "on" ? value : null;
}

export const QA_RELEASE_CI_ADMISSION_CONFIG = Object.freeze({
  /** GitHub Pro's concurrent-job limit for standard hosted runners. */
  capacity: 40,
  /** Kept free for develop and main pushes, which deploy and are never held. */
  reserve: 12,
  /** After this long at the head of the line, smaller pull requests stop passing it. */
  starvationMs: 20 * 60 * 1000,
  /** Pull requests admitted per poll, so the next poll sees their jobs before admitting more. */
  maxPerPoll: 2,
  /** How long an admission counts against the room before its jobs are all visible. */
  settleMs: 10 * 60 * 1000,
  /**
   * Jobs one pull request is expected to start, by class: measured on
   * 2026-10-20 (develop pull requests 14-15 jobs, main release 37-38).
   */
  estimate: Object.freeze({ hotfix: 38, priority: 15, release: 38, develop: 15 }),
});

export type QaReleaseCiAdmissionConfig = typeof QA_RELEASE_CI_ADMISSION_CONFIG;

export type QaReleaseCiQueuedPullRequest = {
  number: number;
  nodeId: string;
  draft: boolean;
  labels: readonly string[];
  base: string;
  head: string;
  headSha: string;
  /** When `ci:queued` was last added (ISO); the pull request's creation time when unknown. */
  queuedAt: string;
};

export type QaReleaseCiClass = "hotfix" | "priority" | "release" | "develop";

const RANK: Record<QaReleaseCiClass, number> = { hotfix: 0, priority: 1, release: 2, develop: 3 };

/** The pull request's place in line, or null when admission does not handle it. */
export function classifyQaReleaseCiPullRequest(pr: Pick<QaReleaseCiQueuedPullRequest, "base" | "head" | "labels">): QaReleaseCiClass | null {
  if (pr.base === "main" && pr.head.startsWith("hotfix/")) return "hotfix";
  if (pr.base !== "main" && pr.base !== "develop") return null; // stacked: waits for the pull request below it
  if (pr.labels.includes(QA_RELEASE_CI_PRIORITY_LABEL)) return "priority";
  return pr.base === "main" ? "release" : "develop";
}

export type QaReleaseCiLineEntry = QaReleaseCiQueuedPullRequest & { class: QaReleaseCiClass; estimate: number };

/** Draft pull requests labelled `ci:queued`, in admission order. */
export function qaReleaseCiLine(
  pulls: readonly QaReleaseCiQueuedPullRequest[],
  config: QaReleaseCiAdmissionConfig = QA_RELEASE_CI_ADMISSION_CONFIG,
): QaReleaseCiLineEntry[] {
  const line: QaReleaseCiLineEntry[] = [];
  for (const pr of pulls) {
    if (!pr.draft || !pr.labels.includes(QA_RELEASE_CI_QUEUED_LABEL)) continue;
    if (!Number.isInteger(pr.number) || pr.number < 1 || Number.isNaN(Date.parse(pr.queuedAt))) continue;
    const cls = classifyQaReleaseCiPullRequest(pr);
    if (cls === null) continue;
    line.push({ ...pr, class: cls, estimate: config.estimate[cls] });
  }
  return line.sort(
    (a, b) => RANK[a.class] - RANK[b.class] || Date.parse(a.queuedAt) - Date.parse(b.queuedAt) || a.number - b.number,
  );
}

/** A queued or running job anywhere in the repository. */
export type QaReleaseCiActiveJob = { headSha: string };

/** A pull request this round already admitted (or, in shadow, would have). */
export type QaReleaseCiAdmission = { number: number; headSha: string; estimate: number; atMs: number };

export type QaReleaseCiDecision = {
  /** Jobs running or queued, plus the not-yet-visible share of recent admissions. */
  committed: number;
  /** Room left after this poll's admissions. */
  free: number;
  admit: QaReleaseCiLineEntry[];
  /** The head of the line when it did not fit, and whether it has waited past the starvation limit. */
  blocked: { number: number; waitedMs: number; starving: boolean } | null;
  waiting: number;
};

export function decideQaReleaseCiAdmission(input: {
  line: readonly QaReleaseCiLineEntry[];
  activeJobs: readonly QaReleaseCiActiveJob[];
  recent: readonly QaReleaseCiAdmission[];
  nowMs: number;
  config?: QaReleaseCiAdmissionConfig;
}): QaReleaseCiDecision {
  const config = input.config ?? QA_RELEASE_CI_ADMISSION_CONFIG;
  // A pull request larger than the whole admissible room (a main release
  // starts more jobs than capacity minus reserve) fits once that room is
  // empty; GitHub queues the rest of its jobs as it would anyway.
  const room = config.capacity - config.reserve;
  const size = (estimate: number) => Math.min(estimate, room);
  const jobsBySha = new Map<string, number>();
  for (const job of input.activeJobs) jobsBySha.set(job.headSha, (jobsBySha.get(job.headSha) ?? 0) + 1);

  // An admitted pull request's jobs appear in waves (build, then shards, then
  // rollups); until it settles, the jobs it has not shown yet still count.
  const settling = input.recent.filter((a) => input.nowMs - a.atMs < config.settleMs);
  const pending = settling.reduce((sum, a) => sum + Math.max(0, size(a.estimate) - (jobsBySha.get(a.headSha) ?? 0)), 0);
  const committed = input.activeJobs.length + pending;
  let free = room - committed;

  const admitted = new Set(input.recent.map((a) => a.number));
  const admit: QaReleaseCiLineEntry[] = [];
  let blocked: QaReleaseCiDecision["blocked"] = null;
  let waiting = 0;
  for (const entry of input.line) {
    if (admitted.has(entry.number)) continue;
    if (admit.length < config.maxPerPoll && size(entry.estimate) <= free && !blocked?.starving) {
      admit.push(entry);
      free -= size(entry.estimate);
      continue;
    }
    waiting += 1;
    if (blocked === null) {
      const waitedMs = Math.max(0, input.nowMs - Date.parse(entry.queuedAt));
      blocked = { number: entry.number, waitedMs, starving: waitedMs >= config.starvationMs };
    }
  }
  return { committed, free, admit, blocked, waiting };
}
