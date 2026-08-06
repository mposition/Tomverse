import "server-only";

// Persistence for dual-estimate shadow samples (G1 step 3).
//
// Kept apart from lib/tokenEstimateShadow.ts, which stays free of Prisma so the
// contract -- eligibility, cohort classification, provenance -- can be tested
// and reasoned about without a database.
//
// Three properties this module has to hold, because it runs beside the chat
// request path:
//
//   1. It never throws into the caller. Telemetry that can fail a paid request
//      is worse than no telemetry, so every failure is swallowed and reported
//      once through the operational path rather than propagated.
//   2. It is off unless explicitly enabled. A new write on the reservation and
//      settlement paths starts disabled and is turned on deliberately.
//   3. It never records prompt text. The caller passes counts and identifiers;
//      there is no parameter here that could carry a conversation.

import { prisma } from "@/lib/prisma";
import {
  type ContentCohort,
  type InputUsageSource,
  type ShadowAttemptOutcome,
} from "@/lib/tokenEstimateShadow";
import { type TokenizerFamily } from "@/lib/chatTokenEstimate";

/**
 * Shadow recording is opt-in. Absent or anything other than "true" leaves both
 * write paths inert, which is how this ships.
 */
export const isTokenEstimateShadowEnabled = () =>
  process.env.TOKEN_ESTIMATE_SHADOW_ENABLED === "true";

/**
 * The calibration under evaluation. Named here rather than at the call sites so
 * one edit moves every recorder, and so a candidate can never be mistaken for
 * the active calibration -- that one is ACTIVE_ESTIMATOR_VERSION, and it is the
 * only one anything acts on.
 */
export const SHADOW_CANDIDATE_ESTIMATOR_VERSION = "hangul_segment_v2";

export type ShadowReservationRecord = {
  attemptId: string;
  modelId: string;
  providerId: string;
  controlEstimatorVersion: string;
  controlRawEstimatedInputTokens: number;
  candidateEstimatorVersion: string;
  candidateRawEstimatedInputTokens: number;
  reservedInputTokens: number;
  tokenizerFamily: TokenizerFamily;
  contentCohort: ContentCohort;
  hangulCharacters: number;
  hanKanaCharacters: number;
  nonCjkBytes: number;
  nonCjkSymbolRatio: number;
  isFallbackAttempt?: boolean;
};

export type ShadowSettlementRecord = {
  attemptId: string;
  providerReportedInputTokens: number | null;
  inputUsageSource: InputUsageSource;
  outcome: ShadowAttemptOutcome;
  isPartial: boolean;
  isCancelled: boolean;
};

// One warning per process, not one per request: a database that is refusing
// telemetry writes will refuse every one of them, and a log line per chat turn
// would bury the signal it is trying to raise.
let warnedOnce = false;
const swallow = (stage: string, cause: unknown) => {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(
    `[token-estimate-shadow] ${stage} failed; shadow sampling is degraded for this process.`,
    cause instanceof Error ? cause.message : cause
  );
};

/**
 * Written when the reservation is made, because the candidate estimate depends
 * on the request text and settlement no longer has it.
 *
 * `attemptId` is unique, so a duplicate is ignored rather than treated as an
 * error: a retried write must not become a second sample for one attempt.
 */
export const recordShadowReservation = async (record: ShadowReservationRecord) => {
  if (!isTokenEstimateShadowEnabled()) return;
  try {
    await prisma.tokenEstimateShadowSample.upsert({
      where: { attemptId: record.attemptId },
      create: {
        ...record,
        isFallbackAttempt: record.isFallbackAttempt ?? false,
      },
      update: {},
    });
  } catch (cause) {
    swallow("reservation record", cause);
  }
};

/**
 * Completes the sample once the provider has answered. Only ever updates a row
 * the reservation path created: a settlement with no matching sample is a
 * turn that was not shadowed, and inventing a row for it would fabricate a
 * control estimate nobody made.
 */
export const recordShadowSettlement = async (record: ShadowSettlementRecord) => {
  if (!isTokenEstimateShadowEnabled()) return;
  try {
    await prisma.tokenEstimateShadowSample.updateMany({
      where: { attemptId: record.attemptId },
      data: {
        providerReportedInputTokens: record.providerReportedInputTokens,
        inputUsageSource: record.inputUsageSource,
        outcome: record.outcome,
        isPartial: record.isPartial,
        isCancelled: record.isCancelled,
        settledAt: new Date(),
      },
    });
  } catch (cause) {
    swallow("settlement record", cause);
  }
};
