import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  AUTOFIX_CASE_STATE,
  AUTOFIX_LEASE_MS,
  canTransitionAutoFixCase,
  isAutoFixFixingEnabled,
} from "@/lib/feedbackAutoFixCore";
import {
  evaluateAutoFixChangePolicy,
  evaluateRedGreenProof,
  type AutoFixChangedFile,
  type RedGreenProof,
} from "@/lib/feedbackAutoFixPolicy";
import { verifyDevelopPullRequest } from "@/lib/feedbackAutoFixPromotion";
import {
  NOTIFICATION_KIND,
  enqueueNotificationDelivery,
} from "@/lib/notificationDeliveries";

/**
 * Server side of the Phase 3 fix workflow protocol. Everything here is dark
 * until FEEDBACK_AUTOFIX_ENABLED is "true" AND the dedicated sync secret is
 * configured -- both fail closed.
 *
 * Contract highlights (docs/policy/trace-feedback-automation.md §9):
 *  - claims are compare-and-swap with a lease; a died runner's case returns
 *    to the review pool when the lease expires;
 *  - the result endpoint re-validates the change manifest and the Red→Green
 *    proof server-side -- the workflow's own verdict is never trusted;
 *  - the PR a run reports is re-read from GitHub by the server, which stores
 *    GitHub's head and change manifest rather than the run's account; nothing
 *    after pr_open is reported by a workflow at all -- approval happens in the
 *    console and every merge and deployment is observed by the server
 *    (lib/feedbackAutoFixPromotion.ts);
 *  - state writes go through the transition graph; a callback replay hits
 *    the state guard and becomes a no-op.
 */

const MIN_SECRET_LENGTH = 32;

export const isAutoFixSyncAuthorized = (request: Request): boolean => {
  const configured = process.env.FEEDBACK_AUTOFIX_SYNC_SECRET || "";
  if (configured.length < MIN_SECRET_LENGTH) return false;
  const authorization = request.headers.get("authorization") || "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!provided) return false;
  const expectedDigest = createHash("sha256").update(configured).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
};

export const autoFixDailyCap = () => {
  const raw = Number(process.env.FEEDBACK_AUTOFIX_MAX_CASES_PER_DAY || "");
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 5;
};

/** Candidates the fix workflow may claim: human-review-pool cases that
 * classified as application_candidate, bounded by the daily attempt cap. */
export const listClaimableCases = async (limit: number) => {
  if (!isAutoFixFixingEnabled()) return { enabled: false as const, cases: [] };
  const dayStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const attemptsToday = await prisma.feedbackAutoFixCase.count({
    where: {
      state: {
        in: [
          AUTOFIX_CASE_STATE.fixAttempting,
          AUTOFIX_CASE_STATE.redGreenProven,
          AUTOFIX_CASE_STATE.prOpen,
          AUTOFIX_CASE_STATE.fixFailed,
        ],
      },
      updatedAt: { gte: dayStart },
    },
  });
  const budget = Math.max(0, autoFixDailyCap() - attemptsToday);
  if (budget === 0) return { enabled: true as const, cases: [] };
  const cases = await prisma.feedbackAutoFixCase.findMany({
    where: {
      state: AUTOFIX_CASE_STATE.awaitingHumanReview,
      classification: "application_candidate",
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(limit, budget),
    select: { id: true, diagnosticSummary: true, sourceRelease: true },
  });
  return { enabled: true as const, cases };
};

/**
 * Claims a candidate for one fix run and mints that run's attempt id.
 *
 * The attempt id fences the run (independent review round 0 F4, round 2 N2):
 * every later heartbeat and result must carry it, and a claim, a lease
 * reclaim or a terminal result replaces or clears it. So a run whose lease
 * expired -- and whose case another run has since claimed -- cannot move the
 * new run's case with a late callback: its id no longer matches anything.
 */
export const claimCaseForFix = async (caseId: string) => {
  if (!isAutoFixFixingEnabled()) return null;
  const now = new Date();
  const attemptId = randomUUID();
  const claim = await prisma.feedbackAutoFixCase.updateMany({
    where: { id: caseId, state: AUTOFIX_CASE_STATE.awaitingHumanReview },
    data: {
      state: AUTOFIX_CASE_STATE.fixAttempting,
      claimedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + AUTOFIX_LEASE_MS * 6),
      fixBranch: `feedback-autofix/${caseId}`,
      fixAttemptId: attemptId,
    },
  });
  return claim.count === 1
    ? { branch: `feedback-autofix/${caseId}`, attemptId }
    : null;
};

export const heartbeatCase = async (caseId: string, attemptId: string) => {
  const now = new Date();
  const updated = await prisma.feedbackAutoFixCase.updateMany({
    where: {
      id: caseId,
      state: AUTOFIX_CASE_STATE.fixAttempting,
      fixAttemptId: attemptId,
    },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + AUTOFIX_LEASE_MS * 6),
    },
  });
  return updated.count === 1;
};

const guardedTransition = async (
  caseId: string,
  attemptId: string,
  from: string,
  to: string,
  data: Record<string, unknown>
) => {
  if (!canTransitionAutoFixCase(from, to)) return false;
  const updated = await prisma.feedbackAutoFixCase.updateMany({
    where: { id: caseId, state: from, fixAttemptId: attemptId },
    data: { state: to, ...data },
  });
  return updated.count === 1;
};

export type AutoFixResultPayload =
  | {
      outcome: "red_green_proven";
      changedFiles: AutoFixChangedFile[];
      proof: RedGreenProof;
    }
  | {
      outcome: "pr_open";
      prNumber: number;
      /** The run's account of the cause and the fix, derived only from the
       * diagnostic summary. Bounded by the route schema. */
      fixReport: AutoFixReport;
    }
  | { outcome: "fix_failed"; reason: string };

export type AutoFixReport = {
  rootCause: string;
  fixSummary: string;
  testSummary: string;
};

/** Control characters out, whitespace trimmed: the report is shown in the
 * console and quoted in an operator email. */
const cleanReportText = (value: string, max: number) =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);

/** Applies a workflow-reported outcome. Returns false for anything the
 * transition graph or the server-side re-validation refuses. */
export const applyAutoFixResult = async (
  caseId: string,
  attemptId: string,
  payload: AutoFixResultPayload
): Promise<{ applied: boolean; reason?: string }> => {
  if (!isAutoFixFixingEnabled()) {
    return { applied: false, reason: "disabled" };
  }
  switch (payload.outcome) {
    case "red_green_proven": {
      const policy = evaluateAutoFixChangePolicy(payload.changedFiles);
      if (!policy.allowed) {
        return {
          applied: false,
          reason: `change policy: ${policy.violations.join("; ")}`,
        };
      }
      const verdict = evaluateRedGreenProof(
        payload.proof,
        payload.changedFiles
      );
      if (!verdict.proven) {
        return { applied: false, reason: `red-green: ${verdict.reason}` };
      }
      const applied = await guardedTransition(
        caseId,
        attemptId,
        AUTOFIX_CASE_STATE.fixAttempting,
        AUTOFIX_CASE_STATE.redGreenProven,
        {
          redGreenProof: {
            ...payload.proof,
            changedFiles: payload.changedFiles,
          },
        }
      );
      return { applied, reason: applied ? undefined : "wrong state" };
    }
    case "pr_open": {
      if (!Number.isInteger(payload.prNumber) || payload.prNumber <= 0) {
        return { applied: false, reason: "invalid PR number" };
      }
      const current = await prisma.feedbackAutoFixCase.findUnique({
        where: { id: caseId },
        select: { state: true, fixAttemptId: true },
      });
      if (
        current?.state !== AUTOFIX_CASE_STATE.redGreenProven ||
        current.fixAttemptId !== attemptId
      ) {
        return { applied: false, reason: "wrong state" };
      }
      // GitHub, not the run, says which PR this is, where it points and what
      // it changes. Without the read credential nothing is recorded.
      let verification;
      try {
        verification = await verifyDevelopPullRequest(caseId, payload.prNumber);
      } catch {
        return { applied: false, reason: "github_read_failed" };
      }
      if (!verification.ok) {
        return { applied: false, reason: verification.reason };
      }
      const fixReport = {
        rootCause: cleanReportText(payload.fixReport.rootCause, 1_000),
        fixSummary: cleanReportText(payload.fixReport.fixSummary, 1_000),
        testSummary: cleanReportText(payload.fixReport.testSummary, 500),
      };
      const verified = verification;
      const applied = await prisma.$transaction(async (tx) => {
        const updated = await tx.feedbackAutoFixCase.updateMany({
          where: {
            id: caseId,
            state: AUTOFIX_CASE_STATE.redGreenProven,
            fixAttemptId: attemptId,
          },
          data: {
            state: AUTOFIX_CASE_STATE.prOpen,
            // The run is over: nothing may report for this attempt again.
            fixAttemptId: null,
            leaseExpiresAt: null,
            fixPrNumber: payload.prNumber,
            fixPrUrl: verified.prUrl?.slice(0, 300) ?? null,
            fixHeadSha: verified.headSha,
            fixManifest: verified.manifest,
            fixManifestDigest: verified.manifestDigest,
            fixReport,
          },
        });
        if (updated.count !== 1) return false;
        // The review request mail commits with the state it announces.
        await enqueueNotificationDelivery(tx, {
          kind: NOTIFICATION_KIND.autoFixReviewRequested,
          referenceId: caseId,
        });
        return true;
      });
      return { applied, reason: applied ? undefined : "wrong state" };
    }
    case "fix_failed": {
      // Legal from several states; try them in order. The reason is a
      // workflow-authored classification, bounded and never user text.
      // Only the run's own states: once a PR is open the case belongs to the
      // owner's review, and a late failure report must not undo it.
      for (const from of [
        AUTOFIX_CASE_STATE.fixAttempting,
        AUTOFIX_CASE_STATE.redGreenProven,
      ]) {
        if (
          await guardedTransition(caseId, attemptId, from, AUTOFIX_CASE_STATE.fixFailed, {
            terminalReason: payload.reason.slice(0, 300),
            leaseExpiresAt: null,
            claimedAt: null,
            fixAttemptId: null,
          })
        ) {
          return { applied: true };
        }
      }
      return { applied: false, reason: "wrong state" };
    }
  }
};

/** Returns fix_attempting cases whose lease expired to the review pool --
 * run by the shadow worker pass so a died runner never strands a case. */
export const reclaimExpiredFixLeases = async () => {
  const updated = await prisma.feedbackAutoFixCase.updateMany({
    where: {
      state: AUTOFIX_CASE_STATE.fixAttempting,
      leaseExpiresAt: { lt: new Date() },
    },
    data: {
      state: AUTOFIX_CASE_STATE.awaitingHumanReview,
      leaseExpiresAt: null,
      claimedAt: null,
      // The expired run's id is void: its late callbacks match nothing.
      fixAttemptId: null,
    },
  });
  return updated.count;
};
