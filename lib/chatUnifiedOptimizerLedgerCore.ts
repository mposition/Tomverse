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

const uuid = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const sourceCommitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const opaqueRef = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);

export const chatUnifiedOptimizerRegistrationSchema = z.object({
  requestId: uuid,
  expectedBundleDigest: digest,
  sourceCommitSha,
  deadlineAt: z.date(),
}).strict();

export const chatUnifiedOptimizerClaimSchema = z.object({
  requestId: uuid,
  jobId: uuid,
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
  deadlineAt: Date;
}>): string {
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
