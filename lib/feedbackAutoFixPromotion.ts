import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  AUTOFIX_CASE_STATE,
  AUTOFIX_PROMOTION_OBSERVED_STATES,
  canTransitionAutoFixCase,
  isAutoFixFixingEnabled,
} from "@/lib/feedbackAutoFixCore";
import {
  changeManifestDigest,
  isApprovedChange,
  parseStoredChangeManifest,
  type ChangeManifestEntry,
} from "@/lib/feedbackAutoFixChangeManifest";
import {
  judgeDeploymentObservation,
  servingDeployment,
  type DeploymentPassObservation,
} from "@/lib/feedbackAutoFixDeploymentObservation";
import {
  deploymentProbeConfigurationProblems,
  observeDeployment,
  type PromotionEnvironment,
} from "@/lib/feedbackAutoFixDeploymentProbe";
import {
  autoFixGitHubRepository,
  buildPullRequestManifest,
  compareCommits,
  findPullRequestsByHead,
  getPullRequest,
  isAutoFixGitHubReadConfigured,
  type PullRequestFacts,
} from "@/lib/feedbackAutoFixGitHub";
import {
  NOTIFICATION_KIND,
  enqueueNotificationDelivery,
  type NotificationKind,
} from "@/lib/notificationDeliveries";

/**
 * Owner-approved promotion (docs/policy/trace-feedback-automation.md §9.3).
 *
 * Nothing in this module merges, pushes or deploys. A person merges the
 * develop PR and the main promotion PR in GitHub, under branch protection.
 * What this module does is decide, from facts it reads itself, what those
 * merges mean for the case:
 *
 *  - an owner's approval binds one develop PR head and one change manifest;
 *  - the develop merge counts only at exactly that head;
 *  - the main promotion PR counts only when its own manifest is exactly the
 *    approved change (same paths, same before and after blobs);
 *  - staging and production count only through judgeDeploymentObservation's
 *    control-plane-plus-samples rule across a stabilisation window.
 *
 * There are no workflow callbacks for any of this (independent review round 1,
 * N4/N5): the observer finds the promotion PR by its deterministic branch
 * name, and a workflow's failure is visible in its Actions run, not written
 * into the case.
 */

export const FIX_BRANCH_PREFIX = "feedback-autofix/";
export const PROMOTION_BRANCH_PREFIX = "feedback-autofix-main/";
const DEVELOP = "develop";
const MAIN = "main";

export const fixBranchForCase = (caseId: string) => `${FIX_BRANCH_PREFIX}${caseId}`;
export const promotionBranchForCase = (caseId: string) =>
  `${PROMOTION_BRANCH_PREFIX}${caseId}`;

/** Why promotion cannot run here, empty when it can. */
export const promotionConfigurationProblems = (): string[] => {
  const problems: string[] = [];
  if (!isAutoFixFixingEnabled()) problems.push("FEEDBACK_AUTOFIX_ENABLED");
  if (!isAutoFixGitHubReadConfigured()) {
    problems.push("FEEDBACK_AUTOFIX_GITHUB_READ_TOKEN");
  }
  problems.push(...deploymentProbeConfigurationProblems());
  return problems;
};

/**
 * The PR checks every promotion step repeats: it lives in this repository
 * (never a fork), targets the expected base, and comes from the expected
 * branch.
 */
export const pullRequestIdentityProblem = (
  pr: PullRequestFacts,
  expected: { base: string; headRef: string }
): string | null => {
  const repository = autoFixGitHubRepository();
  if (pr.baseRepository !== repository) return "base repository differs";
  if (pr.headRepository !== repository) return "head repository differs";
  if (pr.baseRef !== expected.base) return `base is not ${expected.base}`;
  if (pr.headRef !== expected.headRef) return "head branch differs";
  return null;
};

type TransitionExtras = {
  data?: Prisma.FeedbackAutoFixCaseUpdateManyMutationInput;
  where?: Prisma.FeedbackAutoFixCaseWhereInput;
  notify?: NotificationKind;
};

/** Compare-and-swap through the graph, with an optional operator notification
 * committed in the same transaction. */
const transition = async (
  caseId: string,
  from: string,
  to: string,
  { data = {}, where = {}, notify }: TransitionExtras = {}
) => {
  if (!canTransitionAutoFixCase(from, to)) return false;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.feedbackAutoFixCase.updateMany({
      where: { ...where, id: caseId, state: from },
      data: { ...data, state: to },
    });
    if (updated.count !== 1) return false;
    if (notify) {
      await enqueueNotificationDelivery(tx, { kind: notify, referenceId: caseId });
    }
    return true;
  });
};

const note = (caseId: string, observation: string, now: Date) =>
  prisma.feedbackAutoFixCase.updateMany({
    where: { id: caseId },
    data: { promotionObservedAt: now, promotionObservation: observation.slice(0, 300) },
  });

// --- Review request ---------------------------------------------------------

export type ReviewRequestVerification =
  | {
      ok: true;
      headSha: string;
      manifest: ChangeManifestEntry[];
      manifestDigest: string;
      prUrl: string | null;
    }
  | { ok: false; reason: string };

/**
 * Reads the develop PR a fix run reported and returns the facts the case
 * stores: its head and change manifest. The run's own PR URL is never stored
 * -- GitHub's is.
 */
export const verifyDevelopPullRequest = async (
  caseId: string,
  prNumber: number
): Promise<ReviewRequestVerification> => {
  if (!isAutoFixGitHubReadConfigured()) {
    return { ok: false, reason: "github_read_unavailable" };
  }
  const pr = await getPullRequest(prNumber);
  if (!pr) return { ok: false, reason: "pull request not found" };
  const identity = pullRequestIdentityProblem(pr, {
    base: DEVELOP,
    headRef: fixBranchForCase(caseId),
  });
  if (identity) return { ok: false, reason: identity };
  if (pr.state !== "open") return { ok: false, reason: "pull request is not open" };
  const { entries } = await buildPullRequestManifest(pr);
  const manifestDigest = changeManifestDigest(entries);
  if (!manifestDigest) return { ok: false, reason: "change manifest invalid" };
  return {
    ok: true,
    headSha: pr.headSha,
    manifest: entries,
    manifestDigest,
    prUrl: pr.htmlUrl,
  };
};

// --- Approval ---------------------------------------------------------------

export type ApprovalOutcome =
  | { approved: true; prUrl: string | null }
  | {
      approved: false;
      code:
        | "not_configured"
        | "not_found"
        | "wrong_state"
        | "head_changed"
        | "manifest_changed"
        | "pull_request_not_open"
        | "github_unavailable";
      detail?: string;
    };

/**
 * An owner approves the develop PR exactly as the console showed it. The
 * server re-reads the PR first: the head the owner saw must still be the head,
 * and the manifest at that head must still be the one recorded when the
 * review was requested. Only then does the case move, bound to both.
 */
export const approveAutoFixCase = async (input: {
  caseId: string;
  headSha: string;
  now?: Date;
}): Promise<ApprovalOutcome> => {
  if (promotionConfigurationProblems().length > 0) {
    return { approved: false, code: "not_configured" };
  }
  const current = await prisma.feedbackAutoFixCase.findUnique({
    where: { id: input.caseId },
    select: {
      state: true,
      fixPrNumber: true,
      fixHeadSha: true,
      fixManifestDigest: true,
    },
  });
  if (!current) return { approved: false, code: "not_found" };
  if (current.state !== AUTOFIX_CASE_STATE.prOpen || !current.fixPrNumber) {
    return { approved: false, code: "wrong_state" };
  }
  const seenHead = input.headSha.toLowerCase();
  if (!current.fixHeadSha || current.fixHeadSha !== seenHead) {
    return { approved: false, code: "head_changed" };
  }
  let verification: ReviewRequestVerification;
  try {
    verification = await verifyDevelopPullRequest(input.caseId, current.fixPrNumber);
  } catch {
    return { approved: false, code: "github_unavailable" };
  }
  if (!verification.ok) {
    return verification.reason === "pull request is not open"
      ? { approved: false, code: "pull_request_not_open" }
      : { approved: false, code: "github_unavailable", detail: verification.reason };
  }
  if (verification.headSha !== seenHead) {
    return { approved: false, code: "head_changed" };
  }
  if (verification.manifestDigest !== current.fixManifestDigest) {
    return { approved: false, code: "manifest_changed" };
  }
  const now = input.now ?? new Date();
  const applied = await transition(
    input.caseId,
    AUTOFIX_CASE_STATE.prOpen,
    AUTOFIX_CASE_STATE.approved,
    {
      where: { fixHeadSha: seenHead, fixManifestDigest: verification.manifestDigest },
      data: {
        approvedAt: now,
        approvedHeadSha: seenHead,
        approvedManifestDigest: verification.manifestDigest,
        productionBranch: promotionBranchForCase(input.caseId),
      },
    }
  );
  return applied
    ? { approved: true, prUrl: verification.prUrl }
    : { approved: false, code: "wrong_state" };
};

// --- Workflow preparation (read-only) --------------------------------------

export type PromotionPreparation =
  | {
      eligible: true;
      mergeSha: string;
      productionBranch: string;
      manifest: ChangeManifestEntry[];
    }
  | { eligible: false; reason: string };

/**
 * What the promotion-PR workflow needs, for a develop PR it saw merged. Never
 * changes the case: the observer records the merge from its own read. The
 * workflow still re-checks main against the manifest itself before it pushes,
 * and the observer re-checks the PR it opens.
 */
export const preparePromotion = async (input: {
  caseId: string;
  prNumber: number;
}): Promise<PromotionPreparation> => {
  if (promotionConfigurationProblems().length > 0) {
    return { eligible: false, reason: "not_configured" };
  }
  const current = await prisma.feedbackAutoFixCase.findUnique({
    where: { id: input.caseId },
    select: {
      state: true,
      fixPrNumber: true,
      approvedHeadSha: true,
      fixManifest: true,
      approvedManifestDigest: true,
    },
  });
  if (!current) return { eligible: false, reason: "not_found" };
  const promotable = [
    AUTOFIX_CASE_STATE.approved,
    AUTOFIX_CASE_STATE.merged,
    AUTOFIX_CASE_STATE.stagingVerified,
  ] as string[];
  if (!promotable.includes(current.state)) {
    return { eligible: false, reason: "not_approved" };
  }
  if (current.fixPrNumber !== input.prNumber) {
    return { eligible: false, reason: "pull request is not the case's" };
  }
  const manifest = parseStoredChangeManifest(current.fixManifest);
  if (!manifest || changeManifestDigest(manifest) !== current.approvedManifestDigest) {
    return { eligible: false, reason: "approved manifest unavailable" };
  }
  const pr = await getPullRequest(input.prNumber);
  if (!pr) return { eligible: false, reason: "pull request not found" };
  const identity = pullRequestIdentityProblem(pr, {
    base: DEVELOP,
    headRef: fixBranchForCase(input.caseId),
  });
  if (identity) return { eligible: false, reason: identity };
  if (!pr.merged || !pr.mergeCommitSha) return { eligible: false, reason: "not merged" };
  if (pr.headSha !== current.approvedHeadSha) {
    return { eligible: false, reason: "merged at a head that was not approved" };
  }
  return {
    eligible: true,
    mergeSha: pr.mergeCommitSha,
    productionBranch: promotionBranchForCase(input.caseId),
    manifest,
  };
};

// --- Observer ---------------------------------------------------------------

type ObservedCase = {
  id: string;
  state: string;
  fixPrNumber: number | null;
  fixManifest: Prisma.JsonValue;
  approvedHeadSha: string | null;
  approvedManifestDigest: string | null;
  mergeSha: string | null;
  stagingDeploymentId: string | null;
  stagingFirstSeenAt: Date | null;
  productionPrNumber: number | null;
  productionMergeSha: string | null;
  productionDeploymentId: string | null;
  productionFirstSeenAt: Date | null;
};

export type PromotionObserverDeps = {
  observe: (environment: PromotionEnvironment) => Promise<DeploymentPassObservation>;
  now: () => Date;
};

const defaultDeps: PromotionObserverDeps = {
  observe: (environment) => observeDeployment(environment),
  now: () => new Date(),
};

/**
 * Whether `deployedSha` contains `expectedSha` -- the same commit, or a later
 * one on the branch -- read from GitHub. Null when GitHub could not answer,
 * which the judgement treats as not observed, never as yes.
 */
const deployedCommitContains = async (expectedSha: string, deployedSha: string) => {
  if (expectedSha.toLowerCase() === deployedSha.toLowerCase()) return true;
  try {
    const { baseIsAncestor } = await compareCommits(expectedSha, deployedSha);
    return baseIsAncestor;
  } catch {
    return null;
  }
};

const failPromotion = (item: ObservedCase, reason: string) =>
  transition(item.id, item.state, AUTOFIX_CASE_STATE.promotionFailed, {
    data: { terminalReason: reason.slice(0, 300) },
    notify: NOTIFICATION_KIND.autoFixPromotionFailed,
  });

const observeApproved = async (item: ObservedCase, now: Date) => {
  if (!item.fixPrNumber) return failPromotion(item, "approved case has no PR");
  const pr = await getPullRequest(item.fixPrNumber);
  if (!pr) return note(item.id, "develop PR not found", now);
  const identity = pullRequestIdentityProblem(pr, {
    base: DEVELOP,
    headRef: fixBranchForCase(item.id),
  });
  if (identity) return failPromotion(item, `develop PR ${identity}`);
  if (pr.merged) {
    if (pr.headSha !== item.approvedHeadSha || !pr.mergeCommitSha) {
      return failPromotion(item, "develop PR merged at a head that was not approved");
    }
    return transition(item.id, item.state, AUTOFIX_CASE_STATE.merged, {
      data: { mergeSha: pr.mergeCommitSha, promotionObservedAt: now, promotionObservation: null },
    });
  }
  if (pr.state === "closed") return failPromotion(item, "develop PR closed without merging");
  if (pr.headSha !== item.approvedHeadSha) {
    return failPromotion(item, "develop PR head changed after approval");
  }
  return note(item.id, "waiting for the develop PR to be merged in GitHub", now);
};

const observeDeploymentStep = async (
  item: ObservedCase,
  environment: PromotionEnvironment,
  deps: PromotionObserverDeps,
  now: Date
) => {
  const production = environment === "production";
  const expectedSha = production ? item.productionMergeSha : item.mergeSha;
  if (!expectedSha) return failPromotion(item, `${environment} commit unknown`);
  const previousId = production ? item.productionDeploymentId : item.stagingDeploymentId;
  const previousAt = production ? item.productionFirstSeenAt : item.stagingFirstSeenAt;
  const observation = await deps.observe(environment);
  const serving = servingDeployment(observation.controlPlane);
  const containsExpected =
    "deployment" in serving && serving.deployment.commitSha
      ? await deployedCommitContains(expectedSha, serving.deployment.commitSha)
      : null;
  const judgement = judgeDeploymentObservation({
    expectedSha,
    observation,
    containsExpected,
    previous: previousId && previousAt ? { deploymentId: previousId, firstSeenAt: previousAt } : null,
    requireReady: production,
    now,
  });
  const sightingData = (sighting: { deploymentId: string; firstSeenAt: Date } | null) =>
    production
      ? {
          productionDeploymentId: sighting?.deploymentId ?? null,
          productionFirstSeenAt: sighting?.firstSeenAt ?? null,
        }
      : {
          stagingDeploymentId: sighting?.deploymentId ?? null,
          stagingFirstSeenAt: sighting?.firstSeenAt ?? null,
        };
  if (judgement.kind === "verified") {
    return transition(
      item.id,
      item.state,
      production ? AUTOFIX_CASE_STATE.productionVerified : AUTOFIX_CASE_STATE.stagingVerified,
      {
        data: {
          ...(production ? { productionVerifiedAt: now } : { stagingVerifiedAt: now }),
          promotionObservedAt: now,
          promotionObservation: null,
        },
        notify: production ? NOTIFICATION_KIND.autoFixProductionVerified : undefined,
      }
    );
  }
  await prisma.feedbackAutoFixCase.updateMany({
    where: { id: item.id, state: item.state },
    data: {
      ...sightingData(judgement.sighting),
      promotionObservedAt: now,
      promotionObservation:
        judgement.kind === "not_observed"
          ? `${environment}: ${judgement.reason}`
          : `${environment}: stabilising since ${judgement.sighting.firstSeenAt.toISOString()}`,
    },
  });
  return false;
};

const observePromotionPullRequest = async (item: ObservedCase, now: Date) => {
  const approved = parseStoredChangeManifest(item.fixManifest);
  if (!approved || changeManifestDigest(approved) !== item.approvedManifestDigest) {
    return failPromotion(item, "approved manifest unavailable");
  }
  const branch = promotionBranchForCase(item.id);
  const candidates = (await findPullRequestsByHead(branch, MAIN)).filter(
    (pr) => !pullRequestIdentityProblem(pr, { base: MAIN, headRef: branch })
  );
  // Exactly one canonical PR: a second one is a person's decision to untangle.
  const live = candidates.filter((pr) => pr.state === "open" || pr.merged);
  if (live.length === 0) {
    return note(item.id, "waiting for the main promotion PR", now);
  }
  if (live.length > 1) {
    return note(item.id, "more than one main promotion PR; close the extra one", now);
  }
  const [pr] = live;
  const { entries } = await buildPullRequestManifest(pr);
  const verdict = isApprovedChange(approved, entries);
  if (!verdict.ok) {
    return failPromotion(item, `main promotion PR: ${verdict.reason}`);
  }
  if (item.productionPrNumber !== pr.number) {
    await prisma.feedbackAutoFixCase.updateMany({
      where: { id: item.id, state: item.state },
      data: { productionPrNumber: pr.number, productionPrUrl: pr.htmlUrl },
    });
  }
  if (!pr.merged || !pr.mergeCommitSha) {
    await prisma.feedbackAutoFixCase.updateMany({
      where: { id: item.id, state: item.state },
      data: { productionPrHeadSha: pr.headSha },
    });
    return note(item.id, "main promotion PR is ready; merge it in GitHub", now);
  }
  return transition(item.id, item.state, AUTOFIX_CASE_STATE.productionMerged, {
    data: {
      productionPrHeadSha: pr.headSha,
      productionMergeSha: pr.mergeCommitSha,
      promotionObservedAt: now,
      promotionObservation: null,
    },
  });
};

/**
 * One observer pass over every case in a promotion state. Runs on the
 * maintenance cadence; a GitHub or Railway read that fails leaves the case
 * where it is and is retried on the next pass.
 */
export const runPromotionObserver = async (
  deps: PromotionObserverDeps = defaultDeps,
  limit = 20
) => {
  const summary = { enabled: false, observed: 0, advanced: 0, errors: 0 };
  if (promotionConfigurationProblems().length > 0) return summary;
  summary.enabled = true;
  const cases = await prisma.feedbackAutoFixCase.findMany({
    where: { state: { in: [...AUTOFIX_PROMOTION_OBSERVED_STATES] } },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      state: true,
      fixPrNumber: true,
      fixManifest: true,
      approvedHeadSha: true,
      approvedManifestDigest: true,
      mergeSha: true,
      stagingDeploymentId: true,
      stagingFirstSeenAt: true,
      productionPrNumber: true,
      productionMergeSha: true,
      productionDeploymentId: true,
      productionFirstSeenAt: true,
    },
  });
  for (const item of cases) {
    summary.observed += 1;
    const now = deps.now();
    try {
      let advanced: unknown = false;
      switch (item.state) {
        case AUTOFIX_CASE_STATE.approved:
          advanced = await observeApproved(item, now);
          break;
        case AUTOFIX_CASE_STATE.merged:
          advanced = await observeDeploymentStep(item, "staging", deps, now);
          break;
        case AUTOFIX_CASE_STATE.stagingVerified:
          advanced = await observePromotionPullRequest(item, now);
          break;
        case AUTOFIX_CASE_STATE.productionMerged:
          advanced = await observeDeploymentStep(item, "production", deps, now);
          break;
      }
      if (advanced === true) summary.advanced += 1;
    } catch (error) {
      summary.errors += 1;
      await note(
        item.id,
        `observation failed: ${error instanceof Error ? error.name : "unknown"}`,
        now
      ).catch(() => undefined);
    }
  }
  return summary;
};

/**
 * Whether main's history is already contained in develop -- the back-merge
 * after the last squashed release has landed. The promotion workflow refuses
 * to build a promotion PR otherwise (independent review round 1, N8); the
 * console shows the same fact.
 */
export const isBackMergeComplete = async () => {
  const { baseIsAncestor } = await compareCommits(MAIN, DEVELOP);
  return baseIsAncestor;
};
