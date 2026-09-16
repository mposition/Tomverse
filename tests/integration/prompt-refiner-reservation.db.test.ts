import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
    consumePromptRefinerReservation,
    expirePromptRefinerReservations,
    releasePromptRefinerReservation,
    reservePromptRefinerExecution,
} from "@/lib/promptRefinerReservationAuthority";
import {
    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
} from "@/lib/promptRefinerExecutionContract";
import {
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
} from "@/lib/promptRefinerReservationCore";
import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";

const INPUT_PRICE_ENV = "CHAT_MODEL_GPT_5_6_LUNA_INPUT_USD_PER_MILLION";

const reset = async () => {
    await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          "PromptRefinerReservation",
          "PromptRefinerReservationStage"
        RESTART IDENTITY CASCADE
    `);
};

const ensureRuntimeModel = async () => {
    const row = staticModelRegistrySeedRows().find(
        (candidate) => candidate.id === PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId
    );
    assert.ok(row);
    await prisma.modelRegistryEntry.upsert({
        where: { id: row.id },
        create: row,
        update: row,
    });
};

const createStage = async (input: { status?: "approved" | "closed" } = {}) => {
    return prisma.promptRefinerReservationStage.create({
        data: {
            id: PROMPT_REFINER_RESERVATION_STAGE_ID,
            contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            status: input.status ?? "approved",
            perRequestCostMicroUsd: BigInt(24_916),
            maxReservations: 100,
            costCeilingMicroUsd: BigInt(2_491_600),
            reservationCount: 0,
            allocatedCostMicroUsd: BigInt(0),
            approvedBy: "mposition",
            approvedAt: new Date(),
        },
    });
};

const bindingOf = (reservation: {
    reservationId: string;
    requestId: string;
    stageId: string;
    contractDigest: string;
}) => ({
    reservationId: reservation.reservationId,
    requestId: reservation.requestId,
    stageId: reservation.stageId,
    contractDigest: reservation.contractDigest,
});

const wait = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

const holdStageLock = async () => {
    let signalLocked!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const transaction = prisma.$transaction(
        async (tx) => {
            await tx.$queryRaw`
                SELECT "id"
                FROM "PromptRefinerReservationStage"
                WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
                FOR UPDATE
            `;
            signalLocked();
            await gate;
            const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
                SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
            `;
            return clock!.now;
        },
        { timeout: 15_000 }
    );
    await locked;
    return { release, transaction };
};

before(async () => {
    await ensureRuntimeModel();
});

beforeEach(async () => {
    delete process.env[INPUT_PRICE_ENV];
    await reset();
});

test("reserve uses the DB clock and atomically binds one exact permanent slot", async () => {
    await createStage();
    const reserved = await reservePromptRefinerExecution({ requestId: "request_db_1" });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;
    assert.equal(reserved.value.created, true);
    assert.equal(reserved.value.reservation.status, "reserved");
    assert.equal(reserved.value.reservation.reservedCostMicroUsd, BigInt(24_916));
    assert.equal(
        reserved.value.reservation.expiresAt.getTime() -
            reserved.value.reservation.createdAt.getTime(),
        300_000
    );

    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 1);
    assert.equal(stage.allocatedCostMicroUsd, BigInt(24_916));
});

test("a stage must start at zero and direct counter updates cannot mint slots", async () => {
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({
            data: {
                id: PROMPT_REFINER_RESERVATION_STAGE_ID,
                contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                status: "approved",
                perRequestCostMicroUsd: BigInt(24_916),
                maxReservations: 100,
                costCeilingMicroUsd: BigInt(2_491_600),
                reservationCount: 1,
                allocatedCostMicroUsd: BigInt(24_916),
                approvedBy: "mposition",
                approvedAt: new Date(),
            },
        }),
        /must start with zero accounting/i
    );
    await createStage();
    await assert.rejects(
        prisma.promptRefinerReservationStage.update({
            where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
            data: {
                reservationCount: { increment: 1 },
                allocatedCostMicroUsd: { increment: BigInt(24_916) },
            },
        }),
        /accounting must equal durable tombstones/i
    );
    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 0);
    assert.equal(stage.allocatedCostMicroUsd, BigInt(0));
    assert.equal(await prisma.promptRefinerReservation.count(), 0);
});

test("reserve takes its DB clock after stage-lock contention and preserves the exact TTL", async () => {
    await createStage();
    const blocker = await holdStageLock();
    const reservationPromise = reservePromptRefinerExecution({ requestId: "request_waited" });
    await wait(350);
    blocker.release();
    const releasedAt = await blocker.transaction;
    const reserved = await reservationPromise;
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;
    assert.ok(reserved.value.reservation.createdAt.getTime() >= releasedAt.getTime());
    assert.equal(
        reserved.value.reservation.expiresAt.getTime() -
            reserved.value.reservation.createdAt.getTime(),
        300_000
    );
});

test("structural, missing-stage, closed-stage and missing-reservation refusals are reachable", async () => {
    assert.deepEqual(
        await reservePromptRefinerExecution({ requestId: "not a machine id" }),
        { ok: false, reason: "invalid_binding" }
    );
    assert.deepEqual(
        await reservePromptRefinerExecution({ requestId: "missing_stage" }),
        { ok: false, reason: "stage_not_found" }
    );
    await createStage({ status: "closed" });
    assert.deepEqual(
        await reservePromptRefinerExecution({ requestId: "closed_stage" }),
        { ok: false, reason: "stage_contract_mismatch" }
    );
    await reset();
    await createStage();
    assert.deepEqual(
        await consumePromptRefinerReservation({
            reservationId: "missing_reservation",
            requestId: "missing_request",
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
        }),
        { ok: false, reason: "reservation_not_found" }
    );
});

test("a repeated request is idempotent and never consumes a second slot", async () => {
    await createStage();
    const first = await reservePromptRefinerExecution({ requestId: "request_same" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await prisma.promptRefinerReservationStage.update({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
        data: { status: "closed" },
    });
    process.env[INPUT_PRICE_ENV] = "99";
    const second = await reservePromptRefinerExecution({ requestId: "request_same" });
    delete process.env[INPUT_PRICE_ENV];
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(first.value.created, true);
    assert.equal(second.value.created, false);
    assert.equal(second.value.kind, "active");
    assert.equal(second.value.reservation.reservationId, first.value.reservation.reservationId);
    assert.equal(await prisma.promptRefinerReservation.count(), 1);
    const released = await releasePromptRefinerReservation(bindingOf(first.value.reservation));
    assert.equal(released.ok, true);
    const terminal = await reservePromptRefinerExecution({ requestId: "request_same" });
    assert.equal(terminal.ok, false);
    if (terminal.ok) return;
    assert.equal(terminal.reason, "request_already_terminal");
    assert.equal("reservation" in terminal && terminal.reservation.status, "released");
    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 1);
});

test("every exact direct insert consumes budget and forged or 101st inserts fail closed", async () => {
    await createStage();
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const createdAt = clock!.now;
    const firstId = randomUUID();
    await prisma.promptRefinerReservation.create({
        data: {
            id: firstId,
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            requestId: "direct_request_0",
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            status: "reserved",
            reservedCostMicroUsd: BigInt(24_916),
            createdAt,
            expiresAt: new Date(createdAt.getTime() + 300_000),
        },
    });
    let stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 1);
    assert.equal(stage.allocatedCostMicroUsd, BigInt(24_916));

    const consumed = await consumePromptRefinerReservation({
        reservationId: firstId,
        requestId: "direct_request_0",
        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    });
    assert.equal(consumed.ok, true, consumed.ok ? undefined : consumed.reason);

    await assert.rejects(
        prisma.promptRefinerReservation.create({
            data: {
                id: randomUUID(),
                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
                requestId: "direct_request_0",
                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                status: "reserved",
                reservedCostMicroUsd: BigInt(24_916),
                createdAt,
                expiresAt: new Date(createdAt.getTime() + 300_000),
            },
        })
    );
    await assert.rejects(
        prisma.promptRefinerReservation.create({
            data: {
                id: randomUUID(),
                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
                requestId: "forged_ttl",
                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                status: "reserved",
                reservedCostMicroUsd: BigInt(24_916),
                createdAt,
                expiresAt: new Date(createdAt.getTime() + 300_001),
            },
        })
    );
    stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 1, "unique failure must roll trigger accounting back");

    await assert.rejects(
        prisma.promptRefinerReservation.create({
            data: {
                id: randomUUID(),
                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
                requestId: "forged_cost",
                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                status: "reserved",
                reservedCostMicroUsd: BigInt(1),
                createdAt,
                expiresAt: new Date(createdAt.getTime() + 300_000),
            },
        })
    );
    stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 1);

    await prisma.promptRefinerReservation.createMany({
        data: Array.from({ length: 99 }, (_, index) => ({
            id: `direct_${index + 1}`,
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            requestId: `direct_request_${index + 1}`,
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            status: "reserved",
            reservedCostMicroUsd: BigInt(24_916),
            createdAt,
            expiresAt: new Date(createdAt.getTime() + 300_000),
        })),
    });
    await assert.rejects(
        prisma.promptRefinerReservation.create({
            data: {
                id: "direct_101",
                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
                requestId: "direct_request_101",
                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                status: "reserved",
                reservedCostMicroUsd: BigInt(24_916),
                createdAt,
                expiresAt: new Date(createdAt.getTime() + 300_000),
            },
        })
    );
    stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 100);
    assert.equal(stage.allocatedCostMicroUsd, BigInt(2_491_600));
    assert.equal(await prisma.promptRefinerReservation.count(), 100);
});

test("consume requires the four-part binding and succeeds exactly once under race", async () => {
    await createStage();
    const reserved = await reservePromptRefinerExecution({ requestId: "request_consume" });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;
    const binding = bindingOf(reserved.value.reservation);
    assert.deepEqual(
        await consumePromptRefinerReservation({ ...binding, requestId: "wrong_request" }),
        { ok: false, reason: "request_binding_mismatch" }
    );

    const outcomes = await Promise.all([
        consumePromptRefinerReservation(binding),
        consumePromptRefinerReservation(binding),
    ]);
    assert.equal(outcomes.filter((result) => result.ok).length, 1);
    assert.equal(
        outcomes.filter((result) => !result.ok && result.reason === "reservation_not_active").length,
        1
    );
    const row = await prisma.promptRefinerReservation.findUniqueOrThrow({
        where: { id: binding.reservationId },
    });
    assert.equal(row.status, "consumed");
    assert.ok(row.consumedAt);
});

test("the database owns terminal clocks and turns every late direct transition into expiry", async () => {
    await createStage();
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const nearExpiryCreatedAt = new Date(clock!.now.getTime() - 298_800);
    await prisma.promptRefinerReservation.createMany({
        data: ["late_consume", "late_release"].map((requestId) => ({
            id: requestId,
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            requestId,
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            status: "reserved",
            reservedCostMicroUsd: BigInt(24_916),
            createdAt: nearExpiryCreatedAt,
            expiresAt: new Date(nearExpiryCreatedAt.getTime() + 300_000),
        })),
    });
    await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "prompt_refiner_a_test_delay_transition"()
        RETURNS TRIGGER AS $$
        BEGIN
            PERFORM pg_sleep(1.5);
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER "prompt_refiner_a_test_delay_transition_trigger"
        BEFORE UPDATE ON "PromptRefinerReservation"
        FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_a_test_delay_transition"();
    `);
    try {
        assert.deepEqual(
            await consumePromptRefinerReservation({
                reservationId: "late_consume",
                requestId: "late_consume",
                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            }),
            { ok: false, reason: "reservation_expired" }
        );
    } finally {
        await prisma.$executeRawUnsafe(`
            DROP TRIGGER IF EXISTS "prompt_refiner_a_test_delay_transition_trigger"
                ON "PromptRefinerReservation";
            DROP FUNCTION IF EXISTS "prompt_refiner_a_test_delay_transition"();
        `);
    }
    await prisma.$executeRaw`
        UPDATE "PromptRefinerReservation"
        SET "status" = 'released'
        WHERE "id" = 'late_release'
    `;
    const lateRows = await prisma.promptRefinerReservation.findMany({
        where: { id: { in: ["late_consume", "late_release"] } },
        orderBy: { id: "asc" },
    });
    assert.deepEqual(
        lateRows.map((row) => row.status),
        ["expired", "expired"]
    );
    assert.equal(lateRows.every((row) => row.expiredAt !== null), true);
    assert.equal(lateRows.every((row) => row.consumedAt === null && row.releasedAt === null), true);

    const active = await reservePromptRefinerExecution({ requestId: "db_owned_clock" });
    assert.equal(active.ok, true);
    if (!active.ok) return;
    const before = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const forged = new Date(0);
    await assert.rejects(
        prisma.$executeRaw`
            UPDATE "PromptRefinerReservation"
            SET "status" = 'consumed', "consumedAt" = ${forged}
            WHERE "id" = ${active.value.reservation.reservationId}
        `,
        /terminal timestamp is database-owned/i
    );
    await assert.rejects(
        prisma.$executeRaw`
            UPDATE "PromptRefinerReservation"
            SET "status" = 'expired'
            WHERE "id" = ${active.value.reservation.reservationId}
        `,
        /cannot expire before its deadline/i
    );
    await prisma.$executeRaw`
        UPDATE "PromptRefinerReservation"
        SET "status" = 'consumed'
        WHERE "id" = ${active.value.reservation.reservationId}
    `;
    const after = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const consumed = await prisma.promptRefinerReservation.findUniqueOrThrow({
        where: { id: active.value.reservation.reservationId },
    });
    assert.equal(consumed.status, "consumed");
    assert.ok(consumed.consumedAt);
    assert.ok(consumed.consumedAt.getTime() >= before[0]!.now.getTime());
    assert.ok(consumed.consumedAt.getTime() <= after[0]!.now.getTime());
    assert.equal(consumed.releasedAt, null);
    assert.equal(consumed.expiredAt, null);
});

test("naive reservation timestamps remain UTC under non-UTC database sessions", async () => {
    await createStage();
    const [databaseZone] = await prisma.$queryRaw<Array<{ zone: string }>>`
        SELECT current_setting('TimeZone') AS "zone"
    `;
    for (const [zone, requestedStatus] of [
        ["America/New_York", "consumed"],
        ["Asia/Seoul", "released"],
    ] as const) {
        await assert.rejects(
            prisma.$transaction(async (tx) => {
                await tx.$queryRaw`
                    SELECT set_config('TimeZone', ${zone}, true)
                `;
                const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
                    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
                `;
                const exactId = `timezone_exact_${requestedStatus}`;
                await tx.promptRefinerReservation.create({
                    data: {
                        id: exactId,
                        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
                        requestId: exactId,
                        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                        status: "reserved",
                        reservedCostMicroUsd: BigInt(24_916),
                        createdAt: clock!.now,
                        expiresAt: new Date(clock!.now.getTime() + 300_000),
                    },
                });
                const exact = await tx.promptRefinerReservation.findUniqueOrThrow({
                    where: { id: exactId },
                });
                assert.equal(exact.expiresAt.getTime() - exact.createdAt.getTime(), 300_000);

                const lateId = `timezone_late_${requestedStatus}`;
                const lateCreatedAt = new Date(clock!.now.getTime() - 299_700);
                await tx.promptRefinerReservation.create({
                    data: {
                        id: lateId,
                        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
                        requestId: lateId,
                        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                        status: "reserved",
                        reservedCostMicroUsd: BigInt(24_916),
                        createdAt: lateCreatedAt,
                        expiresAt: new Date(lateCreatedAt.getTime() + 300_000),
                    },
                });
                await wait(400);
                await tx.$executeRaw`
                    UPDATE "PromptRefinerReservation"
                    SET "status" = ${requestedStatus}
                    WHERE "id" = ${lateId}
                `;
                const late = await tx.promptRefinerReservation.findUniqueOrThrow({
                    where: { id: lateId },
                });
                assert.equal(late.status, "expired");
                assert.ok(late.expiredAt);
                assert.equal(late.consumedAt, null);
                assert.equal(late.releasedAt, null);
                throw new Error(`rollback-${zone}`);
            }),
            new RegExp(`rollback-${zone.replace(/[/.]/g, "\\$&")}`)
        );
        assert.equal(await prisma.promptRefinerReservation.count(), 0);
        const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
            where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
        });
        assert.equal(stage.reservationCount, 0);
        assert.equal(stage.allocatedCostMicroUsd, BigInt(0));
    }
    const [after] = await prisma.$queryRaw<Array<{ zone: string }>>`
        SELECT current_setting('TimeZone') AS "zone"
    `;
    assert.equal(after!.zone, databaseZone!.zone, "SET LOCAL must not leak past rollback");
});

test("consume observes expiry after stage-lock contention and commits the expired tombstone", async () => {
    await createStage();
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const createdAt = new Date(clock!.now.getTime() - 300_000 + 1_000);
    const expiresAt = new Date(createdAt.getTime() + 300_000);
    const reservationId = randomUUID();
    await prisma.promptRefinerReservation.create({
        data: {
            id: reservationId,
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            requestId: "request_crosses_expiry",
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            status: "reserved",
            reservedCostMicroUsd: BigInt(24_916),
            createdAt,
            expiresAt,
        },
    });
    const blocker = await holdStageLock();
    const consumePromise = consumePromptRefinerReservation({
        reservationId,
        requestId: "request_crosses_expiry",
        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    });
    await wait(Math.max(0, expiresAt.getTime() - clock!.now.getTime()) + 250);
    blocker.release();
    await blocker.transaction;
    assert.deepEqual(await consumePromise, { ok: false, reason: "reservation_expired" });
    const expired = await prisma.promptRefinerReservation.findUniqueOrThrow({
        where: { id: reservationId },
    });
    assert.equal(expired.status, "expired");
    assert.ok(expired.expiredAt);
});

test("release and expiry leave tombstones and do not refund stage bounds", async () => {
    await createStage();
    const releasedReservation = await reservePromptRefinerExecution({ requestId: "request_release" });
    assert.equal(releasedReservation.ok, true);
    if (!releasedReservation.ok) return;
    const released = await releasePromptRefinerReservation(
        bindingOf(releasedReservation.value.reservation)
    );
    assert.equal(released.ok, true);

    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const oldCreated = new Date(clock!.now.getTime() - 300_000 + 200);
    await prisma.promptRefinerReservation.create({
        data: {
            id: randomUUID(),
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            requestId: "request_expire",
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            status: "reserved",
            reservedCostMicroUsd: BigInt(24_916),
            createdAt: oldCreated,
            expiresAt: new Date(oldCreated.getTime() + 300_000),
        },
    });
    await wait(300);
    const expired = await expirePromptRefinerReservations();
    assert.equal(expired.ok, true);
    if (!expired.ok) return;
    assert.equal(expired.value.expiredCount, 1);
    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 2);
    assert.equal(stage.allocatedCostMicroUsd, BigInt(49_832));
    const groups = await prisma.promptRefinerReservation.groupBy({
        by: ["status"],
        _count: true,
    });
    assert.equal(
        groups.some((group) => group.status === "released" && group._count === 1),
        true
    );
    assert.equal(
        groups.some((group) => group.status === "expired" && group._count === 1),
        true
    );
});

test("expiry limit orders and updates only the bounded SQL selection", async () => {
    await createStage();
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const earlier = new Date(clock!.now.getTime() - 299_850);
    const later = new Date(clock!.now.getTime() - 299_750);
    await prisma.promptRefinerReservation.createMany({
        data: [
            { id: "expiry_limit_first", createdAt: earlier },
            { id: "expiry_limit_second", createdAt: later },
        ].map(({ id, createdAt }) => ({
            id,
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            requestId: id,
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            status: "reserved",
            reservedCostMicroUsd: BigInt(24_916),
            createdAt,
            expiresAt: new Date(createdAt.getTime() + 300_000),
        })),
    });
    await wait(350);
    const firstSweep = await expirePromptRefinerReservations({ limit: 1 });
    assert.equal(firstSweep.ok, true);
    if (!firstSweep.ok) return;
    assert.equal(firstSweep.value.expiredCount, 1);
    const afterFirst = await prisma.promptRefinerReservation.findMany({
        orderBy: { id: "asc" },
    });
    assert.deepEqual(
        afterFirst.map((row) => [row.id, row.status]),
        [
            ["expiry_limit_first", "expired"],
            ["expiry_limit_second", "reserved"],
        ]
    );
    const secondSweep = await expirePromptRefinerReservations({ limit: 1 });
    assert.equal(secondSweep.ok, true);
    if (!secondSweep.ok) return;
    assert.equal(secondSweep.value.expiredCount, 1);
    assert.equal(
        await prisma.promptRefinerReservation.count({ where: { status: "expired" } }),
        2
    );
});

test("runtime pricing drift rolls back without consuming a stage slot", async () => {
    await createStage();
    process.env[INPUT_PRICE_ENV] = "99";
    try {
        assert.deepEqual(
            await reservePromptRefinerExecution({ requestId: "request_drift" }),
            { ok: false, reason: "runtime_contract_mismatch" }
        );
    } finally {
        delete process.env[INPUT_PRICE_ENV];
    }
    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 0);
    assert.equal(stage.allocatedCostMicroUsd, BigInt(0));
    assert.equal(await prisma.promptRefinerReservation.count(), 0);

    const reserved = await reservePromptRefinerExecution({ requestId: "request_consume_drift" });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;
    process.env[INPUT_PRICE_ENV] = "99";
    try {
        assert.deepEqual(
            await consumePromptRefinerReservation(bindingOf(reserved.value.reservation)),
            { ok: false, reason: "runtime_contract_mismatch" }
        );
    } finally {
        delete process.env[INPUT_PRICE_ENV];
    }
    const stillReserved = await prisma.promptRefinerReservation.findUniqueOrThrow({
        where: { id: reserved.value.reservation.reservationId },
    });
    assert.equal(stillReserved.status, "reserved");
    assert.equal(
        (await consumePromptRefinerReservation(bindingOf(reserved.value.reservation))).ok,
        true
    );
});

test("a registry admin update cannot slip between consume validation and reservation CAS", async () => {
    await createStage();
    const reserved = await reservePromptRefinerExecution({ requestId: "request_registry_lock" });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;

    let signalReservationLocked!: () => void;
    let releaseReservation!: () => void;
    const reservationLocked = new Promise<void>((resolve) => {
        signalReservationLocked = resolve;
    });
    const reservationGate = new Promise<void>((resolve) => {
        releaseReservation = resolve;
    });
    const reservationBlocker = prisma.$transaction(
        async (tx) => {
            await tx.$queryRaw`
                SELECT "id"
                FROM "PromptRefinerReservation"
                WHERE "id" = ${reserved.value.reservation.reservationId}
                FOR UPDATE
            `;
            signalReservationLocked();
            await reservationGate;
        },
        { timeout: 15_000 }
    );
    await reservationLocked;

    const consumePromise = consumePromptRefinerReservation(
        bindingOf(reserved.value.reservation)
    );
    let registryShareLockSeen = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const [lock] = await prisma.$queryRaw<Array<{ count: number }>>`
            SELECT COUNT(*)::INTEGER AS "count"
            FROM pg_locks AS locks
            JOIN pg_class AS relation ON relation.oid = locks.relation
            WHERE relation.relname = 'ModelRegistryEntry'
              AND locks.mode = 'ShareLock'
              AND locks.granted
        `;
        if ((lock?.count ?? 0) > 0) {
            registryShareLockSeen = true;
            break;
        }
        await wait(20);
    }
    assert.equal(registryShareLockSeen, true);
    try {
        await assert.rejects(
            prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
                await tx.$executeRaw`
                    UPDATE "ModelRegistryEntry"
                    SET "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
                    WHERE "id" = ${PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId}
                `;
            }),
            (error: unknown) => {
                assert.match(String(error), /lock timeout|55P03/i);
                return true;
            }
        );
    } finally {
        releaseReservation();
        await reservationBlocker;
    }
    assert.equal((await consumePromise).ok, true);
});

test("a failure after reservation insert rolls the row and stage accounting back together", async () => {
    await createStage();
    await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "prompt_refiner_test_reject_stage_update"()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION 'forced stage update failure';
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER "prompt_refiner_test_reject_stage_update_trigger"
        BEFORE UPDATE ON "PromptRefinerReservationStage"
        FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_test_reject_stage_update"();
    `);
    try {
        await assert.rejects(
            reservePromptRefinerExecution({ requestId: "request_forced_rollback" })
        );
    } finally {
        await prisma.$executeRawUnsafe(`
            DROP TRIGGER IF EXISTS "prompt_refiner_test_reject_stage_update_trigger"
                ON "PromptRefinerReservationStage";
            DROP FUNCTION IF EXISTS "prompt_refiner_test_reject_stage_update"();
        `);
    }
    assert.equal(await prisma.promptRefinerReservation.count(), 0);
    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 0);
    assert.equal(stage.allocatedCostMicroUsd, BigInt(0));
});

test("stage-row locking admits only the remaining five slots under concurrency", async () => {
    await createStage();
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const oldCreated = new Date(clock!.now.getTime());
    await prisma.promptRefinerReservation.createMany({
        data: Array.from({ length: 95 }, (_, index) => ({
            id: `historic_${index}`,
            stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
            requestId: `historic_request_${index}`,
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            status: "reserved",
            reservedCostMicroUsd: BigInt(24_916),
            createdAt: oldCreated,
            expiresAt: new Date(oldCreated.getTime() + 300_000),
        })),
    });
    const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
            reservePromptRefinerExecution({ requestId: `race_request_${index}` })
        )
    );
    assert.equal(results.filter((result) => result.ok).length, 5);
    assert.equal(
        results.filter((result) => !result.ok && result.reason === "stage_capacity_exhausted").length,
        5
    );
    const stage = await prisma.promptRefinerReservationStage.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    assert.equal(stage.reservationCount, 100);
    assert.equal(stage.allocatedCostMicroUsd, BigInt(2_491_600));
    assert.equal(await prisma.promptRefinerReservation.count(), 100);
});

test("database constraints reject malformed state and triggers prevent deletion or reuse", async () => {
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({
            data: {
                id: "another_stage",
                contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                status: "approved",
                perRequestCostMicroUsd: BigInt(24_916),
                maxReservations: 100,
                costCeilingMicroUsd: BigInt(2_491_600),
                approvedBy: "mposition",
                approvedAt: new Date(),
            },
        })
    );
    await createStage();
    await assert.rejects(
        prisma.promptRefinerReservation.create({
            data: {
                id: "bad_state",
                stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
                requestId: "bad_state_request",
                contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                status: "consumed",
                reservedCostMicroUsd: BigInt(24_916),
                expiresAt: new Date(Date.now() + 300_000),
            },
        })
    );
    const reserved = await reservePromptRefinerExecution({ requestId: "request_no_delete" });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;
    const consumed = await consumePromptRefinerReservation(bindingOf(reserved.value.reservation));
    assert.equal(consumed.ok, true);
    await assert.rejects(
        prisma.promptRefinerReservation.delete({
            where: { id: reserved.value.reservation.reservationId },
        })
    );
    await assert.rejects(
        prisma.promptRefinerReservation.update({
            where: { id: reserved.value.reservation.reservationId },
            data: { status: "reserved", consumedAt: null },
        })
    );
    await assert.rejects(
        prisma.promptRefinerReservationStage.delete({
            where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
        })
    );
});
