import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import { prisma } from "@/lib/prisma";
import {
  ERROR_CLASSIFICATION_SOURCE,
  TRACE_PROVENANCE,
  traceEvidenceRecordability,
} from "@/lib/errorReportContract";
import { issueErrorReportToken } from "@/lib/errorReportToken";

/**
 * Server-side trace evidence recorder and error-report grant issuer.
 *
 * One call site per error *builder*, not per error branch: the chat route's
 * JSON error builder, its ChatAccessError exit and the deep-research failed
 * poll all funnel through issueChatErrorReportGrant, which
 *
 *   1. mints a trusted occurrenceId for this server-side error occurrence,
 *   2. signs an errorReportToken bound to the trace + occurrence,
 *   3. schedules a best-effort TraceErrorEvidence write (never on the
 *      response's critical path -- see the delivery note below), and
 *   4. captures the underlying Error to Sentry, tagged with the trace ID,
 *      storing the returned event ID on the evidence row.
 *
 * Evidence identity is the server-minted occurrenceId, never the trace ID:
 * trace IDs can be client-influenced elsewhere in the system, the same trace
 * may legitimately produce several occurrences, and a client must never be
 * able to pre-claim or overwrite an evidence row by replaying a trace string.
 *
 * Delivery guarantee: the evidence write is detached (fire-and-forget with a
 * logged failure path). This process runs as a long-lived Node server on
 * Railway, not a serverless function, so a scheduled write survives the
 * response; a crash between response and write loses at most that one row,
 * which the feedback flow reports honestly as `not_yet_available`.
 */

const RETENTION_DAYS = 30;

/** Operational write caps -- never an entitlement, never a credit. They only
 * bound how fast this diagnostics table can grow during an incident. */
const readCap = (name: string, fallback: number) => {
  const raw = Number(process.env[name] || "");
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
};

type CapWindow = { windowStart: number; count: number };
const minuteWindow: CapWindow = { windowStart: 0, count: 0 };
const dayWindow: CapWindow = { windowStart: 0, count: 0 };
let lastCapWarningAt = 0;

const consumeWriteBudget = (now: number) => {
  const minuteCap = readCap("TRACE_EVIDENCE_MAX_WRITES_PER_MINUTE", 120);
  const dayCap = readCap("TRACE_EVIDENCE_MAX_WRITES_PER_DAY", 5_000);
  if (now - minuteWindow.windowStart >= 60_000) {
    minuteWindow.windowStart = now;
    minuteWindow.count = 0;
  }
  if (now - dayWindow.windowStart >= 24 * 60 * 60 * 1000) {
    dayWindow.windowStart = now;
    dayWindow.count = 0;
  }
  if (minuteWindow.count >= minuteCap || dayWindow.count >= dayCap) {
    // Aggregate, cooled-down warning -- not one line per rejected write.
    if (now - lastCapWarningAt > 60_000) {
      lastCapWarningAt = now;
      console.warn(
        JSON.stringify({
          event: "trace_evidence_write_capped",
          minuteCount: minuteWindow.count,
          dayCount: dayWindow.count,
          at: new Date(now).toISOString(),
        })
      );
    }
    return false;
  }
  minuteWindow.count += 1;
  dayWindow.count += 1;
  return true;
};

/** Test hook: resets the in-memory cap windows. */
export const resetTraceEvidenceWriteBudgetForTests = () => {
  minuteWindow.windowStart = 0;
  minuteWindow.count = 0;
  dayWindow.windowStart = 0;
  dayWindow.count = 0;
  lastCapWarningAt = 0;
};

const releaseSha = () =>
  process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || null;
// Deliberately NOT SENTRY_ENVIRONMENT. This name is stored on evidence a
// person later reads to decide where a reported error happened, and the
// feedback-automation policy forbids marking a staging deployment as a
// production resolution. A Sentry display alias must not be able to say which
// deployment produced a record.
const environmentName = () => resolveDeploymentEnvironment();

export type ChatErrorReportGrantInput = {
  /** Must be a trace this route minted itself (randomUUID at request start).
   * Client-supplied or fallback traces never reach this function. */
  traceId: string;
  routeClass: string;
  errorCode: string;
  httpStatus: number;
  phase?: string;
  /**
   * One of CHAT_FAILURE_LAYERS (lib/chatFailureLayer.ts).
   *
   * The field that keeps an evidence row honest about its subject. Without it
   * a storage 404 and a provider 404 are the same row, and the trace a user
   * reports reads as an outage at whichever provider happened to be named.
   */
  failureLayer?: string | null;
  /** What object storage answered, when the failure was a storage one. */
  storageStatus?: number | null;
  provider?: string | null;
  modelId?: string | null;
  retryable?: boolean | null;
  /** The caught Error, when one exists, for the Sentry capture. Message
   * bodies, request payloads and provider responses must not be passed. */
  error?: unknown;
};

export type ChatErrorReportGrant = {
  errorReportToken: string | null;
  occurrenceId: string | null;
};

const captureToSentry = (
  input: ChatErrorReportGrantInput,
  occurrenceId: string
): string | null => {
  try {
    if (!(input.error instanceof Error)) return null;
    const eventId = Sentry.captureException(input.error, {
      tags: {
        traceId: input.traceId,
        errorCode: input.errorCode,
        routeClass: input.routeClass,
        traceOccurrenceId: occurrenceId,
      },
    });
    return typeof eventId === "string" ? eventId : null;
  } catch {
    // Sentry being down must never change the user's error response.
    return null;
  }
};

const scheduleEvidenceWrite = (
  input: ChatErrorReportGrantInput,
  occurrenceId: string,
  sentryEventId: string | null
) => {
  void prisma.traceErrorEvidence
    .create({
      data: {
        occurrenceId,
        traceId: input.traceId,
        traceProvenance: TRACE_PROVENANCE.serverGenerated,
        environment: environmentName(),
        release: releaseSha(),
        routeClass: input.routeClass,
        phase: input.phase || null,
        failureLayer: input.failureLayer || null,
        storageStatus:
          Number.isSafeInteger(input.storageStatus) &&
          input.storageStatus! >= 100 &&
          input.storageStatus! <= 599
            ? input.storageStatus
            : null,
        errorCode: input.errorCode,
        classificationSource: ERROR_CLASSIFICATION_SOURCE.server,
        httpStatus: input.httpStatus,
        provider: input.provider || null,
        modelId: input.modelId || null,
        retryable: input.retryable ?? null,
        sentryEventId,
      },
    })
    .then(() => {
      console.info(
        JSON.stringify({
          event: "trace_evidence_recorded",
          occurrenceId,
          routeClass: input.routeClass,
          errorCode: input.errorCode,
          hasSentryEventId: Boolean(sentryEventId),
          at: new Date().toISOString(),
        })
      );
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: "trace_evidence_write_failed",
          occurrenceId,
          routeClass: input.routeClass,
          errorCode: input.errorCode,
          reason: error instanceof Error ? error.name : "unknown",
          at: new Date().toISOString(),
        })
      );
    });
};

/**
 * Central issuance point. Returns header-ready values; both are null when
 * signing is not configured (the feature fails closed while feedback itself
 * stays up) or when the error class is excluded from reporting entirely.
 */
export const issueChatErrorReportGrant = (
  input: ChatErrorReportGrantInput
): ChatErrorReportGrant => {
  const none: ChatErrorReportGrant = {
    errorReportToken: null,
    occurrenceId: null,
  };
  try {
    if (!input.traceId || !input.errorCode) return none;

    const recordability = traceEvidenceRecordability(
      input.errorCode,
      input.httpStatus
    );
    let occurrenceId: string | null = null;
    if (recordability.record && consumeWriteBudget(Date.now())) {
      occurrenceId = randomUUID();
      const sentryEventId = captureToSentry(input, occurrenceId);
      scheduleEvidenceWrite(input, occurrenceId, sentryEventId);
    }

    const errorReportToken = issueErrorReportToken({
      traceId: input.traceId,
      routeClass: input.routeClass,
      errorCode: input.errorCode,
      ...(occurrenceId ? { occurrenceId } : {}),
    });
    return { errorReportToken, occurrenceId };
  } catch {
    // Nothing in the grant path may fail the user's error response.
    return none;
  }
};

/** Retention cleanup, called from lib/maintenance.ts. Bounded by the same
 * 30-day window the provider error diagnostics already use. */
export const purgeExpiredTraceErrorEvidence = async () => {
  const result = await prisma.traceErrorEvidence.deleteMany({
    where: {
      occurredAt: {
        lt: new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000),
      },
    },
  });
  return result.count;
};
