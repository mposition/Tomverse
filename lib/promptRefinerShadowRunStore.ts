import "server-only";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import { Prisma, type ModelRegistryEntry } from "@prisma/client";

import corpusJson from "@/docs/ops/prompt-refiner-shadow/corpus-v1.json";
import evidenceSpecJson from "@/docs/ops/prompt-refiner-shadow/evidence-spec-v1.json";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
    ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
    adminAuditEntryHashVariants,
    adminAuditIntegrityKeys,
} from "@/lib/adminAuditIntegrityCore";
import { getModelPricingProfile } from "@/lib/modelPricing";
import { registryRowToModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";
import {
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
    PROMPT_REFINER_MAX_INPUT_TOKENS,
    PROMPT_REFINER_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    PROMPT_REFINER_RETRY_COUNT,
    PROMPT_REFINER_TIMEOUT_MS,
    promptRefinerExecutionContractProblems,
    promptRefinerTerminalReceiptFacts,
    type PromptRefinerTerminalReason,
} from "@/lib/promptRefinerExecutionContract";
import {
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
    promptRefinerReservationBindingMatches,
    promptRefinerReservationIdentifiersAreValid,
    promptRefinerReservationStageProblems,
    type PromptRefinerReservationBinding,
} from "@/lib/promptRefinerReservationCore";
import {
    loadPromptRefinerStageAdmissionFacts,
    promptRefinerStageAuthorizationIsValid,
    promptRefinerStoredStageMatchesRuntime,
    readExactCheckoutFile,
} from "@/lib/promptRefinerStageAdmission";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import {
    PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
    PROMPT_REFINER_SHADOW_CASE_IDS,
    PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG,
    PROMPT_REFINER_SHADOW_RUN_CONFIRMATION,
    PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
    PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION,
    PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
    PROMPT_REFINER_SHADOW_RUN_ID,
    PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
    PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_FILE_BYTES,
    PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_TOTAL_BYTES,
    PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS,
    PROMPT_REFINER_SHADOW_RUN_SWEEP_BATCH,
    PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS,
    PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
    PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
    PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
    buildPromptRefinerShadowRunPreviewBinding,
    buildPromptRefinerShadowRunSourceManifest,
    promptRefinerShadowRunContractProblems,
    promptRefinerShadowRunPreviewBindingDigest,
    type PromptRefinerShadowRunSourceManifest,
} from "@/lib/promptRefinerShadowRunContract";
import {
    aggregatePromptRefinerShadowStoredEvidence,
    evaluatePromptRefinerShadowCaseEvidence,
    PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS,
    PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
    validatePromptRefinerShadowCaseEvidence,
    validatePromptRefinerShadowEvidenceSpec,
    type PromptRefinerShadowCaseEvidence,
    type PromptRefinerShadowEvidenceBundle,
} from "@/lib/promptRefinerShadowEvidenceCore";
import {
    PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
    validatePromptRefinerShadowCorpus,
} from "@/lib/promptRefinerShadowHarness";
import {
    writePromptRefinerDispatchAudit,
    writePromptRefinerTerminalAudit,
} from "@/lib/promptRefinerShadowSystemAudit";

const shadowCorpus = validatePromptRefinerShadowCorpus(corpusJson);
const shadowEvidenceSpec = validatePromptRefinerShadowEvidenceSpec(
    evidenceSpecJson
);

type PromptRefinerShadowDispatchFact = {
    requestId: string;
    adapterVersion: string;
    provider: string;
    modelId: string;
    apiModelId: string;
    maxOutputTokens: number;
    timeoutMs: number;
    retryCount: number;
    tokenizerPackage: string;
    tokenizerPackageVersion: string;
    tokenizerEncoding: string;
    admissionInputTokens: number;
};

type PromptRefinerShadowUsage = {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    costUpperBoundMicroUsd: number | null;
};

const RUN_APPROVAL_ACTION = "prompt_refiner.shadow_run.approved";
const RUN_APPROVAL_TARGET = "PromptRefinerShadowRun";
const RUN_APPROVAL_SUMMARY =
    "Approved one bounded Prompt Refiner staging shadow run.";
const DISPATCH_TERMINAL_REASONS = new Set<PromptRefinerTerminalReason>([
    "suggested",
    "provider_error",
    "timeout",
    "invalid_response",
    "empty_response",
    "no_change",
    "cancelled_after_dispatch",
    "unknown_after_dispatch",
]);

type StoredRun = {
    id: string;
    stageId: string;
    runContractVersion: string;
    runContractDigest: string;
    corpusDigest: string;
    evidenceSpecDigest: string | null;
    adapterVersion: string;
    status: string;
    perRequestCostMicroUsd: bigint;
    maxDispatches: number;
    costCeilingMicroUsd: bigint;
    dispatchCount: number;
    terminalCount: number;
    knownActualCostMicroUsd: bigint;
    runtimeCommitSha: string;
    runtimeDeploymentId: string;
    runtimeSourceManifest: unknown;
    runtimeSourceManifestDigest: string;
    previewBindingDigest: string;
    approvedBy: string;
    approvedAt: Date;
    approvalExpiresAt: Date;
    authorizationAuditLogId: string;
};

type AuditRow = {
    actorUserId: string | null;
    actorEmail: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    summary: string;
    metadata: unknown;
    ipAddress: string | null;
    userAgent: string | null;
    previousHash: string | null;
    entryHash: string | null;
    createdAt: Date;
};

export class PromptRefinerShadowRunError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "PromptRefinerShadowRunError";
    }
}

const refuse = (status: number, code: string, message: string): never => {
    throw new PromptRefinerShadowRunError(status, code, message);
};

const dbClock = async (tx: Prisma.TransactionClient): Promise<Date> => {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    if (!rows[0]) throw new Error("prompt_refiner_shadow_run_db_clock_unavailable");
    return rows[0].now;
};

const lockStage = async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "PromptRefinerReservationStage"
        WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
        FOR UPDATE
    `;
    if (rows.length !== 1) return null;
    return tx.promptRefinerReservationStage.findUnique({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
};

const lockAndValidateRegistry = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`LOCK TABLE "ModelRegistryEntry" IN SHARE MODE`;
    const row = await tx.modelRegistryEntry.findUnique({
        where: { id: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId },
    });
    if (!row) {
        refuse(409, "PROMPT_REFINER_SHADOW_RUN_MODEL_MISSING", "Pinned model registry row is missing.");
    }
    let model;
    try {
        model = registryRowToModel(row as ModelRegistryEntry);
    } catch {
        refuse(409, "PROMPT_REFINER_SHADOW_RUN_MODEL_INVALID", "Pinned model registry row is invalid.");
    }
    const pricing = getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
    if (promptRefinerExecutionContractProblems({ model, pricing }).length > 0) {
        refuse(409, "PROMPT_REFINER_SHADOW_RUN_EXECUTION_DRIFT", "Pinned model or pricing contract drifted.");
    }
};

const readRunSourceFiles = async (
    root: string
): Promise<ReadonlyMap<string, Uint8Array>> => {
    const files = new Map<string, Uint8Array>();
    let totalSizeBytes = 0;
    for (const path of PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS) {
        const remaining =
            PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_TOTAL_BYTES - totalSizeBytes;
        if (remaining <= 0) {
            refuse(503, "PROMPT_REFINER_SHADOW_RUN_SOURCE_SIZE", "Run source total exceeds the contract.");
        }
        const bytes = await readExactCheckoutFile(root, path, {
            maxBytes: Math.min(
                PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_FILE_BYTES,
                remaining
            ),
        });
        totalSizeBytes += bytes.byteLength;
        files.set(path, bytes);
    }
    return files;
};

type RunRuntimeFacts = {
    stageFacts: Awaited<ReturnType<typeof loadPromptRefinerStageAdmissionFacts>>;
    runSourceManifest: PromptRefinerShadowRunSourceManifest;
    runSourceManifestDigest: string;
};

export const loadPromptRefinerShadowRunRuntimeFacts = async (): Promise<RunRuntimeFacts> => {
    if (promptRefinerShadowRunContractProblems().length > 0) {
        refuse(409, "PROMPT_REFINER_SHADOW_RUN_CONTRACT_DRIFT", "The run contract drifted.");
    }
    const stageFacts = await loadPromptRefinerStageAdmissionFacts();
    const source = buildPromptRefinerShadowRunSourceManifest({
        commitSha: stageFacts.runtimeCommitSha,
        files: await readRunSourceFiles(process.cwd()),
    });
    return {
        stageFacts,
        runSourceManifest: source.manifest,
        runSourceManifestDigest: source.manifestDigest,
    };
};

const runApprovalMetadata = (run: StoredRun) => ({
    stageId: run.stageId,
    runContractVersion: run.runContractVersion,
    runContractDigest: run.runContractDigest,
    corpusDigest: run.corpusDigest,
    evidenceSpecDigest: run.evidenceSpecDigest,
    adapterVersion: run.adapterVersion,
    runtimeSourceManifestDigest: run.runtimeSourceManifestDigest,
    previewBindingDigest: run.previewBindingDigest,
    runtimeDeploymentId: run.runtimeDeploymentId,
    runtimeCommitSha: run.runtimeCommitSha,
    perRequestCostMicroUsd: Number(run.perRequestCostMicroUsd),
    maxDispatches: run.maxDispatches,
    costCeilingMicroUsd: Number(run.costCeilingMicroUsd),
    timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
    retryCount: PROMPT_REFINER_RETRY_COUNT,
    unknownOutcomePolicy: "stop_no_redispatch",
    approvedAt: run.approvedAt.toISOString(),
    approvalExpiresAt: run.approvalExpiresAt.toISOString(),
    executionAdmitted: true,
    productAdapterReady: false,
});

export const promptRefinerShadowRunAuthorizationAuditEntryIsValid = (
    run: StoredRun,
    audit: AuditRow,
    keys: readonly string[]
): boolean => {
    if (
        keys.length === 0 ||
        !audit.entryHash ||
        audit.actorUserId !== run.approvedBy ||
        audit.action !== RUN_APPROVAL_ACTION ||
        audit.targetType !== RUN_APPROVAL_TARGET ||
        audit.targetId !== run.id ||
        audit.summary !== RUN_APPROVAL_SUMMARY ||
        canonicalBenchmarkJson(audit.metadata ?? null) !==
            canonicalBenchmarkJson(runApprovalMetadata(run))
    ) {
        return false;
    }
    const hashInput = {
        previousHash: audit.previousHash,
        actorUserId: audit.actorUserId,
        actorEmail: audit.actorEmail,
        action: audit.action,
        targetType: audit.targetType,
        targetId: audit.targetId,
        summary: audit.summary,
        metadata: audit.metadata ?? null,
        ipAddress: audit.ipAddress,
        userAgent: audit.userAgent,
        createdAt: audit.createdAt.toISOString(),
    };
    return keys.some((key) => {
        const variants = adminAuditEntryHashVariants(hashInput, key);
        return ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.some(
            (order) => variants[order] === audit.entryHash
        );
    });
};

const runAuthorizationIsValid = async (
    tx: Prisma.TransactionClient,
    run: StoredRun
): Promise<boolean> => {
    const keys = adminAuditIntegrityKeys(process.env);
    if (keys.length === 0 || !run.authorizationAuditLogId) return false;
    const audit = await tx.adminAuditLog.findUnique({
        where: { id: run.authorizationAuditLogId },
    });
    if (
        !audit ||
        !promptRefinerShadowRunAuthorizationAuditEntryIsValid(run, audit, keys)
    ) {
        return false;
    }
    if (!audit.previousHash) return true;
    const predecessor = await tx.adminAuditLog.findUnique({
        where: { entryHash: audit.previousHash },
        select: { entryHash: true },
    });
    return predecessor?.entryHash === audit.previousHash;
};

const runMatchesRuntime = (
    run: StoredRun,
    facts: RunRuntimeFacts,
    stage: { runtimeSourceManifestDigest: string; approvalExpiresAt: Date },
    now: Date
): boolean => {
    const binding = buildPromptRefinerShadowRunPreviewBinding({
        stageRuntimeSourceManifestDigest: stage.runtimeSourceManifestDigest,
        runSourceManifestDigest: facts.runSourceManifestDigest,
        deploymentId: facts.stageFacts.runtimeDeploymentId,
        commitSha: facts.stageFacts.runtimeCommitSha,
        stageApprovalExpiresAt: stage.approvalExpiresAt,
    });
    return (
        run.id === PROMPT_REFINER_SHADOW_RUN_ID &&
        run.stageId === PROMPT_REFINER_RESERVATION_STAGE_ID &&
        run.runContractVersion === PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION &&
        run.runContractDigest === PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST &&
        run.corpusDigest === PROMPT_REFINER_SHADOW_CORPUS_DIGEST &&
        run.evidenceSpecDigest === PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST &&
        run.adapterVersion === PROMPT_REFINER_SHADOW_ADAPTER_VERSION &&
        ["approved", "running"].includes(run.status) &&
        run.perRequestCostMicroUsd ===
            BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD) &&
        run.maxDispatches === PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES &&
        run.costCeilingMicroUsd ===
            BigInt(PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD) &&
        run.runtimeCommitSha === facts.stageFacts.runtimeCommitSha &&
        run.runtimeDeploymentId === facts.stageFacts.runtimeDeploymentId &&
        canonicalBenchmarkJson(run.runtimeSourceManifest) ===
            canonicalBenchmarkJson(facts.runSourceManifest) &&
        run.runtimeSourceManifestDigest === facts.runSourceManifestDigest &&
        run.previewBindingDigest ===
            promptRefinerShadowRunPreviewBindingDigest(binding) &&
        run.approvalExpiresAt.getTime() === stage.approvalExpiresAt.getTime() &&
        run.approvedAt.getTime() <= now.getTime() &&
        run.approvalExpiresAt.getTime() > now.getTime()
    );
};

export type PromptRefinerShadowExecutionState = Readonly<{
    observedAt: string;
    runId: string;
    status: string;
    dispatchCount: number;
    terminalCount: number;
    nextCaseIndex: number | null;
    nextCaseId: string | null;
    inFlightAttemptId: string | null;
    approvalExpiresAt: string;
}>;

/**
 * Reads the next durable work item under the same locks and runtime checks as
 * dispatch. It never reserves, consumes or calls a provider. A non-terminal
 * intent blocks the next case; the caller must let the DB-clock sweeper decide
 * whether that intent is stale rather than guessing or redispatching it.
 */
export const readPromptRefinerShadowExecutionState = async (): Promise<
    PromptRefinerShadowExecutionState
> => {
    const facts = await loadPromptRefinerShadowRunRuntimeFacts();
    return prisma.$transaction(async (tx) => {
        const foundStage = await lockStage(tx);
        if (!foundStage) {
            refuse(409, "PROMPT_REFINER_SHADOW_EXECUTION_STAGE_REQUIRED", "The approved stage does not exist.");
        }
        const stage = foundStage!;
        if (!(await promptRefinerStageAuthorizationIsValid(tx, stage))) {
            refuse(409, "PROMPT_REFINER_SHADOW_EXECUTION_STAGE_INVALID", "The stage authorization is invalid.");
        }
        await lockAndValidateRegistry(tx);
        const runRows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "PromptRefinerShadowRun"
            WHERE "id" = ${PROMPT_REFINER_SHADOW_RUN_ID} FOR UPDATE
        `;
        if (runRows.length !== 1) {
            refuse(409, "PROMPT_REFINER_SHADOW_EXECUTION_RUN_REQUIRED", "The approved run does not exist.");
        }
        const run = await tx.promptRefinerShadowRun.findUniqueOrThrow({
            where: { id: PROMPT_REFINER_SHADOW_RUN_ID },
        });
        const now = await dbClock(tx);
        const previewBinding = buildPromptRefinerShadowRunPreviewBinding({
            stageRuntimeSourceManifestDigest:
                stage.runtimeSourceManifestDigest,
            runSourceManifestDigest: facts.runSourceManifestDigest,
            deploymentId: facts.stageFacts.runtimeDeploymentId,
            commitSha: facts.stageFacts.runtimeCommitSha,
            stageApprovalExpiresAt: stage.approvalExpiresAt,
        });
        if (
            !(await runAuthorizationIsValid(tx, run)) ||
            promptRefinerReservationStageProblems(stage).length > 0 ||
            !promptRefinerStoredStageMatchesRuntime(stage, facts.stageFacts, now) ||
            run.id !== PROMPT_REFINER_SHADOW_RUN_ID ||
            run.stageId !== PROMPT_REFINER_RESERVATION_STAGE_ID ||
            run.runContractVersion !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION ||
            run.runContractDigest !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST ||
            run.corpusDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST ||
            run.evidenceSpecDigest !== PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST ||
            run.adapterVersion !== PROMPT_REFINER_SHADOW_ADAPTER_VERSION ||
            run.perRequestCostMicroUsd !==
                BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD) ||
            run.maxDispatches !== PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES ||
            run.costCeilingMicroUsd !==
                BigInt(PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD) ||
            run.knownActualCostMicroUsd > run.costCeilingMicroUsd ||
            run.runtimeCommitSha !== facts.stageFacts.runtimeCommitSha ||
            run.runtimeDeploymentId !== facts.stageFacts.runtimeDeploymentId ||
            canonicalBenchmarkJson(run.runtimeSourceManifest) !==
                canonicalBenchmarkJson(facts.runSourceManifest) ||
            run.runtimeSourceManifestDigest !== facts.runSourceManifestDigest ||
            run.previewBindingDigest !==
                promptRefinerShadowRunPreviewBindingDigest(previewBinding) ||
            run.approvalExpiresAt.getTime() !== stage.approvalExpiresAt.getTime() ||
            run.approvalExpiresAt.getTime() <= now.getTime()
        ) {
            refuse(409, "PROMPT_REFINER_SHADOW_EXECUTION_AUTHORITY_INVALID", "The execution authority is expired or drifted.");
        }
        const attempts = await tx.promptRefinerShadowAttempt.findMany({
            where: { runId: run.id },
            orderBy: [{ caseIndex: "asc" }],
            select: {
                id: true,
                caseId: true,
                caseIndex: true,
                status: true,
            },
        });
        if (
            attempts.length !== run.dispatchCount ||
            attempts.some(
                (attempt, index) =>
                    attempt.caseIndex !== index ||
                    PROMPT_REFINER_SHADOW_CASE_IDS[index] !== attempt.caseId
            ) ||
            attempts.filter((attempt) => attempt.status === "terminal").length !==
                run.terminalCount
        ) {
            refuse(409, "PROMPT_REFINER_SHADOW_EXECUTION_SEQUENCE_INVALID", "The durable case sequence is inconsistent.");
        }
        const inFlight = attempts.find(
            (attempt) => attempt.status === "dispatch_intent"
        );
        if (
            inFlight &&
            (inFlight.caseIndex !== attempts.length - 1 ||
                attempts.some(
                    (attempt) =>
                        attempt.caseIndex > inFlight.caseIndex &&
                        attempt.status !== "terminal"
                ))
        ) {
            refuse(409, "PROMPT_REFINER_SHADOW_EXECUTION_IN_FLIGHT_INVALID", "More than one case is in flight.");
        }
        const nextCaseIndex =
            ["completed", "stopped_unknown"].includes(run.status) || inFlight
                ? null
                : attempts.length;
        if (
            nextCaseIndex !== null &&
            nextCaseIndex >= PROMPT_REFINER_SHADOW_CASE_IDS.length
        ) {
            refuse(409, "PROMPT_REFINER_SHADOW_EXECUTION_COMPLETION_INVALID", "The run did not close after all cases.");
        }
        return Object.freeze({
            observedAt: now.toISOString(),
            runId: run.id,
            status: run.status,
            dispatchCount: run.dispatchCount,
            terminalCount: run.terminalCount,
            nextCaseIndex,
            nextCaseId:
                nextCaseIndex === null
                    ? null
                    : PROMPT_REFINER_SHADOW_CASE_IDS[nextCaseIndex]!,
            inFlightAttemptId: inFlight?.id ?? null,
            approvalExpiresAt: run.approvalExpiresAt.toISOString(),
        });
    });
};

export const promptRefinerShadowRunPreview = async () => {
    const facts = await loadPromptRefinerShadowRunRuntimeFacts();
    const foundStage = await prisma.promptRefinerReservationStage.findUnique({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    if (!foundStage) {
        refuse(409, "PROMPT_REFINER_SHADOW_RUN_STAGE_REQUIRED", "The durable stage must be approved first.");
    }
    const stage = foundStage!;
    const now = new Date();
    if (
        promptRefinerReservationStageProblems(stage).length > 0 ||
        !promptRefinerStoredStageMatchesRuntime(stage, facts.stageFacts, now)
    ) {
        refuse(409, "PROMPT_REFINER_SHADOW_RUN_STAGE_DRIFT", "The approved stage no longer matches this deployment.");
    }
    const existing = await prisma.promptRefinerShadowRun.findUnique({
        where: { runContractDigest: PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST },
    });
    const binding = buildPromptRefinerShadowRunPreviewBinding({
        stageRuntimeSourceManifestDigest: stage.runtimeSourceManifestDigest,
        runSourceManifestDigest: facts.runSourceManifestDigest,
        deploymentId: facts.stageFacts.runtimeDeploymentId,
        commitSha: facts.stageFacts.runtimeCommitSha,
        stageApprovalExpiresAt: stage.approvalExpiresAt,
    });
    return {
        status: existing ? "already_exists" : "ready_for_explicit_cost_approval",
        ...binding,
        previewBindingDigest: promptRefinerShadowRunPreviewBindingDigest(binding),
        confirmation: PROMPT_REFINER_SHADOW_RUN_CONFIRMATION,
        approvalEnabled:
            process.env[PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG] === "true",
    };
};

export const createPromptRefinerShadowRun = async (input: {
    session: Session;
    request: Request;
    expected: {
        runContractDigest: string;
        stageRuntimeSourceManifestDigest: string;
        runSourceManifestDigest: string;
        previewBindingDigest: string;
    };
}) => {
    if (!input.session.user?.id) {
        refuse(403, "PROMPT_REFINER_SHADOW_RUN_ACTOR_REQUIRED", "Administrator identity is required.");
    }
    if (process.env[PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG] !== "true") {
        refuse(403, "PROMPT_REFINER_SHADOW_RUN_APPROVAL_DISABLED", "Run approval is disabled.");
    }
    if (adminAuditIntegrityKeys(process.env).length === 0) {
        refuse(503, "PROMPT_REFINER_SHADOW_RUN_AUDIT_KEY_REQUIRED", "Audit integrity signing is not configured.");
    }
    const facts = await loadPromptRefinerShadowRunRuntimeFacts();

    return prisma.$transaction(async (tx) => {
        const foundStage = await lockStage(tx);
        if (!foundStage) {
            refuse(409, "PROMPT_REFINER_SHADOW_RUN_STAGE_REQUIRED", "The durable stage must be approved first.");
        }
        const stage = foundStage!;
        if (!(await promptRefinerStageAuthorizationIsValid(tx, stage))) {
            refuse(409, "PROMPT_REFINER_SHADOW_RUN_STAGE_AUTHORIZATION_INVALID", "The stage authorization is invalid.");
        }
        await lockAndValidateRegistry(tx);
        const now = await dbClock(tx);
        if (
            promptRefinerReservationStageProblems(stage).length > 0 ||
            !promptRefinerStoredStageMatchesRuntime(stage, facts.stageFacts, now)
        ) {
            refuse(409, "PROMPT_REFINER_SHADOW_RUN_STAGE_DRIFT", "The approved stage no longer matches this deployment.");
        }
        const binding = buildPromptRefinerShadowRunPreviewBinding({
            stageRuntimeSourceManifestDigest: stage.runtimeSourceManifestDigest,
            runSourceManifestDigest: facts.runSourceManifestDigest,
            deploymentId: facts.stageFacts.runtimeDeploymentId,
            commitSha: facts.stageFacts.runtimeCommitSha,
            stageApprovalExpiresAt: stage.approvalExpiresAt,
        });
        const previewBindingDigest =
            promptRefinerShadowRunPreviewBindingDigest(binding);
        if (
            input.expected.runContractDigest !==
                PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST ||
            input.expected.stageRuntimeSourceManifestDigest !==
                stage.runtimeSourceManifestDigest ||
            input.expected.runSourceManifestDigest !==
                facts.runSourceManifestDigest ||
            input.expected.previewBindingDigest !== previewBindingDigest
        ) {
            refuse(409, "PROMPT_REFINER_SHADOW_RUN_PREVIEW_STALE", "Run approval preview no longer matches this deployment.");
        }

        const existing = await tx.promptRefinerShadowRun.findUnique({
            where: { runContractDigest: PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST },
        });
        if (existing) {
            if (
                existing.approvedBy === input.session.user!.id &&
                (await runAuthorizationIsValid(tx, existing)) &&
                runMatchesRuntime(existing, facts, stage, now)
            ) {
                return { created: false, replayed: true, run: existing };
            }
            refuse(409, "PROMPT_REFINER_SHADOW_RUN_ALREADY_EXISTS", "The one-run authority has already been consumed.");
        }

        const draft: StoredRun = {
            id: PROMPT_REFINER_SHADOW_RUN_ID,
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            runContractVersion: PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION,
            runContractDigest: PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
            corpusDigest: PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
            evidenceSpecDigest: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
            adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
            status: "approved",
            perRequestCostMicroUsd: BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD),
            maxDispatches: PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
            costCeilingMicroUsd: BigInt(PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD),
            dispatchCount: 0,
            terminalCount: 0,
            knownActualCostMicroUsd: BigInt(0),
            runtimeCommitSha: facts.stageFacts.runtimeCommitSha,
            runtimeDeploymentId: facts.stageFacts.runtimeDeploymentId,
            runtimeSourceManifest: facts.runSourceManifest,
            runtimeSourceManifestDigest: facts.runSourceManifestDigest,
            previewBindingDigest,
            approvedBy: input.session.user!.id,
            approvedAt: now,
            approvalExpiresAt: stage.approvalExpiresAt,
            authorizationAuditLogId: "pending",
        };
        const auditId = await writeAdminAuditLog({
            session: input.session,
            request: input.request,
            action: RUN_APPROVAL_ACTION,
            targetType: RUN_APPROVAL_TARGET,
            targetId: draft.id,
            summary: RUN_APPROVAL_SUMMARY,
            metadata: runApprovalMetadata(draft),
            tx,
        });
        const run = await tx.promptRefinerShadowRun.create({
            data: {
                ...draft,
                runtimeSourceManifest:
                    facts.runSourceManifest as unknown as Prisma.InputJsonValue,
                authorizationAuditLogId: auditId,
                createdAt: now,
            },
        });
        if (!(await runAuthorizationIsValid(tx, run))) {
            refuse(503, "PROMPT_REFINER_SHADOW_RUN_AUTHORIZATION_INVALID", "The durable run authorization could not be verified.");
        }
        return { created: true, replayed: false, run };
    });
};

const dispatchFactIsExact = (
    fact: PromptRefinerShadowDispatchFact,
    requestId: string
): boolean =>
    fact.requestId === requestId &&
    fact.adapterVersion === PROMPT_REFINER_SHADOW_ADAPTER_VERSION &&
    fact.provider === PROMPT_REFINER_EXECUTION_MODEL_PIN.provider &&
    fact.modelId === PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId &&
    fact.apiModelId === PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId &&
    fact.maxOutputTokens === PROMPT_REFINER_MAX_OUTPUT_TOKENS &&
    fact.timeoutMs === PROMPT_REFINER_TIMEOUT_MS &&
    fact.retryCount === PROMPT_REFINER_RETRY_COUNT &&
    fact.tokenizerPackage === PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE &&
    fact.tokenizerPackageVersion ===
        PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION &&
    fact.tokenizerEncoding === PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING &&
    Number.isSafeInteger(fact.admissionInputTokens) &&
    fact.admissionInputTokens >= 0 &&
    fact.admissionInputTokens <= PROMPT_REFINER_MAX_INPUT_TOKENS;

export const recordPromptRefinerShadowDispatchIntent = async (input: {
    runId: string;
    caseId: string;
    caseIndex: number;
    reservation: PromptRefinerReservationBinding;
    fact: PromptRefinerShadowDispatchFact;
}) => {
    if (
        input.runId !== PROMPT_REFINER_SHADOW_RUN_ID ||
        input.caseIndex < 0 ||
        input.caseIndex >= PROMPT_REFINER_SHADOW_CASE_IDS.length ||
        PROMPT_REFINER_SHADOW_CASE_IDS[input.caseIndex] !== input.caseId ||
        !promptRefinerReservationIdentifiersAreValid(input.reservation) ||
        !dispatchFactIsExact(input.fact, input.reservation.requestId)
    ) {
        refuse(400, "PROMPT_REFINER_SHADOW_DISPATCH_BINDING_INVALID", "Dispatch binding is invalid.");
    }
    const facts = await loadPromptRefinerShadowRunRuntimeFacts();

    return prisma.$transaction(async (tx) => {
        const foundStage = await lockStage(tx);
        if (!foundStage) {
            refuse(409, "PROMPT_REFINER_SHADOW_DISPATCH_STAGE_INVALID", "The stage is unavailable or unauthorized.");
        }
        const stage = foundStage!;
        if (!(await promptRefinerStageAuthorizationIsValid(tx, stage))) {
            refuse(409, "PROMPT_REFINER_SHADOW_DISPATCH_STAGE_INVALID", "The stage is unavailable or unauthorized.");
        }
        await lockAndValidateRegistry(tx);
        const runRows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "PromptRefinerShadowRun"
            WHERE "id" = ${input.runId} FOR UPDATE
        `;
        if (runRows.length !== 1) {
            refuse(409, "PROMPT_REFINER_SHADOW_DISPATCH_RUN_REQUIRED", "The approved run does not exist.");
        }
        const run = await tx.promptRefinerShadowRun.findUniqueOrThrow({
            where: { id: input.runId },
        });
        const reservationRows = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "PromptRefinerReservation"
            WHERE "id" = ${input.reservation.reservationId} FOR UPDATE
        `;
        if (reservationRows.length !== 1) {
            refuse(409, "PROMPT_REFINER_SHADOW_DISPATCH_RESERVATION_REQUIRED", "The reservation does not exist.");
        }
        const reservation = await tx.promptRefinerReservation.findUniqueOrThrow({
            where: { id: input.reservation.reservationId },
        });
        const now = await dbClock(tx);
        if (
            !(await runAuthorizationIsValid(tx, run)) ||
            !runMatchesRuntime(run, facts, stage, now) ||
            run.status === "stopped_unknown" ||
            run.dispatchCount >= run.maxDispatches
        ) {
            refuse(409, "PROMPT_REFINER_SHADOW_DISPATCH_RUN_INVALID", "The run cannot accept another dispatch.");
        }
        if (
            input.reservation.stageId !== PROMPT_REFINER_RESERVATION_STAGE_ID ||
            input.reservation.contractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST ||
            !promptRefinerReservationBindingMatches(input.reservation, {
                reservationId: reservation.id,
                requestId: reservation.requestId,
                stageId: reservation.stageId,
                contractDigest: reservation.contractDigest,
            })
        ) {
            refuse(409, "PROMPT_REFINER_SHADOW_DISPATCH_RESERVATION_MISMATCH", "The reservation binding does not match.");
        }
        const duplicate = await tx.promptRefinerShadowAttempt.findFirst({
            where: {
                OR: [
                    { reservationId: reservation.id },
                    { requestId: reservation.requestId },
                    { runId: run.id, caseId: input.caseId },
                    { runId: run.id, caseIndex: input.caseIndex },
                ],
            },
        });
        if (duplicate) {
            refuse(409, "PROMPT_REFINER_SHADOW_DISPATCH_ALREADY_RECORDED", "This request or case already has a dispatch intent.");
        }
        if (reservation.status !== "reserved") {
            refuse(409, "PROMPT_REFINER_SHADOW_DISPATCH_RESERVATION_TERMINAL", "The reservation is not active.");
        }
        if (reservation.expiresAt.getTime() <= now.getTime()) {
            await tx.promptRefinerReservation.update({
                where: { id: reservation.id },
                data: { status: "expired" },
            });
            return { ok: false as const, reason: "reservation_expired" as const };
        }

        const attemptId = randomUUID();
        const dispatchAuditLogId = await writePromptRefinerDispatchAudit({
            tx,
            attemptId,
            runId: run.id,
            reservationId: reservation.id,
            requestId: reservation.requestId,
            caseId: input.caseId,
            caseIndex: input.caseIndex,
            runContractDigest: run.runContractDigest,
            adapterVersion: run.adapterVersion,
            provider: input.fact.provider,
            modelId: input.fact.modelId,
            timeoutMs: input.fact.timeoutMs,
            retryCount: input.fact.retryCount,
            tokenizerPackage: input.fact.tokenizerPackage,
            tokenizerPackageVersion: input.fact.tokenizerPackageVersion,
            tokenizerEncoding: input.fact.tokenizerEncoding,
            admissionInputTokens: input.fact.admissionInputTokens,
        });
        const attempt = await tx.promptRefinerShadowAttempt.create({
            data: {
                id: attemptId,
                runId: run.id,
                reservationId: reservation.id,
                requestId: reservation.requestId,
                caseId: input.caseId,
                caseIndex: input.caseIndex,
                stageId: run.stageId,
                reservationContractDigest: reservation.contractDigest,
                runContractDigest: run.runContractDigest,
                provider: input.fact.provider,
                modelId: input.fact.modelId,
                adapterVersion: input.fact.adapterVersion,
                status: "dispatch_intent",
                dispatchIntentAt: now,
                dispatchAuditLogId,
                createdAt: now,
            },
        });
        const consumed = await tx.promptRefinerReservation.updateMany({
            where: { id: reservation.id, status: "reserved" },
            data: { status: "consumed" },
        });
        if (consumed.count !== 1) {
            refuse(409, "PROMPT_REFINER_SHADOW_DISPATCH_RESERVATION_RACE", "The reservation changed before dispatch.");
        }
        await tx.promptRefinerShadowRun.update({
            where: { id: run.id },
            data: {
                status: "running",
                dispatchCount: run.dispatchCount + 1,
            },
        });
        return { ok: true as const, attempt };
    });
};

type TerminalTelemetry = {
    durationMs: number;
    usage: PromptRefinerShadowUsage;
};

const nullableNonnegativeInteger = (value: number | null): boolean =>
    value === null || (Number.isSafeInteger(value) && value >= 0);

const terminalInputIsValid = (
    reason: PromptRefinerTerminalReason,
    telemetry: TerminalTelemetry
): boolean =>
    DISPATCH_TERMINAL_REASONS.has(reason) &&
    Number.isSafeInteger(telemetry.durationMs) &&
    telemetry.durationMs >= 0 &&
    telemetry.durationMs <= PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS &&
    nullableNonnegativeInteger(telemetry.usage.inputTokens) &&
    nullableNonnegativeInteger(telemetry.usage.cachedInputTokens) &&
    nullableNonnegativeInteger(telemetry.usage.cacheWriteInputTokens) &&
    nullableNonnegativeInteger(telemetry.usage.outputTokens) &&
    nullableNonnegativeInteger(telemetry.usage.reasoningTokens) &&
    nullableNonnegativeInteger(telemetry.usage.costUpperBoundMicroUsd) &&
    (telemetry.usage.costUpperBoundMicroUsd === null ||
        telemetry.usage.costUpperBoundMicroUsd <=
            PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD);

const evidenceTerminalStatus = (
    reason: PromptRefinerTerminalReason
): "suggested" | "failed" | "unknown" =>
    reason === "suggested"
        ? "suggested"
        : reason === "unknown_after_dispatch"
          ? "unknown"
          : "failed";

const terminalValuesEqual = (
    attempt: {
        terminalReason: string | null;
        durationMs: number | null;
        inputTokens: number | null;
        cachedInputTokens: number | null;
        cacheWriteInputTokens: number | null;
        outputTokens: number | null;
        reasoningTokens: number | null;
        actualCostMicroUsd: bigint | null;
        evidence: unknown;
    },
    reason: PromptRefinerTerminalReason,
    telemetry: TerminalTelemetry,
    evidence: PromptRefinerShadowCaseEvidence
) =>
    attempt.terminalReason === reason &&
    attempt.durationMs === telemetry.durationMs &&
    attempt.inputTokens === telemetry.usage.inputTokens &&
    attempt.cachedInputTokens === telemetry.usage.cachedInputTokens &&
    attempt.cacheWriteInputTokens === telemetry.usage.cacheWriteInputTokens &&
    attempt.outputTokens === telemetry.usage.outputTokens &&
    attempt.reasoningTokens === telemetry.usage.reasoningTokens &&
    attempt.actualCostMicroUsd ===
        (telemetry.usage.costUpperBoundMicroUsd === null
            ? null
            : BigInt(telemetry.usage.costUpperBoundMicroUsd)) &&
    canonicalBenchmarkJson(attempt.evidence) === canonicalBenchmarkJson(evidence);

export const recordPromptRefinerShadowTerminal = async (input: {
    attemptId: string;
    terminalReason: PromptRefinerTerminalReason;
    durationMs: number;
    usage: PromptRefinerShadowUsage;
    evidence: unknown;
}) => {
    if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.attemptId) ||
        !terminalInputIsValid(input.terminalReason, input)
    ) {
        refuse(400, "PROMPT_REFINER_SHADOW_TERMINAL_INVALID", "Terminal receipt is invalid.");
    }
    const terminalFacts = promptRefinerTerminalReceiptFacts(input.terminalReason);
    return prisma.$transaction(async (tx) => {
        const foundAttempt = await tx.promptRefinerShadowAttempt.findUnique({
            where: { id: input.attemptId },
            select: { runId: true },
        });
        if (!foundAttempt) {
            refuse(404, "PROMPT_REFINER_SHADOW_ATTEMPT_NOT_FOUND", "The dispatch attempt does not exist.");
        }
        const found = foundAttempt!;
        await tx.$queryRaw`
            SELECT "id" FROM "PromptRefinerShadowRun"
            WHERE "id" = ${found.runId} FOR UPDATE
        `;
        await tx.$queryRaw`
            SELECT "id" FROM "PromptRefinerShadowAttempt"
            WHERE "id" = ${input.attemptId} FOR UPDATE
        `;
        const run = await tx.promptRefinerShadowRun.findUniqueOrThrow({
            where: { id: found.runId },
        });
        const attempt = await tx.promptRefinerShadowAttempt.findUniqueOrThrow({
            where: { id: input.attemptId },
        });
        if (
            run.runContractDigest !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST ||
            run.evidenceSpecDigest !== PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST
        ) {
            refuse(
                409,
                "PROMPT_REFINER_SHADOW_EVIDENCE_RUN_MISMATCH",
                "The attempt is not bound to the reviewed evidence contract."
            );
        }
        const evidence: PromptRefinerShadowCaseEvidence = (() => {
            try {
                return validatePromptRefinerShadowCaseEvidence({
                    value: input.evidence,
                    spec: shadowEvidenceSpec,
                    caseIndex: attempt.caseIndex,
                    terminalStatus: evidenceTerminalStatus(
                        input.terminalReason
                    ),
                });
            } catch {
                return refuse(
                    400,
                    "PROMPT_REFINER_SHADOW_EVIDENCE_INVALID",
                    "The terminal evidence is invalid."
                );
            }
        })();
        if (attempt.status === "terminal") {
            if (
                terminalValuesEqual(
                    attempt,
                    input.terminalReason,
                    input,
                    evidence
                )
            ) {
                return { created: false, replayed: true, attempt, run };
            }
            refuse(409, "PROMPT_REFINER_SHADOW_TERMINAL_CONFLICT", "A different terminal receipt already exists.");
        }
        const mayRecordInFlightReceiptAfterUnknownLatch =
            run.status === "stopped_unknown";
        if (
            !["running", "approved"].includes(run.status) &&
            !mayRecordInFlightReceiptAfterUnknownLatch
        ) {
            refuse(409, "PROMPT_REFINER_SHADOW_RUN_TERMINAL", "The run is already terminal.");
        }
        const terminalAuditLogId = await writePromptRefinerTerminalAudit({
            tx,
            attemptId: attempt.id,
            runId: run.id,
            reservationId: attempt.reservationId,
            requestId: attempt.requestId,
            caseId: attempt.caseId,
            terminalReason: input.terminalReason,
            failureLayer: terminalFacts.failureLayer,
            failureCode: terminalFacts.failureCode,
            durationMs: input.durationMs,
            inputTokens: input.usage.inputTokens,
            cachedInputTokens: input.usage.cachedInputTokens,
            cacheWriteInputTokens: input.usage.cacheWriteInputTokens,
            outputTokens: input.usage.outputTokens,
            reasoningTokens: input.usage.reasoningTokens,
            actualCostMicroUsd: input.usage.costUpperBoundMicroUsd,
            evidence: evidence as unknown as Prisma.InputJsonValue,
        });
        const updatedCount = await tx.promptRefinerShadowAttempt.updateMany({
            where: { id: attempt.id, status: "dispatch_intent" },
            data: {
                status: "terminal",
                terminalReason: input.terminalReason,
                failureLayer: terminalFacts.failureLayer,
                failureCode: terminalFacts.failureCode,
                durationMs: input.durationMs,
                inputTokens: input.usage.inputTokens,
                cachedInputTokens: input.usage.cachedInputTokens,
                cacheWriteInputTokens: input.usage.cacheWriteInputTokens,
                outputTokens: input.usage.outputTokens,
                reasoningTokens: input.usage.reasoningTokens,
                actualCostMicroUsd:
                    input.usage.costUpperBoundMicroUsd === null
                        ? null
                        : BigInt(input.usage.costUpperBoundMicroUsd),
                evidence: evidence as unknown as Prisma.InputJsonValue,
                terminalAuditLogId,
            },
        });
        if (updatedCount.count !== 1) {
            refuse(409, "PROMPT_REFINER_SHADOW_TERMINAL_CAS_LOST", "Another writer closed this attempt.");
        }
        const aggregates = await tx.promptRefinerShadowAttempt.aggregate({
            where: { runId: run.id },
            _count: { id: true, terminalAt: true },
            _sum: { actualCostMicroUsd: true },
        });
        const dispatchCount = aggregates._count.id;
        const terminalCount = aggregates._count.terminalAt;
        const knownCost = aggregates._sum.actualCostMicroUsd ?? BigInt(0);
        if (knownCost > run.costCeilingMicroUsd) {
            refuse(409, "PROMPT_REFINER_SHADOW_RUN_COST_EXCEEDED", "Known run cost exceeds the approved ceiling.");
        }
        const nextStatus =
            run.status === "stopped_unknown" ||
            input.terminalReason === "unknown_after_dispatch"
                ? "stopped_unknown"
                : dispatchCount === run.maxDispatches && terminalCount === dispatchCount
                  ? "completed"
                  : "running";
        const updatedRun = await tx.promptRefinerShadowRun.update({
            where: { id: run.id },
            data: {
                status: nextStatus,
                dispatchCount,
                terminalCount,
                knownActualCostMicroUsd: knownCost,
            },
        });
        const updatedAttempt = await tx.promptRefinerShadowAttempt.findUniqueOrThrow({
            where: { id: attempt.id },
        });
        return {
            created: true,
            replayed: false,
            attempt: updatedAttempt,
            run: updatedRun,
        };
    });
};

/**
 * Rebuilds the reviewed bundle only from durable, content-free attempt facts.
 * Incomplete runs return null; malformed or differently bound completed rows
 * fail closed instead of being rendered as evidence.
 */
export const readPromptRefinerShadowEvidenceBundle = async (): Promise<
    PromptRefinerShadowEvidenceBundle | null
> => {
    const run = await prisma.promptRefinerShadowRun.findUnique({
        where: { id: PROMPT_REFINER_SHADOW_RUN_ID },
        select: {
            runContractDigest: true,
            corpusDigest: true,
            evidenceSpecDigest: true,
            maxDispatches: true,
            terminalCount: true,
        },
    });
    if (!run) return null;
    if (
        run.runContractDigest !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST ||
        run.corpusDigest !== PROMPT_REFINER_SHADOW_CORPUS_DIGEST ||
        run.evidenceSpecDigest !== PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST
    ) {
        refuse(
            409,
            "PROMPT_REFINER_SHADOW_EVIDENCE_RUN_MISMATCH",
            "The stored run is not bound to the reviewed evidence contract."
        );
    }
    if (
        run.terminalCount !== run.maxDispatches ||
        run.maxDispatches !== PROMPT_REFINER_SHADOW_CASE_IDS.length
    ) {
        return null;
    }
    const attempts = await prisma.promptRefinerShadowAttempt.findMany({
        where: { runId: PROMPT_REFINER_SHADOW_RUN_ID },
        orderBy: { caseIndex: "asc" },
        select: {
            caseId: true,
            caseIndex: true,
            status: true,
            terminalReason: true,
            evidence: true,
            durationMs: true,
            actualCostMicroUsd: true,
        },
    });
    if (attempts.length !== PROMPT_REFINER_SHADOW_CASE_IDS.length) {
        refuse(
            409,
            "PROMPT_REFINER_SHADOW_EVIDENCE_INCOMPLETE",
            "The completed run does not contain every evidence case."
        );
    }
    const cases = attempts.map((attempt, index) => {
        if (
            attempt.caseIndex !== index ||
            attempt.caseId !== PROMPT_REFINER_SHADOW_CASE_IDS[index] ||
            attempt.status !== "terminal" ||
            typeof attempt.terminalReason !== "string" ||
            !DISPATCH_TERMINAL_REASONS.has(
                attempt.terminalReason as PromptRefinerTerminalReason
            ) ||
            attempt.evidence === null
        ) {
            refuse(
                409,
                "PROMPT_REFINER_SHADOW_EVIDENCE_INVALID",
                "The completed run contains invalid evidence facts."
            );
        }
        return {
            caseId: attempt.caseId,
            terminalStatus: evidenceTerminalStatus(
                attempt.terminalReason as PromptRefinerTerminalReason
            ),
            evidence: attempt.evidence,
            durationMs:
                attempt.terminalReason === "unknown_after_dispatch"
                    ? null
                    : attempt.durationMs,
            costMicroUsd:
                attempt.terminalReason === "unknown_after_dispatch" ||
                attempt.actualCostMicroUsd === null
                    ? null
                    : Number(attempt.actualCostMicroUsd),
        };
    });
    try {
        return aggregatePromptRefinerShadowStoredEvidence({
            corpus: shadowCorpus,
            spec: shadowEvidenceSpec,
            cases,
        });
    } catch {
        return refuse(
            409,
            "PROMPT_REFINER_SHADOW_EVIDENCE_INVALID",
            "The completed run evidence could not be verified."
        );
    }
};

const unknownTelemetry = (): TerminalTelemetry => ({
    durationMs: PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS,
    usage: {
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        costUpperBoundMicroUsd: null,
    },
});

/**
 * Closes only already-dispatched stale intents. It never calls an adapter,
 * never re-reserves and never retries. It uses the database clock, continues
 * closing the selected batch after the first unknown latches the run, and
 * reports any race it could not close. Consumed rows without an attempt are
 * reported as an incident because their provider outcome cannot be inferred.
 */
export const sweepPromptRefinerShadowUnknowns = async () => {
    const snapshot = await prisma.$transaction(async (tx) => {
        const observedAt = await dbClock(tx);
        const cutoff = new Date(
            observedAt.getTime() - PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS
        );
        const stale = await tx.promptRefinerShadowAttempt.findMany({
            where: {
                status: "dispatch_intent",
                dispatchIntentAt: { lte: cutoff },
                run: {
                    status: {
                        in: ["approved", "running", "stopped_unknown"],
                    },
                },
            },
            orderBy: [{ dispatchIntentAt: "asc" }, { id: "asc" }],
            take: PROMPT_REFINER_SHADOW_RUN_SWEEP_BATCH,
            select: { id: true, caseIndex: true },
        });
        return { observedAt, stale };
    });
    const closed: string[] = [];
    const unresolved: string[] = [];
    for (const attempt of snapshot.stale) {
        try {
            const result = await recordPromptRefinerShadowTerminal({
                attemptId: attempt.id,
                terminalReason: "unknown_after_dispatch",
                evidence: evaluatePromptRefinerShadowCaseEvidence({
                    corpus: shadowCorpus,
                    spec: shadowEvidenceSpec,
                    caseIndex: attempt.caseIndex,
                    terminalStatus: "unknown",
                    refinedPrompt: null,
                }),
                ...unknownTelemetry(),
            });
            if (result.created || result.replayed) closed.push(attempt.id);
        } catch (error) {
            if (
                !(error instanceof PromptRefinerShadowRunError) ||
                error.code !== "PROMPT_REFINER_SHADOW_TERMINAL_CONFLICT"
            ) {
                throw error;
            }
            unresolved.push(attempt.id);
        }
    }
    const consumedWithoutAttempt = await prisma.promptRefinerReservation.findMany({
        where: { status: "consumed", shadowAttempt: null },
        orderBy: [{ consumedAt: "asc" }, { id: "asc" }],
        take: PROMPT_REFINER_SHADOW_RUN_SWEEP_BATCH,
        select: { id: true, requestId: true },
    });
    return {
        observedAt: snapshot.observedAt.toISOString(),
        staleCandidates: snapshot.stale.length,
        closedUnknownAttemptIds: closed,
        unresolvedStaleAttemptIds: unresolved,
        consumedWithoutAttempt,
        retryCount: 0 as const,
        redispatched: 0 as const,
    };
};

export const promptRefinerShadowRunErrorResponse = (error: unknown) => {
    if (!(error instanceof PromptRefinerShadowRunError)) return null;
    return Response.json(
        { error: error.message, code: error.code },
        { status: error.status }
    );
};
