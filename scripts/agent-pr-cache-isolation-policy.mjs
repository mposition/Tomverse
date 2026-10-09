/**
 * Whether any credentialed job that can run on the engineering agent's own pull
 * request restores an Actions cache.
 *
 * This is a narrower question than the one
 * scripts/check-credential-cache-separation.mjs asks, and it is narrower in one
 * direction while being stronger in another.
 *
 * That check refuses `unverified` and `unreadable` caches in any credentialed
 * job, wherever the job lives, and permits `verified_package_manager` -- the
 * package manager's own cache, which `npm ci` compares against the lockfile.
 * This one looks only at workflows an event the agent raises reaches, and there
 * it refuses **every** kind, the verified one included. The lockfile comparison
 * is not a defence against this subject: the agent can change
 * `package-lock.json` in its own pull request, and the integrity comparison
 * then agrees with whatever it put there.
 *
 * The question exists because docs/policy/engineering-agent.md §5's cache
 * isolation record has to establish three directions, and the third one is
 * open. GitHub's cache scoping closes a pull request's entries to other refs,
 * but the same rule says re-runs of that pull request can restore them. So the
 * agent's own pull request is the direction isolation cannot answer for, and
 * the record's third sentence rests on "no credentialed cache-restoring job
 * runs there today" instead. Nothing was keeping that true
 * (.github/audits/actions-cache-poisoning-audit-2026-10-03.md P7).
 *
 * Judgement is lib/agentCredentialReachability.ts. This module takes the
 * analysis that module produced and does not recompute reachability, credential
 * status or cache kinds: the audit's P3 gives the reason, and AGENTS.md asks
 * the same of the PACKAGE-01 metric -- one judge, so two numbers cannot drift.
 *
 * It reads nothing and prints nothing. The caller prints, and prints counts:
 * the repository is public and docs/policy/engineering-agent.md §16 keeps the
 * list of unresolved reachability targets out of it.
 */

/**
 * Judge an analysis produced by `analyseCredentialReachability`.
 *
 * The analysis must have been taken with `cacheIsolationRecorded: false`.
 * Passing `true` suppresses the cache reasons entirely, which would make this
 * judgement blind at exactly the moment the record it supports gets written --
 * so the caller's duty is to pass `false`, and `unanalysable` is the answer
 * here when there is no evidence either way.
 *
 * @param {{
 *   status: string,
 *   problems?: ReadonlyArray<unknown>,
 *   reasons?: ReadonlyArray<{ workflowPath: string, jobId: string | null, reason: string, cacheKinds?: ReadonlyArray<string> }>,
 *   reachedWorkflows?: ReadonlyArray<string>,
 *   credentialedJobs?: ReadonlyArray<{ workflowPath: string, jobId: string }>,
 * }} analysis
 */
export const judgeAgentPrCacheIsolation = (analysis) => {
  if (analysis === null || typeof analysis !== "object") {
    return { status: "unanalysable", problemCount: 1 };
  }
  if (analysis.status !== "analysed") {
    return { status: "unanalysable", problemCount: analysis.problems?.length ?? 1 };
  }
  // A result that cannot say which workflows are reached cannot answer this
  // question, and answering "none" from a missing field would be a pass
  // invented out of nothing.
  if (!Array.isArray(analysis.reachedWorkflows) || !Array.isArray(analysis.reasons)) {
    return { status: "unanalysable", problemCount: 1 };
  }

  const reached = new Set(analysis.reachedWorkflows);
  const offenders = analysis.reasons
    .filter((reason) => reason.reason === "credential_job_restores_cache" && reached.has(reason.workflowPath))
    .map((reason) => ({
      workflowPath: reason.workflowPath,
      jobId: reason.jobId,
      cacheKinds: [...(reason.cacheKinds ?? [])],
    }));

  const kindCounts = new Map();
  for (const offender of offenders) {
    const key = offender.cacheKinds.join("+") || "(none)";
    kindCounts.set(key, (kindCounts.get(key) ?? 0) + 1);
  }

  return {
    status: "judged",
    /** True when no credentialed job in a reached workflow restores any cache. */
    held: offenders.length === 0,
    offenders,
    reachedWorkflowCount: reached.size,
    /** Credentialed jobs inside reached workflows -- the population this asks about. */
    credentialedJobsInReachedCount: (analysis.credentialedJobs ?? []).filter((job) =>
      reached.has(job.workflowPath),
    ).length,
    /** Cache-restoring credentialed jobs anywhere, for the contrast with the narrow count. */
    cacheRestoringJobsAnywhereCount: analysis.reasons.filter(
      (reason) => reason.reason === "credential_job_restores_cache",
    ).length,
    kindDistribution: [...kindCounts].sort().map(([kind, count]) => `${kind}=${count}`).join(", "),
  };
};
