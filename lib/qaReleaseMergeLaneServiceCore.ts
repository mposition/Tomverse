/**
 * One round of the QA-release merge lane service (docs/policy/qa-release-agent.md
 * version 4, sections 3 and 8). The service holds the GitHub App key, the
 * Railway read token and its own secret; it merges nothing it picked by
 * itself -- every merge rides on an instruction the app issued and consumed.
 *
 * A round does one of two things, never both (section 8 item 5):
 * - with an attempt open, it finishes or advances that attempt only -- the
 *   deployment outcome of a merge awaiting deploy, or the ordered re-read of
 *   an attempt whose result never arrived -- and ends;
 * - with none open and the lane free, it picks the oldest candidate, asks the
 *   app for an instruction, re-reads the pull request and its own switches,
 *   consumes the instruction, merges with the head pinned, checks where the
 *   merge landed and reports the result.
 *
 * Pure: every network call is a port, so the whole round is tested without
 * one. An unknown answer is never retried within the round (section 3): the
 * next round, or a person, finishes it.
 */
import {
  deploymentOutcome,
  inFlightDeployments,
  refusalReason,
  replacementCommits,
  skippedCommits,
} from "../scripts/merge-train-core.mjs";
import { type QaReleaseExclusion, judgeQaReleaseMergeLaneExclusion, type QaReleaseExclusionInput } from "./qaReleaseMergeLaneExclusionCore.ts";
import { type QaReleaseLanePullRequest, pickQaReleaseLaneCandidate } from "./qaReleaseMergeLaneCandidateCore.ts";
import { type QaReleaseDeployObservation, type QaReleaseMergeReport, qaReleaseDeployObservation } from "./qaReleaseMergeLaneReportCore.ts";
import { judgeQaReleaseMergeLanding } from "./qaReleaseMergeLaneRoundCore.ts";
import { decideQaReleaseServiceStart } from "./qaReleaseServiceEnvCore.ts";

/** `not_seen` waits this long after the merge, `in_progress`/`partial` this long (the merge train's defaults). */
export const QA_RELEASE_DEPLOY_NOT_SEEN_LIMIT_MS = 15 * 60 * 1000;
export const QA_RELEASE_DEPLOY_PROGRESS_LIMIT_MS = 120 * 60 * 1000;
/** An instruction with no result after its expiry and the service's hard timeout (section 8 item 5). */
export const QA_RELEASE_RESULT_SILENCE_MS = 12 * 60 * 1000;

/** A Railway deployment as the merge train reads it. */
export type QaReleaseDeployment = {
  serviceId: string;
  serviceName: string;
  status: string;
  createdAt: string;
  meta?: { commitHash?: string; branch?: string };
};

/** The lane as the app reads it, on the database clock. */
export type QaReleaseLaneState = {
  dbNowMs: number;
  latched: boolean;
  openAttempt: {
    id: string;
    state: "issued" | "consumed" | "awaiting_deploy";
    pullRequestNumber: number;
    headSha: string;
    mergeCommitSha: string | null;
    issuedAtMs: number;
    /** The consume time, or issue when it was never consumed: the earliest the merge can have happened. */
    mergeNotBeforeMs: number;
  } | null;
};

/** What GitHub says about one pull request, read fresh. */
export type QaReleasePullRead = QaReleaseLanePullRequest & {
  merged: boolean;
  mergeCommitSha: string | null;
};

export type QaReleaseMergeCall = { result: "merged"; sha: string } | { result: "refused" } | { result: "unknown" };

export type QaReleaseMergeLanePorts = {
  app: {
    readState: () => Promise<QaReleaseLaneState>;
    issue: (pullRequest: { pullRequestNumber: number; headSha: string }) => Promise<{ issued: true; attemptId: string } | { issued: false; reason: string }>;
    consume: (request: { attemptId: string; pullRequestNumber: number; headSha: string; base: string }) => Promise<{ consumed: boolean; reason?: string }>;
    report: (attemptId: string, report: QaReleaseMergeReport) => Promise<{ recorded: boolean; reason?: string }>;
  };
  github: {
    listOpenDevelopPulls: () => Promise<QaReleaseLanePullRequest[]>;
    /** The item 3 inputs for one pull request; the changed-file list is read to its last page. */
    exclusionInputs: (pull: QaReleaseLanePullRequest) => Promise<QaReleaseExclusionInput>;
    readPull: (number: number) => Promise<QaReleasePullRead | null>;
    /** The merge API with `sha` pinned to the head; never a merge without it. */
    merge: (number: number, headSha: string) => Promise<QaReleaseMergeCall>;
    /** compare/{sha}...develop: true when ahead or identical, false when not, null when unanswered. */
    onDevelop: (sha: string) => Promise<boolean | null>;
    /** Of `candidates`, the commits that contain `sha` (compare API). */
    commitsContaining: (sha: string, candidates: string[]) => Promise<Set<string>>;
    /** Of `commits`, those whose check runs were cancelled. */
    cancelledCommits: (commits: string[]) => Promise<Set<string>>;
  };
  railway: {
    /** Every staging service's recent deployments; null when unread. */
    stagingDeployments: () => Promise<QaReleaseDeployment[] | null>;
  };
};

export type QaReleaseMergeLaneRoundOutcome =
  | { exitCode: 0; outcome: "disabled" | "latched" | "hold" | "idle" | "waiting" | "attempt_in_flight" | "abandoned" }
  /** The pick the app declined: in S-M1 (lane switch off) this is the shadow judgement, compared with what people merged. */
  | { exitCode: 0; outcome: "instruction_refused"; pullRequestNumber: number; headSha: string; reason: string }
  | { exitCode: 0; outcome: "reported"; report: QaReleaseMergeReport["kind"]; detail: string }
  | { exitCode: 0; outcome: "merged"; pullRequestNumber: number }
  | { exitCode: 1; outcome: "refused_to_start" | "state_unknown" | "report_not_recorded" | "candidates_unknown" };

/**
 * A service name in the report's closed form: characters outside it become
 * "_", and a name that would not start with a letter or digit gets one.
 */
const observedServiceName = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9 ._-]/gu, "_");
  return (/^[A-Za-z0-9]/.test(cleaned) ? cleaned : `s${cleaned}`).slice(0, 64);
};

/**
 * What the lane saw, for the Admin screen only -- never the judgement, which
 * deploymentOutcome makes from the raw list. Every entry is put in the
 * report's closed form (lib/qaReleaseMergeLaneReportCore.ts), and an entry
 * that still does not fit -- a Railway status outside the closed set -- is
 * left out: the route refuses a whole report whose list does not validate,
 * and a refused report would leave the attempt neither latched nor closed.
 */
const observationOf = (deployments: QaReleaseDeployment[], sha: string): QaReleaseDeployObservation[] =>
  deployments
    .filter((deployment) => (deployment.meta?.commitHash ?? "").toLowerCase() === sha.toLowerCase() || deployment.meta?.branch === "develop")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .filter((deployment, index, all) => all.findIndex((other) => other.serviceId === deployment.serviceId) === index)
    .map((deployment) => ({
      service: observedServiceName(deployment.serviceName),
      status: deployment.status,
      commitSha: /^[0-9a-f]{40}$/.test((deployment.meta?.commitHash ?? "").toLowerCase())
        ? (deployment.meta?.commitHash ?? "").toLowerCase()
        : null,
    }))
    .filter((entry) => qaReleaseDeployObservation([entry]) !== null)
    .slice(0, 20);

async function sendReport(ports: QaReleaseMergeLanePorts, attemptId: string, report: QaReleaseMergeReport, detail: string): Promise<QaReleaseMergeLaneRoundOutcome> {
  try {
    const answer = await ports.app.report(attemptId, report);
    return answer.recorded
      ? { exitCode: 0, outcome: "reported", report: report.kind, detail }
      : { exitCode: 1, outcome: "report_not_recorded" };
  } catch {
    return { exitCode: 1, outcome: "report_not_recorded" };
  }
}

/** The deployment judgement for an attempt awaiting deploy (section 8 item 5). */
async function judgeAwaitingDeploy(
  ports: QaReleaseMergeLanePorts,
  attempt: NonNullable<QaReleaseLaneState["openAttempt"]>,
  dbNowMs: number,
): Promise<QaReleaseMergeLaneRoundOutcome> {
  const sha = attempt.mergeCommitSha ?? "";
  let deployments: QaReleaseDeployment[] | null = null;
  try {
    deployments = await ports.railway.stagingDeployments();
  } catch {
    deployments = null;
  }
  if (deployments === null) {
    return sendReport(ports, attempt.id, { kind: "deploy", outcome: "unreadable", observation: [] }, "railway_unreadable");
  }
  let containing: Set<string>;
  let cancelled: Set<string>;
  try {
    containing = await ports.github.commitsContaining(sha, replacementCommits(deployments, sha));
    cancelled = await ports.github.cancelledCommits(skippedCommits(deployments, sha, containing));
  } catch {
    return sendReport(ports, attempt.id, { kind: "deploy", outcome: "unreadable", observation: observationOf(deployments, sha) }, "github_unreadable");
  }
  const observation = observationOf(deployments, sha);
  const outcome = deploymentOutcome(deployments, sha, "develop", containing, cancelled).state as string;
  const waitedMs = dbNowMs - attempt.mergeNotBeforeMs;
  if (outcome === "succeeded" || outcome === "failed" || outcome === "unknown") {
    return sendReport(ports, attempt.id, { kind: "deploy", outcome, observation }, outcome);
  }
  const limit = outcome === "not_seen" ? QA_RELEASE_DEPLOY_NOT_SEEN_LIMIT_MS : QA_RELEASE_DEPLOY_PROGRESS_LIMIT_MS;
  if (waitedMs > limit) return sendReport(ports, attempt.id, { kind: "deploy", outcome: "wait_exceeded", observation }, outcome);
  return { exitCode: 0, outcome: "waiting" };
}

/** The ordered re-read of an issued or consumed attempt (section 8 item 5), at its first answering step. */
async function rereadAttempt(
  ports: QaReleaseMergeLanePorts,
  attempt: { id: string; pullRequestNumber: number },
): Promise<QaReleaseMergeLaneRoundOutcome> {
  let pull: QaReleasePullRead | null;
  try {
    pull = await ports.github.readPull(attempt.pullRequestNumber);
  } catch {
    pull = null;
  }
  // (1) unreadable: leave it open for the next round.
  if (pull === null) return { exitCode: 0, outcome: "waiting" };
  // (2) not merged, open or closed.
  if (!pull.merged) return sendReport(ports, attempt.id, { kind: "reread", result: "not_merged" }, "not_merged");
  // (3) merged onto another base.
  if (pull.baseRefName !== "develop") return sendReport(ports, attempt.id, { kind: "reread", result: "merged_off_develop" }, "merged_off_develop");
  // (4) merged onto develop: placed by the compare API's relation only.
  const sha = (pull.mergeCommitSha ?? "").toLowerCase();
  let onDevelop: boolean | null = null;
  if (/^[0-9a-f]{40}$/.test(sha)) {
    try {
      onDevelop = await ports.github.onDevelop(sha);
    } catch {
      onDevelop = null;
    }
  }
  if (onDevelop === true) return sendReport(ports, attempt.id, { kind: "reread", result: "merged_on_develop", mergeCommitSha: sha }, "merged_on_develop");
  return sendReport(ports, attempt.id, { kind: "reread", result: "merge_commit_off_develop" }, "merge_commit_off_develop");
}

export async function runQaReleaseMergeLaneRound(
  env: Readonly<Record<string, string | undefined>>,
  ports: QaReleaseMergeLanePorts,
): Promise<QaReleaseMergeLaneRoundOutcome> {
  const start = decideQaReleaseServiceStart("mergeLane", env);
  if (start === "refuse") return { exitCode: 1, outcome: "refused_to_start" };
  if (start === "disabled") return { exitCode: 0, outcome: "disabled" };

  let state: QaReleaseLaneState;
  try {
    state = await ports.app.readState();
  } catch {
    return { exitCode: 1, outcome: "state_unknown" };
  }

  // An open attempt is this round's whole business; a latch does not stop
  // its judgement (section 8 item 5), only new merges.
  const attempt = state.openAttempt;
  if (attempt) {
    if (attempt.state === "awaiting_deploy") return judgeAwaitingDeploy(ports, attempt, state.dbNowMs);
    // A latched lane issues nothing, so an issued or consumed attempt under a
    // latch is one whose merge result was unknown or never reported: re-read
    // it now. Unlatched, it may still be in another round's hands for twelve
    // minutes; after that, latch once as unreported.
    if (state.latched) return rereadAttempt(ports, attempt);
    if (state.dbNowMs - attempt.issuedAtMs <= QA_RELEASE_RESULT_SILENCE_MS) return { exitCode: 0, outcome: "attempt_in_flight" };
    return sendReport(ports, attempt.id, { kind: "unreported" }, "unreported");
  }
  if (state.latched) return { exitCode: 0, outcome: "latched" };

  let deployments: QaReleaseDeployment[] | null;
  try {
    deployments = await ports.railway.stagingDeployments();
  } catch {
    deployments = null;
  }
  if (deployments === null) return { exitCode: 1, outcome: "state_unknown" };
  if (inFlightDeployments(deployments).length > 0) return { exitCode: 0, outcome: "hold" };

  let pulls: QaReleaseLanePullRequest[];
  const exclusions = new Map<number, QaReleaseExclusion>();
  try {
    pulls = await ports.github.listOpenDevelopPulls();
    // Exclusion is judged only for pull requests the readiness rule passes,
    // oldest first, and the first clear one is the pick: no list is read for
    // a pull request that cannot be merged anyway.
    for (const pull of [...pulls].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number)) {
      if (pull.baseRefName !== "develop" || refusalReason(pull, "develop") !== null) continue;
      const judged = judgeQaReleaseMergeLaneExclusion(await ports.github.exclusionInputs(pull));
      exclusions.set(pull.number, judged);
      if (!judged.excluded) break;
    }
  } catch {
    return { exitCode: 1, outcome: "candidates_unknown" };
  }
  const { pick } = pickQaReleaseLaneCandidate(pulls, exclusions);
  if (pick === null) return { exitCode: 0, outcome: "idle" };

  const issued = await ports.app.issue({ pullRequestNumber: pick.number, headSha: pick.headRefOid }).catch(() => null);
  if (issued === null) return { exitCode: 1, outcome: "state_unknown" };
  if (!issued.issued) {
    return { exitCode: 0, outcome: "instruction_refused", pullRequestNumber: pick.number, headSha: pick.headRefOid, reason: issued.reason.slice(0, 64) };
  }
  const attemptId = issued.attemptId;

  // Re-read right before the merge (section 3 step 1, section 8 items 4 and 6):
  // the pull request as GitHub has it now, staging free, and this service's
  // own switches judged again. A difference on a pull request known to be
  // unmerged closes the attempt as not merged -- which it is -- rather than
  // leaving it to expire.
  const abandon = async () => {
    const recorded = await sendReport(ports, attemptId, { kind: "reread", result: "not_merged" }, "abandoned_before_merge");
    return recorded.exitCode === 0 ? ({ exitCode: 0, outcome: "abandoned" } as const) : recorded;
  };
  const fresh = await ports.github.readPull(pick.number).catch(() => null);
  // Unreadable: leave the attempt open; it expires unconsumed and a later
  // round's ordered re-read decides it (section 8 item 5).
  if (fresh === null) return { exitCode: 0, outcome: "attempt_in_flight" };
  // Merged by someone else meanwhile: that merge is tracked like any other,
  // through the ordered re-read -- never closed as not merged.
  if (fresh.merged) return rereadAttempt(ports, { id: attemptId, pullRequestNumber: pick.number });
  if (
    fresh.headRefOid !== pick.headRefOid ||
    fresh.baseRefName !== "develop" ||
    refusalReason(fresh, "develop") !== null
  ) {
    return abandon();
  }
  const freshDeployments = await ports.railway.stagingDeployments().catch(() => null);
  if (freshDeployments === null || inFlightDeployments(freshDeployments).length > 0) return abandon();
  if (decideQaReleaseServiceStart("mergeLane", env) !== "run") return abandon();

  const consumed = await ports.app
    .consume({ attemptId, pullRequestNumber: pick.number, headSha: pick.headRefOid, base: "develop" })
    .catch(() => null);
  if (consumed === null) return { exitCode: 1, outcome: "state_unknown" };
  if (!consumed.consumed) return abandon();
  // Judged once more right before the call (section 8 item 6).
  if (decideQaReleaseServiceStart("mergeLane", env) !== "run") {
    return sendReport(ports, attemptId, { kind: "merge", result: "refused" }, "switched_off_before_merge");
  }

  const call = await ports.github.merge(pick.number, pick.headRefOid).catch((): QaReleaseMergeCall => ({ result: "unknown" }));
  if (call.result === "refused") {
    // A refusal can be GitHub declining because someone else merged it in the
    // meantime: that merge is followed through the ordered re-read, so its
    // deployment is tracked, rather than closed as refused.
    // An unread pull request cannot rule that out, so it is unknown -- which
    // latches and leaves the attempt to the ordered re-read (section 8 item 5).
    const refusedPull = await ports.github.readPull(pick.number).catch(() => null);
    if (refusedPull === null) return sendReport(ports, attemptId, { kind: "merge", result: "unknown" }, "merge_refused_unread");
    if (refusedPull.merged) return rereadAttempt(ports, { id: attemptId, pullRequestNumber: pick.number });
    return sendReport(ports, attemptId, { kind: "merge", result: "refused" }, "merge_refused");
  }
  if (call.result === "unknown") return sendReport(ports, attemptId, { kind: "merge", result: "unknown" }, "merge_unknown");

  // Where did it land (section 3 step 4)? Anything but a clear yes latches.
  const after = await ports.github.readPull(pick.number).catch(() => null);
  const sha = (after?.mergeCommitSha ?? call.sha).toLowerCase();
  const onDevelop = /^[0-9a-f]{40}$/.test(sha) ? await ports.github.onDevelop(sha).catch(() => null) : null;
  const landing = judgeQaReleaseMergeLanding({
    merged: after ? after.merged : null,
    baseRefName: after ? after.baseRefName : null,
    mergeCommitSha: after?.mergeCommitSha ?? null,
    mergeCommitOnDevelop: onDevelop,
  });
  if (!landing.landed) return sendReport(ports, attemptId, { kind: "merge", result: "unknown" }, `landing_${landing.reason}`);
  const reported = await sendReport(ports, attemptId, { kind: "merge", result: "merged", mergeCommitSha: landing.mergeCommitSha }, "merged");
  return reported.exitCode === 0 ? { exitCode: 0, outcome: "merged", pullRequestNumber: pick.number } : reported;
}
