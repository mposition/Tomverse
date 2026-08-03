import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
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
 *  - `merged` is only ever recorded from a GitHub read-back payload
 *    (mergedAt + mergeSha), not from enabling auto-merge;
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
          AUTOFIX_CASE_STATE.merged,
          AUTOFIX_CASE_STATE.stagingVerified,
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

export const claimCaseForFix = async (caseId: string) => {
  if (!isAutoFixFixingEnabled()) return null;
  const now = new Date();
  const claim = await prisma.feedbackAutoFixCase.updateMany({
    where: { id: caseId, state: AUTOFIX_CASE_STATE.awaitingHumanReview },
    data: {
      state: AUTOFIX_CASE_STATE.fixAttempting,
      claimedAt: now,
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + AUTOFIX_LEASE_MS * 6),
      fixBranch: `feedback-autofix/${caseId}`,
    },
  });
  return claim.count === 1 ? { branch: `feedback-autofix/${caseId}` } : null;
};

export const heartbeatCase = async (caseId: string) => {
  const now = new Date();
  const updated = await prisma.feedbackAutoFixCase.updateMany({
    where: { id: caseId, state: AUTOFIX_CASE_STATE.fixAttempting },
    data: {
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + AUTOFIX_LEASE_MS * 6),
    },
  });
  return updated.count === 1;
};

const guardedTransition = async (
  caseId: string,
  from: string,
  to: string,
  data: Record<string, unknown>
) => {
  if (!canTransitionAutoFixCase(from, to)) return false;
  const updated = await prisma.feedbackAutoFixCase.updateMany({
    where: { id: caseId, state: from },
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
  | { outcome: "pr_open"; prNumber: number; prUrl: string }
  | {
      outcome: "merged";
      /** GitHub read-back, required: enabling auto-merge is not a merge. */
      mergedAt: string;
      mergeSha: string;
    }
  | { outcome: "staging_verified"; stagingSha: string }
  | { outcome: "fix_failed"; reason: string };

/** Applies a workflow-reported outcome. Returns false for anything the
 * transition graph or the server-side re-validation refuses. */
export const applyAutoFixResult = async (
  caseId: string,
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
      const applied = await guardedTransition(
        caseId,
        AUTOFIX_CASE_STATE.redGreenProven,
        AUTOFIX_CASE_STATE.prOpen,
        { fixPrNumber: payload.prNumber, fixPrUrl: payload.prUrl.slice(0, 300) }
      );
      return { applied, reason: applied ? undefined : "wrong state" };
    }
    case "merged": {
      if (!payload.mergedAt || !/^[0-9a-f]{40}$/i.test(payload.mergeSha)) {
        return {
          applied: false,
          reason: "merged requires the read-back mergedAt and a full merge SHA",
        };
      }
      const applied = await guardedTransition(
        caseId,
        AUTOFIX_CASE_STATE.prOpen,
        AUTOFIX_CASE_STATE.merged,
        { mergeSha: payload.mergeSha.toLowerCase() }
      );
      return { applied, reason: applied ? undefined : "wrong state" };
    }
    case "staging_verified": {
      if (!/^[0-9a-f]{40}$/i.test(payload.stagingSha)) {
        return { applied: false, reason: "invalid staging SHA" };
      }
      const current = await prisma.feedbackAutoFixCase.findUnique({
        where: { id: caseId },
        select: { mergeSha: true },
      });
      if (
        !current?.mergeSha ||
        current.mergeSha !== payload.stagingSha.toLowerCase()
      ) {
        return {
          applied: false,
          reason: "staging SHA does not match the read-back merge SHA",
        };
      }
      const applied = await guardedTransition(
        caseId,
        AUTOFIX_CASE_STATE.merged,
        AUTOFIX_CASE_STATE.stagingVerified,
        { stagingSha: payload.stagingSha.toLowerCase() }
      );
      return { applied, reason: applied ? undefined : "wrong state" };
    }
    case "fix_failed": {
      // Legal from several states; try them in order. The reason is a
      // workflow-authored classification, bounded and never user text.
      for (const from of [
        AUTOFIX_CASE_STATE.fixAttempting,
        AUTOFIX_CASE_STATE.redGreenProven,
        AUTOFIX_CASE_STATE.prOpen,
        AUTOFIX_CASE_STATE.merged,
      ]) {
        if (
          await guardedTransition(caseId, from, AUTOFIX_CASE_STATE.fixFailed, {
            terminalReason: payload.reason.slice(0, 300),
            leaseExpiresAt: null,
            claimedAt: null,
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
    },
  });
  return updated.count;
};
