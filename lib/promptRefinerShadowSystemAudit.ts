import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";

const SYSTEM_ACTOR = "prompt-refiner-shadow-runner" as const;
const ATTEMPT_TARGET = "PromptRefinerShadowAttempt";

export const writePromptRefinerDispatchAudit = (input: {
    tx: Prisma.TransactionClient;
    attemptId: string;
    runId: string;
    reservationId: string;
    requestId: string;
    caseId: string;
    caseIndex: number;
    runContractDigest: string;
    adapterVersion: string;
    provider: string;
    modelId: string;
    timeoutMs: number;
    retryCount: number;
    tokenizerPackage: string;
    tokenizerPackageVersion: string;
    tokenizerEncoding: string;
    admissionInputTokens: number;
}): Promise<string> =>
    writeSystemAuditLog({
        tx: input.tx,
        systemActor: SYSTEM_ACTOR,
        action: "prompt_refiner.shadow_dispatch.intent_recorded",
        targetType: ATTEMPT_TARGET,
        targetId: input.attemptId,
        summary: "Recorded one Prompt Refiner provider dispatch intent.",
        metadata: {
            runId: input.runId,
            reservationId: input.reservationId,
            requestId: input.requestId,
            caseId: input.caseId,
            caseIndex: input.caseIndex,
            runContractDigest: input.runContractDigest,
            adapterVersion: input.adapterVersion,
            provider: input.provider,
            modelId: input.modelId,
            timeoutMs: input.timeoutMs,
            retryCount: input.retryCount,
            tokenizerPackage: input.tokenizerPackage,
            tokenizerPackageVersion: input.tokenizerPackageVersion,
            tokenizerEncoding: input.tokenizerEncoding,
            admissionInputTokens: input.admissionInputTokens,
        },
    });

export const writePromptRefinerTerminalAudit = (input: {
    tx: Prisma.TransactionClient;
    attemptId: string;
    runId: string;
    reservationId: string;
    requestId: string;
    caseId: string;
    terminalReason: string;
    failureLayer: string;
    failureCode: string | null;
    durationMs: number;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    actualCostMicroUsd: number | null;
}): Promise<string> =>
    writeSystemAuditLog({
        tx: input.tx,
        systemActor: SYSTEM_ACTOR,
        action: "prompt_refiner.shadow_dispatch.terminal_recorded",
        targetType: ATTEMPT_TARGET,
        targetId: input.attemptId,
        summary: "Recorded one immutable Prompt Refiner terminal receipt.",
        metadata: {
            runId: input.runId,
            reservationId: input.reservationId,
            requestId: input.requestId,
            caseId: input.caseId,
            terminalReason: input.terminalReason,
            failureLayer: input.failureLayer,
            failureCode: input.failureCode,
            durationMs: input.durationMs,
            inputTokens: input.inputTokens,
            cachedInputTokens: input.cachedInputTokens,
            cacheWriteInputTokens: input.cacheWriteInputTokens,
            outputTokens: input.outputTokens,
            reasoningTokens: input.reasoningTokens,
            actualCostMicroUsd: input.actualCostMicroUsd,
            retryCount: 0,
        },
    });
