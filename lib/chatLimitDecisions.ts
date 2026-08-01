import "server-only";

import { prisma } from "@/lib/prisma";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import {
    buildChatLimitDecisionRecord,
    type ChatLimitDecisionInput,
    type ChatLimitDecisionRecord,
} from "@/lib/chatLimitDecisionCore";

const RETENTION_DAYS = 90;

let didWarnAboutMissingTable = false;

/**
 * Persists one limit decision and also emits it as a structured log line, so
 * the reason a request was blocked survives both in the admin console (looked
 * up by Trace ID) and in log search. Never throws: a failure to record
 * diagnostics must not turn into a second user-visible failure.
 */
export const recordChatLimitDecision = async (
    input: ChatLimitDecisionInput
): Promise<ChatLimitDecisionRecord> => {
    const record = buildChatLimitDecisionRecord(input);

    const logLine = {
        event: "chat_limit_decision",
        traceId: record.traceId,
        phase: record.phase,
        decision: record.decision,
        code: record.errorCode,
        limitLayer: record.limitLayer,
        limitScope: record.limitScope,
        plan: record.plan,
        subjectKey: record.subjectKey,
        modelIds: record.modelIds,
        enabledTools: record.enabledTools,
        estimatedInputTokens: record.estimatedInputTokens,
        estimatedOutputTokens: record.estimatedOutputTokens,
        estimatedCostMicroUsd: record.estimatedCostMicroUsd,
        pricingVersions: record.pricingVersions,
        usedAllowanceMicroUsd: record.usedAllowanceMicroUsd,
        requiredAllowanceMicroUsd: record.requiredAllowanceMicroUsd,
        limitMicroUsd: record.limitMicroUsd,
        requiredCredits: record.requiredCredits,
        availableCredits: record.availableCredits,
        timeZone: record.timeZone,
        resetAt: record.resetAt?.toISOString() ?? null,
        createdAt: record.createdAt.toISOString(),
    };
    if (record.decision === "rejected") {
        console.warn(JSON.stringify(logLine));
    } else {
        console.info(JSON.stringify(logLine));
    }

    try {
        await prisma.chatLimitDecisionEvent.create({
            data: {
                traceId: record.traceId,
                subjectKey: record.subjectKey,
                userId: record.userId,
                plan: record.plan,
                phase: record.phase,
                decision: record.decision,
                errorCode: record.errorCode,
                limitLayer: record.limitLayer,
                limitScope: record.limitScope,
                modelIds: record.modelIds,
                enabledTools: record.enabledTools,
                estimatedInputTokens: record.estimatedInputTokens,
                estimatedOutputTokens: record.estimatedOutputTokens,
                estimatedCostMicroUsd: BigInt(record.estimatedCostMicroUsd),
                pricingVersions: record.pricingVersions,
                models: record.models,
                requiredCredits: record.requiredCredits,
                availableCredits: record.availableCredits,
                usedAllowanceMicroUsd:
                    record.usedAllowanceMicroUsd === null
                        ? null
                        : BigInt(record.usedAllowanceMicroUsd),
                requiredAllowanceMicroUsd:
                    record.requiredAllowanceMicroUsd === null
                        ? null
                        : BigInt(record.requiredAllowanceMicroUsd),
                limitMicroUsd:
                    record.limitMicroUsd === null
                        ? null
                        : BigInt(record.limitMicroUsd),
                timeZone: record.timeZone,
                resetAt: record.resetAt,
                createdAt: record.createdAt,
            },
        });
    } catch (error) {
        if (isMissingDatabaseSchemaError(error)) {
            if (!didWarnAboutMissingTable) {
                didWarnAboutMissingTable = true;
                console.warn(
                    "ChatLimitDecisionEvent is not migrated yet; limit decisions are log-only."
                );
            }
        } else {
            console.error("Failed to record chat limit decision:", error);
        }
    }

    return record;
};

const serializeBigInt = (value: bigint | null) =>
    value === null ? null : Number(value);

export const findChatLimitDecisionsByTraceId = async (
    traceId: string,
    take = 20
) => {
    const rows = await prisma.chatLimitDecisionEvent.findMany({
        where: { traceId },
        orderBy: { createdAt: "desc" },
        take: Math.min(100, Math.max(1, take)),
    });
    return rows.map((row) => ({
        id: row.id,
        traceId: row.traceId,
        subjectKey: row.subjectKey,
        userId: row.userId,
        plan: row.plan,
        phase: row.phase,
        decision: row.decision,
        errorCode: row.errorCode,
        limitLayer: row.limitLayer,
        limitScope: row.limitScope,
        modelIds: row.modelIds,
        enabledTools: row.enabledTools,
        estimatedInputTokens: row.estimatedInputTokens,
        estimatedOutputTokens: row.estimatedOutputTokens,
        estimatedCostMicroUsd: serializeBigInt(row.estimatedCostMicroUsd),
        pricingVersions: row.pricingVersions,
        models: row.models,
        requiredCredits: row.requiredCredits,
        availableCredits: row.availableCredits,
        usedAllowanceMicroUsd: serializeBigInt(row.usedAllowanceMicroUsd),
        requiredAllowanceMicroUsd: serializeBigInt(
            row.requiredAllowanceMicroUsd
        ),
        limitMicroUsd: serializeBigInt(row.limitMicroUsd),
        timeZone: row.timeZone,
        resetAt: row.resetAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    }));
};

export const purgeExpiredChatLimitDecisions = async (now = new Date()) => {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
    const result = await prisma.chatLimitDecisionEvent.deleteMany({
        where: { createdAt: { lt: cutoff } },
    });
    return { deleted: result.count, cutoff };
};
