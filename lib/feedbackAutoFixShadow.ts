import "server-only";

import { prisma } from "@/lib/prisma";
import {
  AUTOFIX_ACTIVE_STATES,
  AUTOFIX_CASE_STATE,
  AUTOFIX_LEASE_MS,
  AUTOFIX_MAX_COLLECT_ATTEMPTS,
  autoFixCollectBackoffMs,
  canTransitionAutoFixCase,
  classifyAutoFixCase,
  isAutoFixShadowModeEnabled,
} from "@/lib/feedbackAutoFixCore";

/**
 * The Phase 2 diagnosis-only worker. Runs on the maintenance cadence, claims
 * a bounded batch of cases with compare-and-swap leases, collects the
 * server-side evidence a report's verified trace points at, classifies it
 * with the deterministic rules in feedbackAutoFixCore, and leaves a bounded
 * diagnostic summary for a human.
 *
 * What this module must never do (release blocker, AGENTS.md): modify code,
 * touch git, create branches or PRs, call an LLM, or replay user prompts.
 * Its only writes are FeedbackAutoFixCase rows.
 *
 * Sentry enrichment is best-effort and read-only: when the dedicated
 * read token is configured, one bounded fetch adds the event title to the
 * summary. A missing token or a failed fetch never delays the case --
 * ingestion-delay retries only apply to the DB evidence row itself.
 */

const SENTRY_FETCH_TIMEOUT_MS = 5_000;

type ClaimedCase = {
  id: string;
  feedbackId: string;
  traceId: string;
  occurrenceId: string | null;
  attemptCount: number;
};

/** Compare-and-swap state transition; refuses anything the graph forbids. */
const transitionCase = async (
  caseId: string,
  from: string,
  to: string,
  data: Record<string, unknown> = {}
): Promise<boolean> => {
  if (!canTransitionAutoFixCase(from, to)) {
    console.error(
      JSON.stringify({
        event: "autofix_case_invalid_transition",
        caseId,
        from,
        to,
        at: new Date().toISOString(),
      })
    );
    return false;
  }
  const updated = await prisma.feedbackAutoFixCase.updateMany({
    where: { id: caseId, state: from },
    data: { state: to, ...data },
  });
  return updated.count === 1;
};

const fetchSentryTitle = async (
  sentryEventId: string
): Promise<{ fetched: boolean; title?: string; reason?: string }> => {
  const token = process.env.SENTRY_EVIDENCE_READ_TOKEN;
  const org = process.env.SENTRY_EVIDENCE_ORG_SLUG;
  const project = process.env.SENTRY_EVIDENCE_PROJECT_SLUG;
  if (!token || !org || !project) {
    return { fetched: false, reason: "not_configured" };
  }
  try {
    const response = await fetch(
      `https://sentry.io/api/0/projects/${encodeURIComponent(
        org
      )}/${encodeURIComponent(project)}/events/${encodeURIComponent(
        sentryEventId
      )}/`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(SENTRY_FETCH_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      // 404 here usually means "not ingested yet" -- reported as-is, never
      // escalated to a case failure (docs/policy §7).
      return { fetched: false, reason: `http_${response.status}` };
    }
    const body = (await response.json()) as { title?: unknown };
    return {
      fetched: true,
      title:
        typeof body.title === "string" ? body.title.slice(0, 300) : undefined,
    };
  } catch {
    return { fetched: false, reason: "unreachable" };
  }
};

const processClaimedCase = async (claimed: ClaimedCase) => {
  const now = Date.now();
  const feedback = await prisma.feedback.findUnique({
    where: { id: claimed.feedbackId },
    select: {
      errorReportVerification: true,
      errorClassificationSource: true,
      clientErrorCode: true,
      evidenceAvailability: true,
      traceEvidence: {
        select: {
          occurrenceId: true,
          traceId: true,
          environment: true,
          release: true,
          routeClass: true,
          phase: true,
          errorCode: true,
          classificationSource: true,
          httpStatus: true,
          provider: true,
          modelId: true,
          retryable: true,
          sentryEventId: true,
          occurredAt: true,
        },
      },
    },
  });
  if (!feedback) {
    await transitionCase(
      claimed.id,
      AUTOFIX_CASE_STATE.collectingEvidence,
      AUTOFIX_CASE_STATE.ineligible,
      {
        classification: "evidence_incomplete",
        ineligibilityReason: "feedback row no longer exists",
        terminalReason: "feedback_missing",
        leaseExpiresAt: null,
        claimedAt: null,
      }
    );
    return;
  }

  const evidence = feedback.traceEvidence;
  // A verified report whose evidence row has not appeared yet retries on the
  // cron cadence; anything else proceeds with what exists.
  if (
    !evidence &&
    feedback.evidenceAvailability === "not_yet_available" &&
    claimed.attemptCount < AUTOFIX_MAX_COLLECT_ATTEMPTS
  ) {
    await transitionCase(
      claimed.id,
      AUTOFIX_CASE_STATE.collectingEvidence,
      AUTOFIX_CASE_STATE.evidenceDelayed,
      {
        // leaseExpiresAt doubles as the not-before instant for the retry.
        leaseExpiresAt: new Date(
          now + autoFixCollectBackoffMs(claimed.attemptCount)
        ),
        claimedAt: null,
      }
    );
    return;
  }

  // Evidence phase settled -- move through evidence_ready and classifying
  // with explicit transitions so the timeline stays auditable.
  if (
    !(await transitionCase(
      claimed.id,
      AUTOFIX_CASE_STATE.collectingEvidence,
      AUTOFIX_CASE_STATE.evidenceReady
    )) ||
    !(await transitionCase(
      claimed.id,
      AUTOFIX_CASE_STATE.evidenceReady,
      AUTOFIX_CASE_STATE.classifying
    ))
  ) {
    return;
  }

  const outcome = classifyAutoFixCase({
    errorReportVerification: feedback.errorReportVerification,
    errorClassificationSource: feedback.errorClassificationSource,
    clientErrorCode: feedback.clientErrorCode,
    evidenceAvailability: feedback.evidenceAvailability,
    evidence: evidence
      ? {
          errorCode: evidence.errorCode,
          retryable: evidence.retryable,
          httpStatus: evidence.httpStatus,
        }
      : null,
  });

  // Bounded technical facts only: no user text, no prompts, no raw provider
  // payloads, no tokens. The reporter's words stay in the Feedback row.
  const [providerEventCount, limitEventCount] = await Promise.all([
    prisma.providerErrorEvent.count({ where: { traceId: claimed.traceId } }),
    prisma.chatLimitDecisionEvent
      .count({ where: { traceId: claimed.traceId } })
      .catch(() => 0),
  ]);
  const sentry = evidence?.sentryEventId
    ? await fetchSentryTitle(evidence.sentryEventId)
    : { fetched: false, reason: "no_event_id" };

  const diagnosticSummary = {
    classification: outcome.classification,
    reason: outcome.reason,
    traceId: claimed.traceId,
    occurrenceId: evidence?.occurrenceId ?? claimed.occurrenceId,
    errorCode: evidence?.errorCode ?? feedback.clientErrorCode,
    classificationSource:
      evidence?.classificationSource ?? feedback.errorClassificationSource,
    routeClass: evidence?.routeClass ?? null,
    phase: evidence?.phase ?? null,
    httpStatus: evidence?.httpStatus ?? null,
    provider: evidence?.provider ?? null,
    modelId: evidence?.modelId ?? null,
    retryable: evidence?.retryable ?? null,
    release: evidence?.release ?? null,
    environment: evidence?.environment ?? null,
    occurredAt: evidence?.occurredAt?.toISOString() ?? null,
    providerEventCount,
    limitEventCount,
    sentry: {
      eventId: evidence?.sentryEventId ?? null,
      ...sentry,
    },
  };

  if (outcome.eligible) {
    if (
      await transitionCase(
        claimed.id,
        AUTOFIX_CASE_STATE.classifying,
        AUTOFIX_CASE_STATE.diagnosticReady,
        {
          classification: outcome.classification,
          diagnosticSummary,
          leaseExpiresAt: null,
          claimedAt: null,
        }
      )
    ) {
      await transitionCase(
        claimed.id,
        AUTOFIX_CASE_STATE.diagnosticReady,
        AUTOFIX_CASE_STATE.awaitingHumanReview
      );
    }
  } else {
    await transitionCase(
      claimed.id,
      AUTOFIX_CASE_STATE.classifying,
      AUTOFIX_CASE_STATE.ineligible,
      {
        classification: outcome.classification,
        ineligibilityReason: outcome.reason,
        diagnosticSummary,
        terminalReason: outcome.classification,
        leaseExpiresAt: null,
        claimedAt: null,
      }
    );
  }

  console.info(
    JSON.stringify({
      event: "autofix_case_classified",
      caseId: claimed.id,
      classification: outcome.classification,
      eligible: outcome.eligible,
      hasEvidence: Boolean(evidence),
      at: new Date().toISOString(),
    })
  );
};

/**
 * One bounded worker pass. Returns counters for the maintenance log. Safe to
 * run concurrently: every claim is a conditional update that exactly one
 * runner can win, and an expired lease is reclaimable by anyone.
 */
export const runFeedbackAutoFixShadowWorker = async (limit = 25) => {
  if (!isAutoFixShadowModeEnabled()) {
    return { enabled: false, claimed: 0, processed: 0 };
  }
  const now = new Date();
  const candidates = await prisma.feedbackAutoFixCase.findMany({
    where: {
      OR: [
        { state: AUTOFIX_CASE_STATE.received },
        {
          state: AUTOFIX_CASE_STATE.evidenceDelayed,
          leaseExpiresAt: { lte: now },
        },
        // Orphaned mid-flight claims (a died worker) become reclaimable when
        // their lease expires.
        {
          state: {
            in: [...AUTOFIX_ACTIVE_STATES].filter(
              (state) =>
                state !== AUTOFIX_CASE_STATE.received &&
                state !== AUTOFIX_CASE_STATE.evidenceDelayed
            ),
          },
          leaseExpiresAt: { lte: now },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      feedbackId: true,
      traceId: true,
      occurrenceId: true,
      attemptCount: true,
      state: true,
    },
  });

  let claimed = 0;
  let processed = 0;
  for (const candidate of candidates) {
    // An orphaned collecting/classifying case is reset to collecting via the
    // same claim write; received/evidence_delayed take the normal path.
    const claim = await prisma.feedbackAutoFixCase.updateMany({
      where: {
        id: candidate.id,
        state: candidate.state,
        ...(candidate.state === AUTOFIX_CASE_STATE.received
          ? {}
          : { leaseExpiresAt: { lte: now } }),
      },
      data: {
        state: AUTOFIX_CASE_STATE.collectingEvidence,
        claimedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + AUTOFIX_LEASE_MS),
        attemptCount: { increment: 1 },
      },
    });
    if (claim.count !== 1) continue;
    claimed += 1;
    try {
      await processClaimedCase({
        id: candidate.id,
        feedbackId: candidate.feedbackId,
        traceId: candidate.traceId,
        occurrenceId: candidate.occurrenceId,
        attemptCount: candidate.attemptCount + 1,
      });
      processed += 1;
    } catch (error) {
      // The lease expiry is the retry mechanism; a crashed case is left for
      // the next pass rather than transitioned blindly.
      console.error(
        JSON.stringify({
          event: "autofix_case_process_failed",
          caseId: candidate.id,
          reason: error instanceof Error ? error.name : "unknown",
          at: new Date().toISOString(),
        })
      );
    }
  }

  // Give up on evidence that never appeared within the attempt ceiling.
  const exhausted = await prisma.feedbackAutoFixCase.updateMany({
    where: {
      state: AUTOFIX_CASE_STATE.evidenceDelayed,
      attemptCount: { gte: AUTOFIX_MAX_COLLECT_ATTEMPTS },
    },
    data: {
      state: AUTOFIX_CASE_STATE.ineligible,
      classification: "evidence_incomplete",
      ineligibilityReason: "evidence never became available",
      terminalReason: "evidence_incomplete",
      leaseExpiresAt: null,
      claimedAt: null,
    },
  });

  return { enabled: true, claimed, processed, exhausted: exhausted.count };
};

/** Closed-case retention: shadow cases are diagnostics, not billing records.
 * Called from lib/maintenance.ts. */
export const purgeClosedAutoFixCases = async () => {
  const result = await prisma.feedbackAutoFixCase.deleteMany({
    where: {
      state: {
        in: [AUTOFIX_CASE_STATE.closed, AUTOFIX_CASE_STATE.ineligible],
      },
      updatedAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    },
  });
  return result.count;
};
