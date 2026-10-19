import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  CHAT_UNIFIED_OPTIMIZER_BUNDLE_VERSION,
  CHAT_UNIFIED_OPTIMIZER_CANDIDATE_VERSION,
  CHAT_UNIFIED_OPTIMIZER_CONTROLS,
} from "@/lib/chatUnifiedOptimizerCandidate";
import {
  acceptChatUnifiedOptimizerCandidateGenerationOutput,
  isChatUnifiedOptimizerCandidateGenerationResult,
  prepareChatUnifiedOptimizerCandidateGeneration,
  type ChatUnifiedOptimizerCandidateGenerationResult,
} from "@/lib/chatUnifiedOptimizerCandidateGeneration";
import {
  chatUnifiedOptimizerClaimDigest,
  chatUnifiedOptimizerRegistrationDigest,
  chatUnifiedOptimizerTerminalDigest,
} from "@/lib/chatUnifiedOptimizerLedgerCore";
import {
  ChatUnifiedOptimizerLedgerError,
  claimChatUnifiedOptimizerRoleJob,
  readChatUnifiedOptimizerClaim,
  readChatUnifiedOptimizerRegistration,
  readChatUnifiedOptimizerTerminal,
  recordChatUnifiedOptimizerRoleJobTerminal,
  registerChatUnifiedOptimizerCycle,
} from "@/lib/chatUnifiedOptimizerLedgerStore";
import { prisma } from "@/lib/prisma";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

const STORE_VERSION =
  "chat-unified-optimizer-candidate-generation-store-v1" as const;
const EVIDENCE_KIND = "fixed_proposal_validation" as const;
const uuid = z.string().uuid();
const requestIdsSchema = z.object({
  registration: uuid,
  claim: uuid,
  terminal: uuid,
}).strict().superRefine((value, context) => {
  if (new Set(Object.values(value)).size !== 3) {
    context.addIssue({ code: "custom", message: "request_ids_not_distinct" });
  }
});

type LedgerPort = Readonly<{
  register: typeof registerChatUnifiedOptimizerCycle;
  readRegistration: typeof readChatUnifiedOptimizerRegistration;
  claim: typeof claimChatUnifiedOptimizerRoleJob;
  readClaim: typeof readChatUnifiedOptimizerClaim;
  readClaimCheckpoint: (input: Readonly<{
    registrationRequestId: string;
    registrationDigest: string;
    claimRequestId: string;
    claimDigest: string;
    jobId: string;
  }>) => Promise<Readonly<{
    cycleId: string;
    runId: string;
    jobId: string;
    role: "candidate_author";
    state: "claimed" | "succeeded" | "failed" | "outcome_unknown";
    claimToken: string;
    deadlineAt: Date;
    claimedAt: Date;
  }> | null>;
  terminal: typeof recordChatUnifiedOptimizerRoleJobTerminal;
  readTerminal: typeof readChatUnifiedOptimizerTerminal;
}>;

const readClaimCheckpoint: LedgerPort["readClaimCheckpoint"] = async input => {
  const rows = await prisma.$queryRaw<Array<{
    cycleId: string;
    runId: string;
    jobId: string;
    role: "candidate_author";
    state: "claimed" | "succeeded" | "failed" | "outcome_unknown";
    claimToken: string;
    deadlineAt: Date;
    claimedAt: Date;
  }>>`
    SELECT c."id"::text AS "cycleId", r."id"::text AS "runId",
      j."id"::text AS "jobId", j."role", j."state",
      j."claimToken"::text AS "claimToken", j."deadlineAt", j."claimedAt"
    FROM "ChatUnifiedOptimizerCycle" c
    JOIN "ChatUnifiedOptimizerRun" r
      ON r."cycleId" = c."id" AND r."ordinal" = 1
    JOIN "ChatUnifiedOptimizerRoleJob" j
      ON j."runId" = r."id" AND j."role" = 'candidate_author'
    WHERE c."registrationRequestId" = ${input.registrationRequestId}::uuid
      AND c."registrationDigest" = ${input.registrationDigest}
      AND j."id" = ${input.jobId}::uuid
      AND j."claimRequestId" = ${input.claimRequestId}::uuid
      AND j."claimRequestDigest" = ${input.claimDigest}
      AND j."claimToken" IS NOT NULL
  `;
  return rows[0] ?? null;
};

const defaultLedger: LedgerPort = Object.freeze({
  register: registerChatUnifiedOptimizerCycle,
  readRegistration: readChatUnifiedOptimizerRegistration,
  claim: claimChatUnifiedOptimizerRoleJob,
  readClaim: readChatUnifiedOptimizerClaim,
  readClaimCheckpoint,
  terminal: recordChatUnifiedOptimizerRoleJobTerminal,
  readTerminal: readChatUnifiedOptimizerTerminal,
});

type StopStage = "registration" | "claim" | "terminal";
type ReadbackOutcome = "committed" | "not_found" | "conflict" |
  "readback_unavailable";

export type ChatUnifiedOptimizerCandidateGenerationStored = Readonly<{
  outcome: "recorded";
  completion: "write" | "readback" | "replay";
  cycleId: string;
  runId: string;
  candidateAuthorJobId: string;
  registrationDigest: string;
  claimDigest: string;
  terminalDigest: string;
  proposalValidationReceipt: Readonly<{
    version: typeof STORE_VERSION;
    kind: typeof EVIDENCE_KIND;
    evidenceRef: string;
    evidencePayloadDigest: string;
    sourceRepositoryId: number;
    sourceCommitSha: string;
    sourceBlobSha: string;
    sourceSha256: string;
    proposalDigest: string;
    resultSha256: string;
    candidateDigest: string;
    bundleDigest: string;
    authorshipVerified: false;
    authorExecutionObserved: false;
    externalDispatchAuthorized: false;
    paidAuthorized: false;
    runtimeAuthorized: false;
    promotionAuthorized: false;
    proposalValidationEvidenceRecorded: true;
  }>;
}>;

export type ChatUnifiedOptimizerCandidateGenerationStopped = Readonly<{
  outcome: "stopped_for_readback";
  stage: StopStage;
  readbackOutcome: ReadbackOutcome;
  registrationDigest: string;
  claimDigest: string | null;
  terminalDigest: string | null;
  externalDispatchAuthorized: false;
  paidAuthorized: false;
  runtimeAuthorized: false;
  promotionAuthorized: false;
}>;

const unavailable = (): never => {
  throw new Error("optimizer_candidate_generation_store_unavailable");
};

/**
 * These aliases keep candidate preparation, proposal validation and durable
 * recording on one server module instance. That preserves the generation
 * module's private WeakMap/WeakSet capability when a TypeScript runtime loads
 * path aliases and direct file imports through different module URLs.
 */
export const prepareChatUnifiedOptimizerCandidateGenerationForStore =
  prepareChatUnifiedOptimizerCandidateGeneration;
export const acceptChatUnifiedOptimizerCandidateGenerationOutputForStore =
  acceptChatUnifiedOptimizerCandidateGenerationOutput;
export const ChatUnifiedOptimizerCandidateGenerationLedgerError =
  ChatUnifiedOptimizerLedgerError;

const sha256 = (value: unknown): string => createHash("sha256")
  .update(canonicalBenchmarkJson(value), "utf8").digest("hex");

const stop = (input: Omit<ChatUnifiedOptimizerCandidateGenerationStopped,
  "outcome" | "externalDispatchAuthorized" | "paidAuthorized" |
  "runtimeAuthorized" | "promotionAuthorized">):
  ChatUnifiedOptimizerCandidateGenerationStopped => Object.freeze({
    outcome: "stopped_for_readback" as const,
    ...input,
    externalDispatchAuthorized: false as const,
    paidAuthorized: false as const,
    runtimeAuthorized: false as const,
    promotionAuthorized: false as const,
  });

const isKnownRefusal = (error: unknown): boolean =>
  error instanceof ChatUnifiedOptimizerLedgerError;

const readOnce = async <T extends Readonly<{ outcome: string }>>(
  read: () => Promise<T>,
): Promise<T | Readonly<{ outcome: "readback_unavailable" }>> => {
  try {
    return await read();
  } catch {
    return { outcome: "readback_unavailable" } as const;
  }
};

const validateGeneration = (
  value: ChatUnifiedOptimizerCandidateGenerationResult,
): ChatUnifiedOptimizerCandidateGenerationResult => {
  if (!isChatUnifiedOptimizerCandidateGenerationResult(value)) {
    return unavailable();
  }
  const { receipt, bundle } = value;
  if (!/^[0-9a-f]{64}$/.test(receipt.resultSha256) ||
      receipt.authorshipVerified !== false ||
      receipt.durableReceiptRecorded !== false ||
      receipt.dispatchAuthorized !== false ||
      receipt.runtimeAuthorized !== false ||
      receipt.candidateDigest !== bundle.candidateDigest ||
      receipt.bundleDigest !== bundle.bundleDigest) return unavailable();
  return value;
};

/**
 * Persists only the already validated public-source candidate identity and a
 * content-free fixed-proposal validation fact. It performs no author/model
 * dispatch. Any unknown write result causes one exact read and an immediate
 * stop; callers must never interpret this receipt as verified authorship.
 */
export async function recordChatUnifiedOptimizerCandidateGeneration(
  input: Readonly<{
    generation: ChatUnifiedOptimizerCandidateGenerationResult;
    requestIds: Readonly<{
      registration: string;
      claim: string;
      terminal: string;
    }>;
    deadlineAt: Date;
  }>,
  ledger: LedgerPort = defaultLedger,
): Promise<ChatUnifiedOptimizerCandidateGenerationStored |
  ChatUnifiedOptimizerCandidateGenerationStopped> {
  const generation = validateGeneration(input.generation);
  const parsedIds = requestIdsSchema.safeParse(input.requestIds);
  if (!parsedIds.success || !(input.deadlineAt instanceof Date) ||
      !Number.isFinite(input.deadlineAt.getTime())) return unavailable();
  const deadlineAt = new Date(input.deadlineAt.getTime());
  const { bundle, receipt } = generation;
  const registrationDigest = chatUnifiedOptimizerRegistrationDigest({
    requestId: parsedIds.data.registration,
    candidateDigest: bundle.candidateDigest,
    bundleDigest: bundle.bundleDigest,
    controlsDigest: bundle.candidate.controlsDigest,
    schemaVersion: CHAT_UNIFIED_OPTIMIZER_CONTROLS.schemaVersion,
    promptVersion: CHAT_UNIFIED_OPTIMIZER_CONTROLS.promptVersion,
    stageCandidateDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS.stageCandidateDigest,
    adapterConfigDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS.adapterConfigDigest,
    pricePinDigest: CHAT_UNIFIED_OPTIMIZER_CONTROLS.pricePinDigest,
    sourceCommitSha: receipt.sourceCommitSha,
    sourceRepositoryId: receipt.sourceRepositoryId,
    sourceBlobSha: receipt.sourceBlobSha,
    sourceSha256: receipt.sourceSha256,
    deadlineAt,
  });

  let registration: Awaited<ReturnType<LedgerPort["register"]>>;
  try {
    registration = await ledger.register({
      requestId: parsedIds.data.registration,
      candidateBundleJson: canonicalBenchmarkJson(bundle),
      expectedBundleDigest: bundle.bundleDigest,
      sourceCommitSha: receipt.sourceCommitSha,
      sourceRepositoryId: receipt.sourceRepositoryId,
      sourceBlobSha: receipt.sourceBlobSha,
      sourceSha256: receipt.sourceSha256,
      deadlineAt,
    });
  } catch (error) {
    if (isKnownRefusal(error)) throw error;
    const readback = await readOnce(() => ledger.readRegistration({
      requestId: parsedIds.data.registration,
      registrationDigest,
    }));
    return stop({ stage: "registration",
      readbackOutcome: readback.outcome as ReadbackOutcome,
      registrationDigest, claimDigest: null, terminalDigest: null });
  }
  if (registration.registrationDigest !== registrationDigest) {
    return unavailable();
  }
  const candidateAuthorJobId = registration.jobIds.candidate_author;
  const claimDigest = chatUnifiedOptimizerClaimDigest({
    requestId: parsedIds.data.claim,
    jobId: candidateAuthorJobId,
  });

  let claim: Awaited<ReturnType<LedgerPort["claim"]>>;
  let checkpoint: Awaited<ReturnType<LedgerPort["readClaimCheckpoint"]>>;
  try {
    checkpoint = await ledger.readClaimCheckpoint({
      registrationRequestId: parsedIds.data.registration,
      registrationDigest,
      claimRequestId: parsedIds.data.claim,
      claimDigest,
      jobId: candidateAuthorJobId,
    });
  } catch {
    return stop({ stage: "claim", readbackOutcome: "readback_unavailable",
      registrationDigest, claimDigest, terminalDigest: null });
  }
  if (checkpoint) {
    if (checkpoint.cycleId !== registration.cycleId ||
        checkpoint.runId !== registration.runId ||
        checkpoint.jobId !== candidateAuthorJobId ||
        checkpoint.role !== "candidate_author" ||
        !["claimed", "succeeded"].includes(checkpoint.state)) {
      return unavailable();
    }
    claim = { outcome: "replayed", jobId: checkpoint.jobId,
      role: checkpoint.role, claimToken: checkpoint.claimToken, claimDigest,
      deadlineAt: checkpoint.deadlineAt,
      claimedAt: checkpoint.claimedAt };
  } else {
    try {
      claim = await ledger.claim({
        requestId: parsedIds.data.claim,
        jobId: candidateAuthorJobId,
      });
    } catch (error) {
      if (isKnownRefusal(error)) throw error;
      const readback = await readOnce(() => ledger.readClaim({
        requestId: parsedIds.data.claim,
        claimDigest,
      }));
      return stop({ stage: "claim",
        readbackOutcome: readback.outcome as ReadbackOutcome,
        registrationDigest, claimDigest, terminalDigest: null });
    }
  }
  if (claim.claimDigest !== claimDigest ||
      claim.jobId !== candidateAuthorJobId ||
      claim.role !== "candidate_author") return unavailable();

  const proposalValidationFacts = Object.freeze({
    version: STORE_VERSION,
    kind: EVIDENCE_KIND,
    sourceCommitSha: receipt.sourceCommitSha,
    sourceRepositoryId: receipt.sourceRepositoryId,
    sourceBlobSha: receipt.sourceBlobSha,
    sourceSha256: receipt.sourceSha256,
    proposalDigest: receipt.proposalDigest,
    resultSha256: receipt.resultSha256,
    candidateDigest: receipt.candidateDigest,
    bundleDigest: receipt.bundleDigest,
    authorshipVerified: false as const,
    authorExecutionObserved: false as const,
    externalDispatchAuthorized: false as const,
    paidAuthorized: false as const,
    runtimeAuthorized: false as const,
    promotionAuthorized: false as const,
    proposalValidationEvidenceRecorded: true as const,
  });
  const evidencePayloadDigest = sha256({
    ...proposalValidationFacts,
    generationRequestId: receipt.requestId,
    authorTaskId: receipt.authorTaskId,
    generationRequestDigest: receipt.requestDigest,
    registrationRequestId: parsedIds.data.registration,
    claimRequestId: parsedIds.data.claim,
    terminalRequestId: parsedIds.data.terminal,
    registrationDigest,
    claimDigest,
    candidateVersion: CHAT_UNIFIED_OPTIMIZER_CANDIDATE_VERSION,
    bundleVersion: CHAT_UNIFIED_OPTIMIZER_BUNDLE_VERSION,
    deadlineAt: deadlineAt.toISOString(),
  });
  const evidenceRef = `optimizer:proposal-result:${receipt.resultSha256}`;
  const fixedReceipt = Object.freeze({ ...proposalValidationFacts,
    evidenceRef, evidencePayloadDigest });
  const terminalDigest = chatUnifiedOptimizerTerminalDigest({
    requestId: parsedIds.data.terminal,
    jobId: candidateAuthorJobId,
    claimToken: claim.claimToken,
    outcome: "succeeded",
    evidenceRef,
    evidencePayloadDigest,
  });

  let terminal: Awaited<ReturnType<LedgerPort["terminal"]>>;
  try {
    terminal = await ledger.terminal({
      requestId: parsedIds.data.terminal,
      jobId: candidateAuthorJobId,
      claimToken: claim.claimToken,
      outcome: "succeeded",
      evidenceRef,
      evidencePayloadDigest,
    });
  } catch (error) {
    if (isKnownRefusal(error)) throw error;
    const readback = await readOnce(() => ledger.readTerminal({
      requestId: parsedIds.data.terminal,
      terminalDigest,
    }));
    if (readback.outcome !== "committed") {
      return stop({ stage: "terminal",
        readbackOutcome: readback.outcome as ReadbackOutcome,
        registrationDigest, claimDigest, terminalDigest });
    }
    return Object.freeze({ outcome: "recorded" as const,
      completion: "readback" as const, cycleId: registration.cycleId,
      runId: registration.runId, candidateAuthorJobId,
      registrationDigest, claimDigest, terminalDigest,
      proposalValidationReceipt: fixedReceipt });
  }
  if (terminal.terminalDigest !== terminalDigest ||
      terminal.jobId !== candidateAuthorJobId ||
      terminal.terminalOutcome !== "succeeded") return unavailable();
  return Object.freeze({ outcome: "recorded" as const,
    completion: terminal.outcome === "replayed" ? "replay" as const :
      "write" as const, cycleId: registration.cycleId,
    runId: registration.runId, candidateAuthorJobId,
    registrationDigest, claimDigest, terminalDigest,
    proposalValidationReceipt: fixedReceipt });
}
