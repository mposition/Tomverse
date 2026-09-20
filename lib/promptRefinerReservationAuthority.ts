import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type ModelRegistryEntry } from "@prisma/client";

import { getModelPricingProfile } from "@/lib/modelPricing";
import { registryRowToModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";
import {
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    promptRefinerExecutionContractProblems,
} from "@/lib/promptRefinerExecutionContract";
import {
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
    PROMPT_REFINER_RESERVATION_TTL_MS,
    promptRefinerReservationBindingMatches,
    promptRefinerReservationIdentifiersAreValid,
    promptRefinerReservationStageProblems,
    type PromptRefinerReservationBinding,
    type PromptRefinerReservationRefusal,
} from "@/lib/promptRefinerReservationCore";
import {
    loadPromptRefinerStageAdmissionFacts,
    PromptRefinerStageAdmissionError,
    promptRefinerStageAuthorizationIsValid,
    promptRefinerStoredStageMatchesRuntime,
} from "@/lib/promptRefinerStageAdmission";

type ReservationFacts = PromptRefinerReservationBinding & {
    status: "reserved" | "consumed" | "released" | "expired";
    reservedCostMicroUsd: bigint;
    expiresAt: Date;
    createdAt: Date;
    consumedAt: Date | null;
    releasedAt: Date | null;
    expiredAt: Date | null;
};

type AuthorityResult<T> =
    | { ok: true; value: T }
    | { ok: false; reason: PromptRefinerReservationRefusal };

const refuse = <T>(reason: PromptRefinerReservationRefusal): AuthorityResult<T> => ({
    ok: false,
    reason,
});

const refuseRuntimeFacts = <T>(error: unknown): AuthorityResult<T> => {
    if (
        error instanceof PromptRefinerStageAdmissionError &&
        error.code === "PROMPT_REFINER_STAGE_EXECUTION_DRIFT"
    ) {
        return refuse("runtime_contract_mismatch");
    }
    return refuse("runtime_source_mismatch");
};

const dbClock = async (tx: Prisma.TransactionClient) => {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    if (!clock) throw new Error("PostgreSQL did not return its transaction clock");
    return clock.now;
};

// Global lock order for every authority mutation:
//   fixed stage row -> model registry table -> reservation row(s).
// SHARE covers both the pinned row and the absent-row case, so an admin
// INSERT/UPDATE/DELETE cannot change the runtime contract after validation.
const lockModelRegistry = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe('LOCK TABLE "ModelRegistryEntry" IN SHARE MODE');
};

const lockStage = async (tx: Prisma.TransactionClient, stageId: string) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "PromptRefinerReservationStage"
        WHERE "id" = ${stageId}
        FOR UPDATE
    `;
    if (locked.length !== 1) return null;
    return tx.promptRefinerReservationStage.findUnique({ where: { id: stageId } });
};

const lockedRuntimeContractIsCurrent = async (tx: Prisma.TransactionClient) => {
    const row = await tx.modelRegistryEntry.findUnique({
        where: { id: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId },
    });
    if (!row) return false;
    let model;
    try {
        model = registryRowToModel(row as ModelRegistryEntry);
    } catch {
        return false;
    }
    const pricing = getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
    return promptRefinerExecutionContractProblems({ model, pricing }).length === 0;
};

const facts = (row: {
    id: string;
    requestId: string;
    stageId: string;
    contractDigest: string;
    status: string;
    reservedCostMicroUsd: bigint;
    expiresAt: Date;
    createdAt: Date;
    consumedAt: Date | null;
    releasedAt: Date | null;
    expiredAt: Date | null;
}): ReservationFacts => ({
    reservationId: row.id,
    requestId: row.requestId,
    stageId: row.stageId,
    contractDigest: row.contractDigest,
    status: row.status as ReservationFacts["status"],
    reservedCostMicroUsd: row.reservedCostMicroUsd,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    consumedAt: row.consumedAt,
    releasedAt: row.releasedAt,
    expiredAt: row.expiredAt,
});

/**
 * Atomically consumes one of the stage's permanent slots and its worst-case
 * cost. Expired and released rows remain tombstones and never refund either.
 */
export const reservePromptRefinerExecution = async (input: {
    requestId: string;
    stageId?: string;
}): Promise<
    | AuthorityResult<{ kind: "active"; created: boolean; reservation: ReservationFacts }>
    | {
          ok: false;
          reason: "request_already_terminal";
          reservation: ReservationFacts;
      }
> => {
    const stageId = input.stageId ?? PROMPT_REFINER_RESERVATION_STAGE_ID;
    if (
        stageId !== PROMPT_REFINER_RESERVATION_STAGE_ID ||
        !promptRefinerReservationIdentifiersAreValid({ requestId: input.requestId })
    ) {
        return refuse("invalid_binding");
    }

    let runtimeFacts: Awaited<ReturnType<typeof loadPromptRefinerStageAdmissionFacts>>;
    try {
        runtimeFacts = await loadPromptRefinerStageAdmissionFacts();
    } catch (error) {
        return refuseRuntimeFacts(error);
    }

    return prisma.$transaction(async (tx) => {
        // Global lock order: stage -> model registry -> reservation.
        const stage = await lockStage(tx, stageId);
        if (!stage) return refuse("stage_not_found");
        if (!(await promptRefinerStageAuthorizationIsValid(tx, stage))) {
            return refuse("stage_authorization_invalid");
        }
        await lockModelRegistry(tx);
        const now = await dbClock(tx);
        // Idempotency never revives stale authority. A requestId replay may
        // reuse its active reservation only while the same stage, deployment,
        // source, execution contract, model and pricing remain authorized.
        if (
            promptRefinerReservationStageProblems(stage).length > 0 ||
            !promptRefinerStoredStageMatchesRuntime(stage, runtimeFacts, now)
        ) {
            return refuse("stage_contract_mismatch");
        }
        if (!(await lockedRuntimeContractIsCurrent(tx))) {
            return refuse("runtime_contract_mismatch");
        }
        const existingId = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "PromptRefinerReservation"
            WHERE "requestId" = ${input.requestId}
            FOR UPDATE
        `;
        if (existingId.length === 1) {
            const existing = await tx.promptRefinerReservation.findUniqueOrThrow({
                where: { id: existingId[0]!.id },
            });
            if (
                existing.stageId !== stageId ||
                existing.contractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST
            ) {
                return refuse("request_binding_mismatch");
            }
            if (existing.status !== "reserved") {
                return {
                    ok: false,
                    reason: "request_already_terminal",
                    reservation: facts(existing),
                };
            }
            if (existing.expiresAt.getTime() <= now.getTime()) {
                const expired = await tx.promptRefinerReservation.update({
                    where: { id: existing.id },
                    // The database trigger owns the terminal timestamp.
                    data: { status: "expired" },
                });
                return {
                    ok: false,
                    reason: "request_already_terminal",
                    reservation: facts(expired),
                };
            }
            return {
                ok: true,
                value: { kind: "active", created: false, reservation: facts(existing) },
            };
        }

        if (stage.reservationCount >= stage.maxReservations) {
            return refuse("stage_capacity_exhausted");
        }
        const requestCost = BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD);

        const reservation = await tx.promptRefinerReservation.create({
            data: {
                id: randomUUID(),
                requestId: input.requestId,
                stageId,
                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                status: "reserved",
                reservedCostMicroUsd: requestCost,
                expiresAt: new Date(now.getTime() + PROMPT_REFINER_RESERVATION_TTL_MS),
                createdAt: now,
            },
        });
        return {
            ok: true,
            value: { kind: "active", created: true, reservation: facts(reservation) },
        };
    });
};

const transitionReservation = async (input: {
    binding: PromptRefinerReservationBinding;
    transition: "consume" | "release";
}): Promise<AuthorityResult<ReservationFacts>> => {
    if (
        input.binding.stageId !== PROMPT_REFINER_RESERVATION_STAGE_ID ||
        input.binding.contractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST ||
        !promptRefinerReservationIdentifiersAreValid({
            requestId: input.binding.requestId,
            reservationId: input.binding.reservationId,
        })
    ) {
        return refuse("invalid_binding");
    }

    let runtimeFacts: Awaited<ReturnType<typeof loadPromptRefinerStageAdmissionFacts>> | undefined;
    if (input.transition === "consume") {
        try {
            runtimeFacts = await loadPromptRefinerStageAdmissionFacts();
        } catch (error) {
            return refuseRuntimeFacts(error);
        }
    }

    return prisma.$transaction(async (tx) => {
        const stage = await lockStage(tx, input.binding.stageId);
        if (!stage) return refuse("stage_not_found");
        if (
            input.transition === "consume" &&
            !(await promptRefinerStageAuthorizationIsValid(tx, stage))
        ) {
            return refuse("stage_authorization_invalid");
        }
        await lockModelRegistry(tx);
        const now = await dbClock(tx);
        if (
            promptRefinerReservationStageProblems(stage, {
                requireApproved: input.transition === "consume",
            }).length > 0 ||
            (input.transition === "consume" &&
                (!runtimeFacts ||
                    !promptRefinerStoredStageMatchesRuntime(
                        stage,
                        runtimeFacts,
                        now
                    )))
        ) {
            return refuse("stage_contract_mismatch");
        }
        if (input.transition === "consume" && !(await lockedRuntimeContractIsCurrent(tx))) {
            return refuse("runtime_contract_mismatch");
        }

        const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "PromptRefinerReservation"
            WHERE "id" = ${input.binding.reservationId}
            FOR UPDATE
        `;
        if (locked.length !== 1) return refuse("reservation_not_found");
        const current = await tx.promptRefinerReservation.findUnique({
            where: { id: input.binding.reservationId },
        });
        if (!current) return refuse("reservation_not_found");
        if (!promptRefinerReservationBindingMatches(input.binding, {
            reservationId: current.id,
            requestId: current.requestId,
            stageId: current.stageId,
            contractDigest: current.contractDigest,
        })) {
            return refuse("request_binding_mismatch");
        }
        if (current.status !== "reserved") return refuse("reservation_not_active");

        if (current.expiresAt.getTime() <= now.getTime()) {
            await tx.promptRefinerReservation.update({
                where: { id: current.id },
                data: { status: "expired" },
            });
            return refuse("reservation_expired");
        }

        if (input.transition === "consume") {
            const intent = await tx.promptRefinerShadowAttempt.findUnique({
                where: { reservationId: current.id },
                select: { id: true },
            });
            if (!intent) return refuse("dispatch_intent_required");
        }

        const updated = await tx.promptRefinerReservation.updateMany({
            where: { id: current.id, status: "reserved" },
            data:
                input.transition === "consume"
                    ? { status: "consumed" }
                    : { status: "released" },
        });
        if (updated.count !== 1) return refuse("reservation_not_active");
        const terminal = await tx.promptRefinerReservation.findUniqueOrThrow({
            where: { id: current.id },
        });
        // The database samples its own clock in the transition trigger. If the
        // deadline crossed after our locked read, it atomically stores an
        // expired tombstone instead of accepting a late consume/release.
        if (terminal.status === "expired") return refuse("reservation_expired");
        return { ok: true, value: facts(terminal) };
    });
};

export const consumePromptRefinerReservation = (
    binding: PromptRefinerReservationBinding
) => transitionReservation({ binding, transition: "consume" });

export const releasePromptRefinerReservation = (
    binding: PromptRefinerReservationBinding
) => transitionReservation({ binding, transition: "release" });

/** Expires active rows in bounded batches; slots and cost remain allocated. */
export const expirePromptRefinerReservations = async (input?: {
    stageId?: string;
    limit?: number;
}): Promise<AuthorityResult<{ expiredCount: number; observedAt: Date }>> => {
    const stageId = input?.stageId ?? PROMPT_REFINER_RESERVATION_STAGE_ID;
    const limit = input?.limit ?? 100;
    if (
        stageId !== PROMPT_REFINER_RESERVATION_STAGE_ID ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
    ) {
        return refuse("invalid_binding");
    }
    return prisma.$transaction(async (tx) => {
        const stage = await lockStage(tx, stageId);
        if (!stage) return refuse("stage_not_found");
        await lockModelRegistry(tx);
        if (
            promptRefinerReservationStageProblems(stage, {
                requireApproved: false,
            }).length > 0
        ) {
            return refuse("stage_contract_mismatch");
        }
        const lockedRows = await tx.$queryRaw<Array<{ id: string; expiresAt: Date }>>(Prisma.sql`
            SELECT "id", "expiresAt"
            FROM "PromptRefinerReservation"
            WHERE "stageId" = ${stageId}
              AND "status" = 'reserved'
              AND "expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
            ORDER BY "expiresAt", "id"
            LIMIT ${limit}
            FOR UPDATE
        `);
        const now = await dbClock(tx);
        const rows = lockedRows;
        if (rows.length > 0) {
            await tx.promptRefinerReservation.updateMany({
                where: { id: { in: rows.map((row) => row.id) }, status: "reserved" },
                data: { status: "expired" },
            });
        }
        return { ok: true, value: { expiredCount: rows.length, observedAt: now } };
    });
};
