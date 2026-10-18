import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

export const CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION =
  "chat-unified-optimizer-ledger-v1" as const;
export const CHAT_UNIFIED_OPTIMIZER_POLICY_VERSION = 1 as const;
export const CHAT_UNIFIED_OPTIMIZER_PURPOSE =
  "provider_free_validation" as const;

export const CHAT_UNIFIED_OPTIMIZER_ROLES = Object.freeze([
  "candidate_author",
  "case_author",
  "case_reviewer",
  "judge_primary",
  "judge_secondary",
  "coordinator",
] as const);
export type ChatUnifiedOptimizerRole =
  (typeof CHAT_UNIFIED_OPTIMIZER_ROLES)[number];

export const CHAT_UNIFIED_OPTIMIZER_TERMINAL_OUTCOMES = Object.freeze([
  "succeeded",
  "failed",
  "outcome_unknown",
] as const);
export type ChatUnifiedOptimizerTerminalOutcome =
  (typeof CHAT_UNIFIED_OPTIMIZER_TERMINAL_OUTCOMES)[number];

export const CHAT_UNIFIED_OPTIMIZER_QUEUED_CLOSE_REASONS = Object.freeze([
  "expired_before_dispatch",
  "cancelled_before_dispatch",
] as const);
export type ChatUnifiedOptimizerQueuedCloseReason =
  (typeof CHAT_UNIFIED_OPTIMIZER_QUEUED_CLOSE_REASONS)[number];

const uuid = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const sourceCommitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const opaqueRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);

export const chatUnifiedOptimizerRegistrationSchema = z.object({
  requestId: uuid,
  expectedBundleDigest: digest,
  sourceCommitSha,
  sourceRepositoryId: z.number().int().positive().safe().optional(),
  sourceBlobSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  sourceSha256: digest.optional(),
  deadlineAt: z.date(),
}).strict().superRefine((value, context) => {
  if (new Set([value.sourceRepositoryId === undefined,
    value.sourceBlobSha === undefined,
    value.sourceSha256 === undefined]).size !== 1) {
    context.addIssue({ code: "custom", message: "partial_source_pin" });
  }
});

export const chatUnifiedOptimizerClaimSchema = z.object({
  requestId: uuid,
  jobId: uuid,
}).strict();

export const chatUnifiedOptimizerQueuedCloseSchema = z.object({
  requestId: uuid,
  cycleId: uuid,
  reason: z.enum(CHAT_UNIFIED_OPTIMIZER_QUEUED_CLOSE_REASONS),
}).strict();

export const chatUnifiedOptimizerTerminalSchema = z.object({
  requestId: uuid,
  jobId: uuid,
  claimToken: uuid,
  outcome: z.enum(CHAT_UNIFIED_OPTIMIZER_TERMINAL_OUTCOMES),
  evidenceRef: opaqueRef.nullable(),
  evidencePayloadDigest: digest.nullable(),
}).strict().superRefine((value, context) => {
  const hasEvidence = value.evidenceRef !== null &&
    value.evidencePayloadDigest !== null;
  if ((value.evidenceRef === null) !==
      (value.evidencePayloadDigest === null)) {
    context.addIssue({ code: "custom", message: "partial_evidence" });
  }
  if (value.outcome === "outcome_unknown" && hasEvidence) {
    context.addIssue({ code: "custom", message: "unknown_has_evidence" });
  }
  if (value.outcome !== "outcome_unknown" && !hasEvidence) {
    context.addIssue({ code: "custom", message: "terminal_evidence_missing" });
  }
});

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export function chatUnifiedOptimizerRegistrationDigest(input: Readonly<{
  requestId: string;
  candidateDigest: string;
  bundleDigest: string;
  controlsDigest: string;
  schemaVersion: string;
  promptVersion: string;
  stageCandidateDigest: string;
  adapterConfigDigest: string;
  pricePinDigest: string;
  sourceCommitSha: string;
  sourceRepositoryId?: number;
  sourceBlobSha?: string;
  sourceSha256?: string;
  deadlineAt: Date;
}>): string {
  const sourcePinFields = [input.sourceRepositoryId,
    input.sourceBlobSha, input.sourceSha256];
  if (sourcePinFields.some(value => value !== undefined) &&
      sourcePinFields.some(value => value === undefined)) {
    throw new Error("optimizer_registration_source_pin_partial");
  }
  return sha256(canonicalBenchmarkJson({
    version: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
    policyVersion: CHAT_UNIFIED_OPTIMIZER_POLICY_VERSION,
    purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
    requestId: input.requestId,
    candidateDigest: input.candidateDigest,
    bundleDigest: input.bundleDigest,
    controlsDigest: input.controlsDigest,
    schemaVersion: input.schemaVersion,
    promptVersion: input.promptVersion,
    stageCandidateDigest: input.stageCandidateDigest,
    adapterConfigDigest: input.adapterConfigDigest,
    pricePinDigest: input.pricePinDigest,
    sourceCommitSha: input.sourceCommitSha,
    ...(input.sourceRepositoryId !== undefined ? {
      sourceRepositoryId: input.sourceRepositoryId,
      sourceBlobSha: input.sourceBlobSha,
      sourceSha256: input.sourceSha256,
    } : {}),
    deadlineAt: input.deadlineAt.toISOString(),
    roles: CHAT_UNIFIED_OPTIMIZER_ROLES,
    externalDispatchAuthorized: false,
    paidAuthorized: false,
    promotionAuthorized: false,
  }));
}

export function chatUnifiedOptimizerClaimDigest(input: Readonly<{
  requestId: string;
  jobId: string;
}>): string {
  return sha256(canonicalBenchmarkJson({
    version: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
    purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
    requestId: input.requestId,
    jobId: input.jobId,
    externalDispatchAuthorized: false,
    paidAuthorized: false,
  }));
}

export function chatUnifiedOptimizerQueuedCloseDigest(input: Readonly<{
  requestId: string;
  cycleId: string;
  reason: ChatUnifiedOptimizerQueuedCloseReason;
}>): string {
  return sha256(canonicalBenchmarkJson({
    version: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
    purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
    operation: "queued_before_dispatch_terminal",
    requestId: input.requestId,
    cycleId: input.cycleId,
    reason: input.reason,
    externalDispatchAuthorized: false,
    paidAuthorized: false,
    promotionAuthorized: false,
  }));
}

export function chatUnifiedOptimizerQueuedJobTerminalDigest(input: Readonly<{
  closeRequestDigest: string;
  cycleId: string;
  runId: string;
  jobId: string;
  role: ChatUnifiedOptimizerRole;
  reason: ChatUnifiedOptimizerQueuedCloseReason;
  evidenceRef: string;
  evidencePayloadDigest: string;
}>): string {
  return sha256(canonicalBenchmarkJson({
    version: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
    purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
    operation: "queued_before_dispatch_terminal",
    closeRequestDigest: input.closeRequestDigest,
    cycleId: input.cycleId,
    runId: input.runId,
    jobId: input.jobId,
    role: input.role,
    reason: input.reason,
    outcome: "failed",
    evidenceRef: input.evidenceRef,
    evidencePayloadDigest: input.evidencePayloadDigest,
    externalDispatchAuthorized: false,
    paidAuthorized: false,
    promotionAuthorized: false,
  }));
}

export function chatUnifiedOptimizerQueuedJobEvidenceDigest(input: Readonly<{
  closeRequestDigest: string;
  cycleId: string;
  runId: string;
  candidateId: string;
  jobId: string;
  role: ChatUnifiedOptimizerRole;
  reason: ChatUnifiedOptimizerQueuedCloseReason;
}>): string {
  return sha256(canonicalBenchmarkJson({
    version: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
    purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
    fact: "queued_before_dispatch_terminal",
    closeRequestDigest: input.closeRequestDigest,
    cycleId: input.cycleId,
    runId: input.runId,
    candidateId: input.candidateId,
    jobId: input.jobId,
    role: input.role,
    reason: input.reason,
    externalDispatchOccurred: false,
    paidCallOccurred: false,
  }));
}

export function chatUnifiedOptimizerTerminalDigest(input: Readonly<{
  requestId: string;
  jobId: string;
  claimToken: string;
  outcome: ChatUnifiedOptimizerTerminalOutcome;
  evidenceRef: string | null;
  evidencePayloadDigest: string | null;
}>): string {
  return sha256(canonicalBenchmarkJson({
    version: CHAT_UNIFIED_OPTIMIZER_LEDGER_VERSION,
    purpose: CHAT_UNIFIED_OPTIMIZER_PURPOSE,
    requestId: input.requestId,
    jobId: input.jobId,
    claimToken: input.claimToken,
    outcome: input.outcome,
    evidenceRef: input.evidenceRef,
    evidencePayloadDigest: input.evidencePayloadDigest,
    externalDispatchAuthorized: false,
    paidAuthorized: false,
    promotionAuthorized: false,
  }));
}
