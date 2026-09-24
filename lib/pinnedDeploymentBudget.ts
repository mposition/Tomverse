/**
 * The experiment ledger. One row is one experiment's ceiling.
 *
 * This is not a credit balance and not a provider-wide budget. The limit is
 * the number stored on the row. Nothing in this file supplies a number when
 * the row, or the number, is missing. Concurrent reservations lock that row
 * before they read it, then use the same predicate as the in-memory ledger.
 */

import { randomUUID } from "node:crypto";

import {
    applyExperimentClose,
    decideExperimentReserve,
    PINNED_EXPERIMENT_HOLD_STATUSES,
    type PinnedExperimentHoldStatus,
    type PinnedHoldClose,
} from "@/lib/pinnedDeploymentExecution";

type Query = (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;
type Execute = (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;

export type ExperimentTx = {
    $queryRaw: Query;
    $executeRaw: Execute;
};

export type ExperimentDb = {
    $transaction<T>(work: (tx: ExperimentTx) => Promise<T>): Promise<T>;
    $queryRaw: Query;
};

const micro = (value: unknown): number | null => {
    if (typeof value === "bigint") {
        if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        return Number(value);
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
    return value;
};

const asRows = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
        ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        : [];

const wroteOne = (value: unknown) => value === 1 || value === BigInt(1);

export const createPinnedExperiment = async (
    db: ExperimentDb,
    limitMicroUsd: number
): Promise<{ ok: true; experimentId: string } | { ok: false; reason: "no_limit" }> => {
    if (!Number.isSafeInteger(limitMicroUsd) || limitMicroUsd <= 0) {
        return { ok: false, reason: "no_limit" };
    }
    try {
        const inserted = await db.$queryRaw`
            INSERT INTO "PinnedDeploymentExperiment" (
                "id", "limitMicroUsd", "spentMicroUsd", "reservedMicroUsd", "createdAt"
            ) VALUES (
                ${randomUUID()}, ${BigInt(limitMicroUsd)}, ${BigInt(0)}, ${BigInt(0)}, NOW()
            )
            RETURNING "id"
        `;
        const id = asRows(inserted)[0]?.id;
        if (typeof id !== "string" || id.length === 0) return { ok: false, reason: "no_limit" };
        return { ok: true, experimentId: id };
    } catch {
        return { ok: false, reason: "no_limit" };
    }
};

export const reservePinnedExperiment = async (
    db: ExperimentDb,
    input: {
        experimentId: string;
        amountMicroUsd: number;
        deploymentId: string;
        logicalModelId: string;
    }
): Promise<
    | { ok: true; holdId: string }
    | { ok: false; reason: "no_limit" | "unpriced" | "over_limit" }
> => {
    if (
        input.experimentId.length === 0 ||
        input.deploymentId.length === 0 ||
        input.logicalModelId.length === 0
    ) {
        return { ok: false, reason: "no_limit" };
    }
    try {
        return await db.$transaction(async (tx) => {
            const locked = await tx.$queryRaw`
                SELECT "limitMicroUsd", "spentMicroUsd", "reservedMicroUsd"
                FROM "PinnedDeploymentExperiment"
                WHERE "id" = ${input.experimentId}
                FOR UPDATE
            `;
            const lockedRows = asRows(locked);
            const current = lockedRows[0];
            if (!current || lockedRows.length !== 1) {
                return { ok: false as const, reason: "no_limit" as const };
            }
            const limitMicroUsd = micro(current.limitMicroUsd);
            const spentMicroUsd = micro(current.spentMicroUsd);
            const reservedMicroUsd = micro(current.reservedMicroUsd);
            if (limitMicroUsd === null || spentMicroUsd === null || reservedMicroUsd === null) {
                return { ok: false as const, reason: "no_limit" as const };
            }
            const decision = decideExperimentReserve({
                spentMicroUsd,
                reservedMicroUsd,
                incomingMicroUsd: input.amountMicroUsd,
                limitMicroUsd,
            });
            if (!decision.ok) return decision;
            const inserted = await tx.$queryRaw`
                INSERT INTO "PinnedDeploymentExperimentHold" (
                    "id", "experimentId", "deploymentId", "logicalModelId",
                    "reservedMicroUsd", "status", "createdAt"
                ) VALUES (
                    ${randomUUID()},
                    ${input.experimentId},
                    ${input.deploymentId},
                    ${input.logicalModelId},
                    ${BigInt(input.amountMicroUsd)},
                    'held',
                    NOW()
                )
                RETURNING "id"
            `;
            const holdId = asRows(inserted)[0]?.id;
            if (typeof holdId !== "string" || holdId.length === 0) {
                throw new Error("experiment hold was not stored");
            }
            const updated = await tx.$executeRaw`
                UPDATE "PinnedDeploymentExperiment"
                SET "reservedMicroUsd" = "reservedMicroUsd" + ${BigInt(input.amountMicroUsd)}
                WHERE "id" = ${input.experimentId}
            `;
            if (!wroteOne(updated)) throw new Error("experiment reservation was not stored");
            return { ok: true as const, holdId };
        });
    } catch {
        return { ok: false, reason: "no_limit" };
    }
};

export const closePinnedExperiment = async (
    db: ExperimentDb,
    input: { holdId: string; experimentId: string } & PinnedHoldClose
): Promise<{ ok: true } | { ok: false }> => {
    try {
        return await db.$transaction(async (tx) => {
            const lockedExperiment = await tx.$queryRaw`
                SELECT "limitMicroUsd", "spentMicroUsd", "reservedMicroUsd"
                FROM "PinnedDeploymentExperiment"
                WHERE "id" = ${input.experimentId}
                FOR UPDATE
            `;
            const lockedHold = await tx.$queryRaw`
                SELECT "status", "reservedMicroUsd", "experimentId"
                FROM "PinnedDeploymentExperimentHold"
                WHERE "id" = ${input.holdId}
                FOR UPDATE
            `;
            const experimentRows = asRows(lockedExperiment);
            const holdRows = asRows(lockedHold);
            const counters = experimentRows[0];
            const hold = holdRows[0];
            if (!counters || !hold || experimentRows.length !== 1 || holdRows.length !== 1) {
                return { ok: false as const };
            }
            const limitMicroUsd = micro(counters.limitMicroUsd);
            const spentMicroUsd = micro(counters.spentMicroUsd);
            const reservedMicroUsd = micro(counters.reservedMicroUsd);
            const holdReserved = micro(hold.reservedMicroUsd);
            if (
                limitMicroUsd === null || spentMicroUsd === null ||
                reservedMicroUsd === null || holdReserved === null ||
                typeof hold.experimentId !== "string" ||
                typeof hold.status !== "string" ||
                !PINNED_EXPERIMENT_HOLD_STATUSES.some((status) => status === hold.status)
            ) {
                return { ok: false as const };
            }
            const decision = applyExperimentClose(
                { limitMicroUsd, spentMicroUsd, reservedMicroUsd },
                {
                    status: hold.status as PinnedExperimentHoldStatus,
                    reservedMicroUsd: holdReserved,
                    experimentId: hold.experimentId,
                },
                input
            );
            if (!decision.ok) return { ok: false as const };
            if (decision.unchanged) return { ok: true as const };
            const holdWrites = await tx.$executeRaw`
                UPDATE "PinnedDeploymentExperimentHold"
                SET "status" = ${decision.status},
                    "settledMicroUsd" = ${decision.settledMicroUsd === null ? null : BigInt(decision.settledMicroUsd)},
                    "closedAt" = NOW()
                WHERE "id" = ${input.holdId} AND "status" = 'held'
            `;
            if (!wroteOne(holdWrites)) return { ok: true as const };
            const experimentWrites = await tx.$executeRaw`
                UPDATE "PinnedDeploymentExperiment"
                SET "spentMicroUsd" = ${BigInt(decision.spentMicroUsd)},
                    "reservedMicroUsd" = ${BigInt(decision.reservedMicroUsd)}
                WHERE "id" = ${input.experimentId}
            `;
            if (!wroteOne(experimentWrites)) throw new Error("experiment close was not stored");
            return { ok: true as const };
        });
    } catch {
        return { ok: false };
    }
};
