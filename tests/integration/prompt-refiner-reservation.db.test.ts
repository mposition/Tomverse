import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
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
import { loadPromptRefinerStageAdmissionFacts } from "@/lib/promptRefinerStageAdmission";
import {
    PROMPT_REFINER_STAGE_APPROVAL_TTL_MS,
    PROMPT_REFINER_STAGE_REASON,
    prefixedPromptRefinerDigest,
} from "@/lib/promptRefinerStageAdmissionCore";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";

const INPUT_PRICE_ENV = "CHAT_MODEL_GPT_5_6_LUNA_INPUT_USD_PER_MILLION";
const FIXTURE_COMMIT_SHA = "a".repeat(40);
const FIXTURE_DEPLOYMENT_ID = "prompt-refiner-db-test";
process.env.RAILWAY_ENVIRONMENT_NAME = "staging";
process.env.RAILWAY_GIT_COMMIT_SHA = FIXTURE_COMMIT_SHA;
process.env.RAILWAY_DEPLOYMENT_ID = FIXTURE_DEPLOYMENT_ID;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = "prompt-refiner-reservation-strong-fixture-key";

const fixtureSession = { user: { id: "mposition", email: "owner@example.com" } } as Session;
const fixtureRequest = new Request("http://127.0.0.1:3100/db-fixture", {
    headers: { "user-agent": "prompt-refiner-db-integration" },
});

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

const stageCreateData = async (input: {
    id?: string;
    status?: "approved" | "closed";
    reservationCount?: number;
    allocatedCostMicroUsd?: bigint;
} = {}) => {
    const facts = await loadPromptRefinerStageAdmissionFacts();
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const approvedAt = clock!.now;
    const approvalExpiresAt = new Date(approvedAt.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS);
    const auditId = await writeAdminAuditLog({
        session: fixtureSession,
        request: fixtureRequest,
        action: "prompt_refiner.shadow_stage.activated",
        targetType: "PromptRefinerReservationStage",
        targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
        summary: "Approved the bounded Prompt Refiner staging shadow stage.",
        metadata: {
            admissionVersion: facts.admissionVersion,
            proposalDigest: facts.proposalDigest,
            evidenceBundleDigest: facts.evidenceBundleDigest,
            runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
            executionManifestDigest: facts.executionManifestDigest,
            environment: facts.runtimeEnvironment,
            deploymentId: facts.runtimeDeploymentId,
            commitSha: facts.runtimeCommitSha,
            perRequestCostMicroUsd: 24_916,
            maxReservations: 100,
            costCeilingMicroUsd: 2_491_600,
            approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
            runApprovalEnabled: true,
            executionEnabled: true,
            approvedAt: approvedAt.toISOString(),
            approvalExpiresAt: approvalExpiresAt.toISOString(),
            reason: PROMPT_REFINER_STAGE_REASON,
        },
    });
    return {
            id: input.id ?? PROMPT_REFINER_RESERVATION_STAGE_ID,
            contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
            contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
            status: input.status ?? "approved",
            perRequestCostMicroUsd: BigInt(24_916),
            maxReservations: 100,
            costCeilingMicroUsd: BigInt(2_491_600),
            reservationCount: input.reservationCount ?? 0,
            allocatedCostMicroUsd: input.allocatedCostMicroUsd ?? BigInt(0),
            admissionVersion: facts.admissionVersion,
            proposalVersion: facts.proposalVersion,
            proposalDigest: facts.proposalDigest,
            evidenceBundleDigest: facts.evidenceBundleDigest,
            evidenceManifestSha256: facts.evidenceManifestSha256,
            historicalSourceRef: facts.historicalSourceRef,
            historicalSourceIdentityDigest: facts.historicalSourceIdentityDigest,
            corpusDigest: facts.corpusDigest,
            runtimeCommitSha: facts.runtimeCommitSha,
            runtimeSourceIdentityDigest: facts.runtimeSourceIdentityDigest,
            runtimeSourceManifest: facts.runtimeSourceManifest,
            runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
            runtimeEnvironment: facts.runtimeEnvironment,
            runtimeDeploymentId: facts.runtimeDeploymentId,
            executionManifest: facts.executionManifest,
            executionManifestDigest: facts.executionManifestDigest,
            approvedBy: "mposition",
            approvedAt,
            approvalExpiresAt,
            authorizationAuditLogId: auditId,
    };
};

const rebindStageAudit = async (data: Awaited<ReturnType<typeof stageCreateData>>) => {
    data.authorizationAuditLogId = await writeAdminAuditLog({
        session: fixtureSession,
        request: fixtureRequest,
        action: "prompt_refiner.shadow_stage.activated",
        targetType: "PromptRefinerReservationStage",
        targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
        summary: "Approved the bounded Prompt Refiner staging shadow stage.",
        metadata: {
            admissionVersion: data.admissionVersion,
            proposalDigest: data.proposalDigest,
            evidenceBundleDigest: data.evidenceBundleDigest,
            runtimeSourceManifestDigest: data.runtimeSourceManifestDigest,
            executionManifestDigest: data.executionManifestDigest,
            environment: data.runtimeEnvironment,
            deploymentId: data.runtimeDeploymentId,
            commitSha: data.runtimeCommitSha,
            perRequestCostMicroUsd: Number(data.perRequestCostMicroUsd),
            maxReservations: data.maxReservations,
            costCeilingMicroUsd: Number(data.costCeilingMicroUsd),
            approvalTtlMinutes: 60,
            runApprovalEnabled: true,
            executionEnabled: true,
            approvedAt: data.approvedAt.toISOString(),
            approvalExpiresAt: data.approvalExpiresAt.toISOString(),
            reason: PROMPT_REFINER_STAGE_REASON,
        },
    });
    return data;
};

const recomputeRuntimeManifestDigests = (data: Awaited<ReturnType<typeof stageCreateData>>) => {
    const manifest = data.runtimeSourceManifest as unknown as { files: Array<Record<string, unknown>> };
    data.runtimeSourceIdentityDigest = prefixedPromptRefinerDigest({ files: manifest.files });
    data.runtimeSourceManifestDigest = prefixedPromptRefinerDigest(data.runtimeSourceManifest);
};

const createStage = async (input: { status?: "approved" | "closed" } = {}) => {
    const stage = await prisma.promptRefinerReservationStage.create({
        data: await stageCreateData({ ...input, status: "approved" }),
    });
    if (input.status === "closed") {
        return prisma.promptRefinerReservationStage.update({ where: { id: stage.id }, data: { status: "closed" } });
    }
    return stage;
};

const legacyStageFixture = async (version: 1 | 2 | 3) => {
    const facts = await loadPromptRefinerStageAdmissionFacts();
    const stageId = `prompt-refiner-shadow-v${version}`;
    const contractDigest = {
        1: "sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f",
        2: "sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1",
        3: "sha256:3d1ed8d096a6c0530ee8a20b61b479c67fe8e658f4ebcd31062311ff2079ce72",
    }[version];
    const removedPaths = new Set([
        "prisma/migrations/20260928130000_prompt_refiner_confirmatory_successor_v4/migration.sql",
        ...(version <= 2
            ? ["prisma/migrations/20260927130000_prompt_refiner_shadow_stage_successor_v3/migration.sql"]
            : []),
        ...(version === 1
            ? ["prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql"]
            : []),
    ]);
    const currentManifest = facts.runtimeSourceManifest as unknown as {
        commitSha: string;
        files: Array<{ path: string; sizeBytes: number; sha256: string }>;
    };
    const files = currentManifest.files.filter((entry) => !removedPaths.has(entry.path));
    const runtimeSourceManifest = {
        schemaVersion: `prompt-refiner-runtime-source-manifest-v${version + 1}`,
        commitSha: currentManifest.commitSha,
        totalSizeBytes: files.reduce((sum, entry) => sum + entry.sizeBytes, 0),
        files,
    };
    const runtimeSourceIdentityDigest = prefixedPromptRefinerDigest({ files });
    const runtimeSourceManifestDigest = prefixedPromptRefinerDigest(runtimeSourceManifest);
    const executionManifest = structuredClone(facts.executionManifest) as unknown as Record<string, unknown>;
    executionManifest.schemaVersion = `prompt-refiner-shadow-execution-manifest-v${version}`;
    executionManifest.stageId = stageId;
    executionManifest.reservationContractDigest = contractDigest;
    executionManifest.runtimeSource = {
        fileCount: 186 + version,
        maxFileBytes: 8 * 1024 * 1024,
        maxTotalBytes: 16 * 1024 * 1024,
    };
    const executionManifestDigest = prefixedPromptRefinerDigest(executionManifest);
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    assert.ok(clock);
    const approvedAt = clock.now;
    const approvalExpiresAt = new Date(approvedAt.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS);
    const authorizationAuditLogId = await writeAdminAuditLog({
        session: fixtureSession,
        request: fixtureRequest,
        action: "prompt_refiner.shadow_stage.activated",
        targetType: "PromptRefinerReservationStage",
        targetId: stageId,
        summary: "Preserved an exact legacy Prompt Refiner staging shadow stage fixture.",
        metadata: {
            admissionVersion: `prompt-refiner-stage-admission-v${version}`,
            proposalDigest: facts.proposalDigest,
            evidenceBundleDigest: facts.evidenceBundleDigest,
            runtimeSourceManifestDigest,
            executionManifestDigest,
            environment: facts.runtimeEnvironment,
            deploymentId: facts.runtimeDeploymentId,
            commitSha: facts.runtimeCommitSha,
            perRequestCostMicroUsd: 24_916,
            maxReservations: 100,
            costCeilingMicroUsd: 2_491_600,
            approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
            ...(version === 3
                ? { runApprovalEnabled: true, executionEnabled: true }
                : {}),
            approvedAt: approvedAt.toISOString(),
            approvalExpiresAt: approvalExpiresAt.toISOString(),
            reason: PROMPT_REFINER_STAGE_REASON,
        },
    });
    return {
        stageId,
        contractDigest,
        admissionVersion: `prompt-refiner-stage-admission-v${version}`,
        facts,
        runtimeSourceManifest,
        runtimeSourceIdentityDigest,
        runtimeSourceManifestDigest,
        executionManifest,
        executionManifestDigest,
        approvedAt,
        approvalExpiresAt,
        authorizationAuditLogId,
    };
};

const insertLegacyStageFixture = async (
    fixture: Awaited<ReturnType<typeof legacyStageFixture>>
) => prisma.$executeRawUnsafe(
    `
      INSERT INTO "PromptRefinerReservationStage" (
        "id", "contractVersion", "contractDigest", "status",
        "perRequestCostMicroUsd", "maxReservations", "costCeilingMicroUsd",
        "reservationCount", "allocatedCostMicroUsd", "admissionVersion",
        "proposalVersion", "proposalDigest", "evidenceBundleDigest",
        "evidenceManifestSha256", "historicalSourceRef",
        "historicalSourceIdentityDigest", "corpusDigest", "runtimeCommitSha",
        "runtimeSourceIdentityDigest", "runtimeSourceManifest",
        "runtimeSourceManifestDigest", "runtimeEnvironment", "runtimeDeploymentId",
        "executionManifest", "executionManifestDigest", "approvedBy", "approvedAt",
        "approvalExpiresAt", "authorizationAuditLogId", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, 'approved', 24916, 100, 2491600, 0, 0, $4,
        $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17,
        $18::jsonb, $19, 'mposition', $20, $21, $22, $20, $20
      )
    `,
    fixture.stageId,
    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    fixture.contractDigest,
    fixture.admissionVersion,
    fixture.facts.proposalVersion,
    fixture.facts.proposalDigest,
    fixture.facts.evidenceBundleDigest,
    fixture.facts.evidenceManifestSha256,
    fixture.facts.historicalSourceRef,
    fixture.facts.historicalSourceIdentityDigest,
    fixture.facts.corpusDigest,
    fixture.facts.runtimeCommitSha,
    fixture.runtimeSourceIdentityDigest,
    JSON.stringify(fixture.runtimeSourceManifest),
    fixture.runtimeSourceManifestDigest,
    fixture.facts.runtimeEnvironment,
    fixture.facts.runtimeDeploymentId,
    JSON.stringify(fixture.executionManifest),
    fixture.executionManifestDigest,
    fixture.approvedAt,
    fixture.approvalExpiresAt,
    fixture.authorizationAuditLogId
);

const legacyRunFixture = (
    version: 3 | 4 | 5,
    stage: Awaited<ReturnType<typeof legacyStageFixture>>
) => ({
    id: `legacy-shadow-run-v${version}`,
    stageId: stage.stageId,
    runContractVersion: `prompt-refiner-shadow-run-v${version}`,
    runContractDigest: {
        3: "sha256:7c487a9b88258f5be3e704bcea0c491def7a9f96830b66c6cbd3512361ecf280",
        4: "sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7",
        5: "sha256:774dd559f20a69c7c94f55b1204245b77dc93769771e6b5abd0f60c5099415fd",
    }[version],
    evidenceSpecDigest: version === 3
        ? null
        : "7794b9fbbd8fba1f16d19f935a977098f3f7a8d302014d6e7de3fe00813ae4c1",
    previewBindingDigest: `sha256:${version.toString(16).repeat(64)}`,
    authorizationAuditLogId: `legacy-shadow-run-v${version}-audit`,
    stage,
});

const insertLegacyRunFixture = async (
    fixture: ReturnType<typeof legacyRunFixture>
) => prisma.$executeRawUnsafe(
    `
      INSERT INTO "PromptRefinerShadowRun" (
        "id", "stageId", "runContractVersion", "runContractDigest", "corpusDigest",
        "evidenceSpecDigest", "adapterVersion", "status", "perRequestCostMicroUsd",
        "maxDispatches", "costCeilingMicroUsd", "dispatchCount", "terminalCount",
        "knownActualCostMicroUsd", "runtimeCommitSha", "runtimeDeploymentId",
        "runtimeSourceManifest", "runtimeSourceManifestDigest", "previewBindingDigest",
        "approvedBy", "approvedAt", "approvalExpiresAt", "authorizationAuditLogId",
        "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'prompt-refiner-openai-sdk-adapter-v1', 'approved',
        24916, 16, 398656, 0, 0, 0, $7, $8, $9::jsonb, $10, $11, 'mposition',
        $12, $13, $14, $12, $12
      )
    `,
    fixture.id,
    fixture.stageId,
    fixture.runContractVersion,
    fixture.runContractDigest,
    fixture.stage.facts.corpusDigest,
    fixture.evidenceSpecDigest,
    fixture.stage.facts.runtimeCommitSha,
    fixture.stage.facts.runtimeDeploymentId,
    JSON.stringify(fixture.stage.runtimeSourceManifest),
    fixture.stage.runtimeSourceManifestDigest,
    fixture.previewBindingDigest,
    fixture.stage.approvedAt,
    fixture.stage.approvalExpiresAt,
    fixture.authorizationAuditLogId
);

const insertLegacyReservationFixture = async (input: {
    id: string;
    stageId: string;
    requestId: string;
    contractDigest: string;
    createdAt: Date;
}) => prisma.$executeRawUnsafe(
    `
      INSERT INTO "PromptRefinerReservation" (
        "id", "stageId", "requestId", "contractDigest", "status",
        "reservedCostMicroUsd", "expiresAt", "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, 'reserved', 24916, $5, $6, $6)
    `,
    input.id,
    input.stageId,
    input.requestId,
    input.contractDigest,
    new Date(input.createdAt.getTime() + 5 * 60_000),
    input.createdAt
);

const insertLegacyAttemptFixture = async (input: {
    id: string;
    runId: string;
    reservationId: string;
    requestId: string;
    caseIndex: number;
    stageId: string;
    reservationContractDigest: string;
    runContractDigest: string;
    createdAt: Date;
}) => prisma.$executeRawUnsafe(
    `
      INSERT INTO "PromptRefinerShadowAttempt" (
        "id", "runId", "reservationId", "requestId", "caseId", "caseIndex",
        "stageId", "reservationContractDigest", "runContractDigest", "provider",
        "modelId", "adapterVersion", "status", "dispatchIntentAt",
        "dispatchAuditLogId", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, 'openai', 'gpt-5-6-luna',
        'prompt-refiner-openai-sdk-adapter-v1', 'dispatch_intent', $10, $11, $10, $10
      )
    `,
    input.id,
    input.runId,
    input.reservationId,
    input.requestId,
    `legacy-case-${input.caseIndex}`,
    input.caseIndex,
    input.stageId,
    input.reservationContractDigest,
    input.runContractDigest,
    input.createdAt,
    `${input.id}-dispatch-audit`
);

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
    process.env.RAILWAY_GIT_COMMIT_SHA = FIXTURE_COMMIT_SHA;
    process.env.RAILWAY_DEPLOYMENT_ID = FIXTURE_DEPLOYMENT_ID;
    await reset();
});

test("successor migration preserves exact legacy v1/v2/v3 manifests and rejects a re-digested tamper", async () => {
    const v1 = await legacyStageFixture(1);
    const v2 = await legacyStageFixture(2);
    const v3 = await legacyStageFixture(3);
    await prisma.$executeRawUnsafe(
        'ALTER TABLE "PromptRefinerReservationStage" DISABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
    );
    try {
        await insertLegacyStageFixture(v1);
        await insertLegacyStageFixture(v2);
        await insertLegacyStageFixture(v3);
        const preserved = await prisma.promptRefinerReservationStage.findMany({
            where: { id: { in: [v1.stageId, v2.stageId, v3.stageId] } },
            orderBy: { id: "asc" },
            select: { id: true, executionManifestDigest: true },
        });
        assert.deepEqual(preserved, [
            { id: v1.stageId, executionManifestDigest: v1.executionManifestDigest },
            { id: v2.stageId, executionManifestDigest: v2.executionManifestDigest },
            { id: v3.stageId, executionManifestDigest: v3.executionManifestDigest },
        ]);

        const tampered = structuredClone(v1.executionManifest);
        tampered.productAdapterReady = true;
        await assert.rejects(
            prisma.$executeRawUnsafe(
                `
                  UPDATE "PromptRefinerReservationStage"
                  SET "executionManifest" = $1::jsonb,
                      "executionManifestDigest" = $2
                  WHERE "id" = $3
                `,
                JSON.stringify(tampered),
                prefixedPromptRefinerDigest(tampered),
                v1.stageId
            ),
            /PromptRefinerReservationStage_execution_manifest_check/
        );
        assert.deepEqual(
            (
                await prisma.promptRefinerReservationStage.findUniqueOrThrow({
                    where: { id: v1.stageId },
                    select: { executionManifest: true },
                })
            ).executionManifest,
            v1.executionManifest
        );
    } finally {
        await prisma.$executeRawUnsafe(
            'ALTER TABLE "PromptRefinerReservationStage" ENABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
        );
    }
});

test("successor migration preserves exact legacy v3/v4/v5 runs and attempt pairs", async () => {
    const stageV1 = await legacyStageFixture(1);
    const stageV2 = await legacyStageFixture(2);
    const stageV3 = await legacyStageFixture(3);
    const runV3 = legacyRunFixture(3, stageV1);
    const runV4 = legacyRunFixture(4, stageV2);
    const runV5 = legacyRunFixture(5, stageV3);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "PromptRefinerReservationStage"
        DISABLE TRIGGER "prompt_refiner_stage_guard_trigger";
      ALTER TABLE "PromptRefinerReservation"
        DISABLE TRIGGER "prompt_refiner_reservation_insert_guard_trigger";
      ALTER TABLE "PromptRefinerReservation"
        DISABLE TRIGGER "prompt_refiner_reservation_account_insert_trigger";
      ALTER TABLE "PromptRefinerShadowRun"
        DISABLE TRIGGER "prompt_refiner_shadow_run_insert_guard_trigger";
      ALTER TABLE "PromptRefinerShadowAttempt"
        DISABLE TRIGGER "prompt_refiner_shadow_attempt_insert_guard_trigger";
    `);
    try {
        await insertLegacyStageFixture(stageV1);
        await insertLegacyStageFixture(stageV2);
        await insertLegacyStageFixture(stageV3);
        await insertLegacyRunFixture(runV3);
        await insertLegacyRunFixture(runV4);
        await insertLegacyRunFixture(runV5);
        assert.equal(await prisma.promptRefinerShadowRun.count(), 3);

        await assert.rejects(
            insertLegacyRunFixture({
                ...runV3,
                id: "legacy-shadow-run-tampered",
                runContractDigest: `sha256:${"f".repeat(64)}`,
                authorizationAuditLogId: "legacy-shadow-run-tampered-audit",
            }),
            /PromptRefinerShadowRun_contract_check/
        );

        await insertLegacyReservationFixture({
            id: "legacy-reservation-v3",
            stageId: stageV1.stageId,
            requestId: "legacy-request-v3",
            contractDigest: stageV1.contractDigest,
            createdAt: stageV1.approvedAt,
        });
        await insertLegacyReservationFixture({
            id: "legacy-reservation-v4",
            stageId: stageV2.stageId,
            requestId: "legacy-request-v4",
            contractDigest: stageV2.contractDigest,
            createdAt: stageV2.approvedAt,
        });
        await insertLegacyReservationFixture({
            id: "legacy-reservation-v5",
            stageId: stageV3.stageId,
            requestId: "legacy-request-v5",
            contractDigest: stageV3.contractDigest,
            createdAt: stageV3.approvedAt,
        });
        await insertLegacyReservationFixture({
            id: "legacy-reservation-tampered",
            stageId: stageV1.stageId,
            requestId: "legacy-request-tampered",
            contractDigest: stageV1.contractDigest,
            createdAt: stageV1.approvedAt,
        });
        await insertLegacyAttemptFixture({
            id: "legacy-attempt-v3",
            runId: runV3.id,
            reservationId: "legacy-reservation-v3",
            requestId: "legacy-request-v3",
            caseIndex: 0,
            stageId: stageV1.stageId,
            reservationContractDigest: stageV1.contractDigest,
            runContractDigest: runV3.runContractDigest,
            createdAt: stageV1.approvedAt,
        });
        await insertLegacyAttemptFixture({
            id: "legacy-attempt-v4",
            runId: runV4.id,
            reservationId: "legacy-reservation-v4",
            requestId: "legacy-request-v4",
            caseIndex: 1,
            stageId: stageV2.stageId,
            reservationContractDigest: stageV2.contractDigest,
            runContractDigest: runV4.runContractDigest,
            createdAt: stageV2.approvedAt,
        });
        await insertLegacyAttemptFixture({
            id: "legacy-attempt-v5",
            runId: runV5.id,
            reservationId: "legacy-reservation-v5",
            requestId: "legacy-request-v5",
            caseIndex: 2,
            stageId: stageV3.stageId,
            reservationContractDigest: stageV3.contractDigest,
            runContractDigest: runV5.runContractDigest,
            createdAt: stageV3.approvedAt,
        });
        assert.equal(await prisma.promptRefinerShadowAttempt.count(), 3);

        await assert.rejects(
            insertLegacyAttemptFixture({
                id: "legacy-attempt-tampered",
                runId: runV3.id,
                reservationId: "legacy-reservation-tampered",
                requestId: "legacy-request-tampered",
                caseIndex: 3,
                stageId: stageV1.stageId,
                reservationContractDigest: stageV2.contractDigest,
                runContractDigest: runV3.runContractDigest,
                createdAt: stageV1.approvedAt,
            }),
            /PromptRefinerShadowAttempt_binding_check/
        );
    } finally {
        await prisma.$executeRawUnsafe(`
          ALTER TABLE "PromptRefinerShadowAttempt"
            ENABLE TRIGGER "prompt_refiner_shadow_attempt_insert_guard_trigger";
          ALTER TABLE "PromptRefinerShadowRun"
            ENABLE TRIGGER "prompt_refiner_shadow_run_insert_guard_trigger";
          ALTER TABLE "PromptRefinerReservation"
            ENABLE TRIGGER "prompt_refiner_reservation_account_insert_trigger";
          ALTER TABLE "PromptRefinerReservation"
            ENABLE TRIGGER "prompt_refiner_reservation_insert_guard_trigger";
          ALTER TABLE "PromptRefinerReservationStage"
            ENABLE TRIGGER "prompt_refiner_stage_guard_trigger";
        `);
    }
});

test("current v5 runtime manifest missing or JSON-null keys fail at the actual insert constraint", async () => {
    const data = await stageCreateData();
    const manifest = structuredClone(data.runtimeSourceManifest) as Record<string, unknown>;
    const mutations = [
        ["schemaVersion", "missing"],
        ["schemaVersion", "null"],
        ["commitSha", "missing"],
        ["commitSha", "null"],
        ["files", "missing"],
        ["files", "null"],
        ["totalSizeBytes", "missing"],
        ["totalSizeBytes", "null"],
    ] as const;
    await prisma.$executeRawUnsafe(
        'ALTER TABLE "PromptRefinerReservationStage" DISABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
    );
    try {
        for (const [key, mode] of mutations) {
            const candidate = structuredClone(manifest);
            if (mode === "missing") delete candidate[key];
            else candidate[key] = null;
            await assert.rejects(
                prisma.promptRefinerReservationStage.create({
                    data: {
                        ...data,
                        runtimeSourceManifest: candidate as Prisma.InputJsonValue,
                        runtimeSourceManifestDigest: prefixedPromptRefinerDigest(candidate),
                    },
                }),
                /PromptRefinerReservationStage_runtime_identity_check/,
                `${key}:${mode}`
            );
            assert.equal(await prisma.promptRefinerReservationStage.count(), 0);
        }
    } finally {
        await prisma.$executeRawUnsafe(
            'ALTER TABLE "PromptRefinerReservationStage" ENABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
        );
    }
});

test("current v5 successor-only manifest mutations fail at the actual insert constraint", async () => {
    const data = await stageCreateData();
    const manifest = data.runtimeSourceManifest as unknown as {
        schemaVersion: string;
        files: Array<Record<string, unknown>>;
        [key: string]: unknown;
    };
    assert.equal(data.id, "prompt-refiner-shadow-v4");
    assert.equal(manifest.schemaVersion, "prompt-refiner-runtime-source-manifest-v5");
    assert.equal(manifest.files.length, 190);
    assert.equal(
        manifest.files[8]!.path,
        "prisma/migrations/20260928130000_prompt_refiner_confirmatory_successor_v4/migration.sql"
    );
    const mutations: Array<{
        name: string;
        changesSourceIdentity: boolean;
        mutate: (candidate: typeof manifest) => void;
    }> = [
        {
            name: "files[8]:wrong-path",
            changesSourceIdentity: true,
            mutate: (candidate) => {
                candidate.files[8]!.path = "lib/x.ts";
                assert.equal(candidate.files[8]!.path, "lib/x.ts");
            },
        },
        {
            name: "files[8]:extra-key",
            changesSourceIdentity: true,
            mutate: (candidate) => {
                candidate.files[8]!.extra = 1;
                assert.equal(candidate.files[8]!.extra, 1);
            },
        },
        {
            name: "files[8]:string-sizeBytes",
            changesSourceIdentity: true,
            mutate: (candidate) => {
                candidate.files[8]!.sizeBytes = String(candidate.files[8]!.sizeBytes);
                assert.equal(candidate.files[8]!.sizeBytes, String(manifest.files[8]!.sizeBytes));
            },
        },
        {
            name: "files[8]:uppercase-sha256",
            changesSourceIdentity: true,
            mutate: (candidate) => {
                candidate.files[8]!.sha256 = "A".repeat(64);
                assert.equal(candidate.files[8]!.sha256, "A".repeat(64));
            },
        },
        {
            name: "manifest:extra-key",
            changesSourceIdentity: false,
            mutate: (candidate) => {
                candidate.extra = 1;
                assert.equal(candidate.extra, 1);
            },
        },
        {
            name: "manifest:string-totalSizeBytes",
            changesSourceIdentity: false,
            mutate: (candidate) => {
                candidate.totalSizeBytes = String(candidate.totalSizeBytes);
                assert.equal(candidate.totalSizeBytes, String(manifest.totalSizeBytes));
            },
        },
    ];
    assert.equal(mutations.length, 6);
    await prisma.$executeRawUnsafe(
        'ALTER TABLE "PromptRefinerReservationStage" DISABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
    );
    try {
        const [disabled] = await prisma.$queryRaw<Array<{ enabled: string }>>`
            SELECT "tgenabled"::text AS "enabled" FROM pg_trigger
            WHERE "tgrelid" = '"PromptRefinerReservationStage"'::regclass
              AND "tgname" = 'prompt_refiner_stage_guard_trigger'
        `;
        assert.equal(disabled?.enabled, "D");
        for (const { name, changesSourceIdentity, mutate } of mutations) {
            const candidate = {
                ...data,
                runtimeSourceManifest: structuredClone(data.runtimeSourceManifest),
            };
            mutate(candidate.runtimeSourceManifest as unknown as typeof manifest);
            recomputeRuntimeManifestDigests(candidate);
            const candidateManifest = candidate.runtimeSourceManifest as unknown as typeof manifest;
            const candidateSourceIdentity = { files: candidateManifest.files };
            const [databaseParity] = await prisma.$queryRawUnsafe<Array<{
                manifestCanonicalJson: string;
                manifestDigest: string;
                sourceIdentityCanonicalJson: string;
                sourceIdentityDigest: string;
            }>>(
                `SELECT
                    "prompt_refiner_canonical_json"($1::jsonb) AS "manifestCanonicalJson",
                    "prompt_refiner_sha256_json"($1::jsonb) AS "manifestDigest",
                    "prompt_refiner_canonical_json"($2::jsonb) AS "sourceIdentityCanonicalJson",
                    "prompt_refiner_sha256_json"($2::jsonb) AS "sourceIdentityDigest"`,
                JSON.stringify(candidateManifest),
                JSON.stringify(candidateSourceIdentity)
            );
            assert.equal(
                databaseParity?.manifestCanonicalJson,
                canonicalBenchmarkJson(candidateManifest),
                `${name}:manifest-canonical-json`
            );
            assert.equal(
                databaseParity?.manifestDigest,
                candidate.runtimeSourceManifestDigest,
                `${name}:manifest-digest`
            );
            assert.equal(
                databaseParity?.sourceIdentityCanonicalJson,
                canonicalBenchmarkJson(candidateSourceIdentity),
                `${name}:source-identity-canonical-json`
            );
            assert.equal(
                databaseParity?.sourceIdentityDigest,
                candidate.runtimeSourceIdentityDigest,
                `${name}:source-identity-digest`
            );
            assert.equal(
                candidate.runtimeSourceIdentityDigest !== data.runtimeSourceIdentityDigest,
                changesSourceIdentity,
                name
            );
            assert.notEqual(candidate.runtimeSourceManifestDigest, data.runtimeSourceManifestDigest, name);
            await assert.rejects(
                prisma.promptRefinerReservationStage.create({ data: candidate }),
                /PromptRefinerReservationStage_runtime_identity_check/,
                name
            );
            assert.equal(await prisma.promptRefinerReservationStage.count(), 0, name);
        }
        const inserted = await prisma.promptRefinerReservationStage.create({ data });
        assert.equal(inserted.id, "prompt-refiner-shadow-v4");
        assert.deepEqual(inserted.runtimeSourceManifest, data.runtimeSourceManifest);
        assert.equal(await prisma.promptRefinerReservationStage.count(), 1);
    } finally {
        await prisma.$executeRawUnsafe(
            'ALTER TABLE "PromptRefinerReservationStage" ENABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
        );
    }
    const [restored] = await prisma.$queryRaw<Array<{ enabled: string }>>`
        SELECT "tgenabled"::text AS "enabled" FROM pg_trigger
        WHERE "tgrelid" = '"PromptRefinerReservationStage"'::regclass
          AND "tgname" = 'prompt_refiner_stage_guard_trigger'
    `;
    assert.equal(restored?.enabled, "O");
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
            data: await stageCreateData({
                reservationCount: 1,
                allocatedCostMicroUsd: BigInt(24_916),
            }),
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
    const second = await reservePromptRefinerExecution({ requestId: "request_same" });
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

test("an active requestId replay is refused after the stage approval expires", async () => {
    await createStage();
    const first = await reservePromptRefinerExecution({ requestId: "request_expired_replay" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await prisma.$executeRawUnsafe(
        'ALTER TABLE "PromptRefinerReservationStage" DISABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
    );
    try {
        await prisma.$executeRaw`
            UPDATE "PromptRefinerReservationStage"
            SET "approvedAt" = "approvedAt" - INTERVAL '2 hours',
                "approvalExpiresAt" = "approvalExpiresAt" - INTERVAL '2 hours'
            WHERE "id" = ${PROMPT_REFINER_RESERVATION_STAGE_ID}
        `;
    } finally {
        await prisma.$executeRawUnsafe(
            'ALTER TABLE "PromptRefinerReservationStage" ENABLE TRIGGER "prompt_refiner_stage_guard_trigger"'
        );
    }
    const replay = await reservePromptRefinerExecution({ requestId: "request_expired_replay" });
    assert.equal(replay.ok, false);
    assert.equal(await prisma.promptRefinerReservation.count(), 1);
});

test("an active requestId replay is refused after deployment or source identity drift", async () => {
    await createStage();
    const first = await reservePromptRefinerExecution({ requestId: "request_source_drift_replay" });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    process.env.RAILWAY_DEPLOYMENT_ID = "different-deployment";
    const deploymentReplay = await reservePromptRefinerExecution({
        requestId: "request_source_drift_replay",
    });
    assert.deepEqual(deploymentReplay, { ok: false, reason: "stage_contract_mismatch" });

    process.env.RAILWAY_DEPLOYMENT_ID = FIXTURE_DEPLOYMENT_ID;
    process.env.RAILWAY_GIT_COMMIT_SHA = "c".repeat(40);
    const sourceReplay = await reservePromptRefinerExecution({
        requestId: "request_source_drift_replay",
    });
    assert.deepEqual(sourceReplay, { ok: false, reason: "stage_contract_mismatch" });
    assert.equal(await prisma.promptRefinerReservation.count(), 1);
});

test("an active requestId replay is refused after model pricing drift", async () => {
    await createStage();
    const first = await reservePromptRefinerExecution({ requestId: "request_pricing_drift_replay" });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    process.env[INPUT_PRICE_ENV] = "99";
    const replay = await reservePromptRefinerExecution({ requestId: "request_pricing_drift_replay" });
    assert.deepEqual(replay, { ok: false, reason: "runtime_contract_mismatch" });
    assert.equal(await prisma.promptRefinerReservation.count(), 1);
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
    assert.deepEqual(consumed, { ok: false, reason: "dispatch_intent_required" });
    assert.equal(
        (
            await prisma.promptRefinerReservation.findUniqueOrThrow({
                where: { id: firstId },
            })
        ).status,
        "reserved"
    );

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

test("standalone consume requires the four-part binding and refuses without a dispatch intent", async () => {
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
    assert.deepEqual(outcomes, [
        { ok: false, reason: "dispatch_intent_required" },
        { ok: false, reason: "dispatch_intent_required" },
    ]);
    const row = await prisma.promptRefinerReservation.findUniqueOrThrow({
        where: { id: binding.reservationId },
    });
    assert.equal(row.status, "reserved");
    assert.equal(row.consumedAt, null);
});

test("the database owns terminal clocks and turns every late direct transition into expiry", async () => {
    await createStage();
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const nearExpiryCreatedAt = new Date(clock!.now.getTime() - 298_800);
    await prisma.promptRefinerReservation.createMany({
        data: ["late_release_one", "late_release_two"].map((requestId) => ({
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
        await prisma.$executeRaw`
            UPDATE "PromptRefinerReservation"
            SET "status" = 'released'
            WHERE "id" = 'late_release_one'
        `;
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
        WHERE "id" = 'late_release_two'
    `;
    const lateRows = await prisma.promptRefinerReservation.findMany({
        where: { id: { in: ["late_release_one", "late_release_two"] } },
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
        SET "status" = 'released'
        WHERE "id" = ${active.value.reservation.reservationId}
    `;
    const after = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
    `;
    const released = await prisma.promptRefinerReservation.findUniqueOrThrow({
        where: { id: active.value.reservation.reservationId },
    });
    assert.equal(released.status, "released");
    assert.ok(released.releasedAt);
    assert.ok(released.releasedAt.getTime() >= before[0]!.now.getTime());
    assert.ok(released.releasedAt.getTime() <= after[0]!.now.getTime());
    assert.equal(released.consumedAt, null);
    assert.equal(released.expiredAt, null);
});

test("naive reservation timestamps remain UTC under non-UTC database sessions", async () => {
    await createStage();
    const [databaseZone] = await prisma.$queryRaw<Array<{ zone: string }>>`
        SELECT current_setting('TimeZone') AS "zone"
    `;
    for (const [zone, suffix] of [
        ["America/New_York", "new_york"],
        ["Asia/Seoul", "seoul"],
    ] as const) {
        await assert.rejects(
            prisma.$transaction(async (tx) => {
                await tx.$queryRaw`
                    SELECT set_config('TimeZone', ${zone}, true)
                `;
                const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
                    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
                `;
                const exactId = `timezone_exact_${suffix}`;
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

                const lateId = `timezone_late_${suffix}`;
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
                    SET "status" = 'released'
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
    assert.deepEqual(
        await consumePromptRefinerReservation(bindingOf(reserved.value.reservation)),
        { ok: false, reason: "dispatch_intent_required" }
    );
    assert.equal(
        (
            await prisma.promptRefinerReservation.findUniqueOrThrow({
                where: { id: reserved.value.reservation.reservationId },
            })
        ).status,
        "reserved"
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
    assert.deepEqual(await consumePromise, {
        ok: false,
        reason: "dispatch_intent_required",
    });
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
    const wrongPath = await stageCreateData();
    wrongPath.runtimeSourceManifest = structuredClone(wrongPath.runtimeSourceManifest) as typeof wrongPath.runtimeSourceManifest;
    (wrongPath.runtimeSourceManifest as unknown as { files: Array<{ path: string }> }).files[0]!.path = "lib/not-allowed.ts";
    recomputeRuntimeManifestDigests(wrongPath);
    await rebindStageAudit(wrongPath);
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({ data: wrongPath }),
        /runtime_identity_check|check constraint/i
    );

    const extraEntryKey = await stageCreateData();
    extraEntryKey.runtimeSourceManifest = structuredClone(extraEntryKey.runtimeSourceManifest) as typeof extraEntryKey.runtimeSourceManifest;
    (extraEntryKey.runtimeSourceManifest as unknown as { files: Array<Record<string, unknown>> }).files[0]!.unexpected = true;
    recomputeRuntimeManifestDigests(extraEntryKey);
    await rebindStageAudit(extraEntryKey);
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({ data: extraEntryKey }),
        /runtime_identity_check|check constraint/i
    );

    const malformedHash = await stageCreateData();
    malformedHash.runtimeSourceManifest = structuredClone(malformedHash.runtimeSourceManifest) as typeof malformedHash.runtimeSourceManifest;
    (malformedHash.runtimeSourceManifest as unknown as { files: Array<{ sha256: string }> }).files[0]!.sha256 = "A".repeat(64);
    recomputeRuntimeManifestDigests(malformedHash);
    await rebindStageAudit(malformedHash);
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({ data: malformedHash }),
        /runtime_identity_check|check constraint/i
    );

    const oversizedEntry = await stageCreateData();
    oversizedEntry.runtimeSourceManifest = structuredClone(oversizedEntry.runtimeSourceManifest) as typeof oversizedEntry.runtimeSourceManifest;
    (oversizedEntry.runtimeSourceManifest as unknown as { files: Array<{ sizeBytes: number }> }).files[0]!.sizeBytes = 8 * 1024 * 1024 + 1;
    recomputeRuntimeManifestDigests(oversizedEntry);
    await rebindStageAudit(oversizedEntry);
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({ data: oversizedEntry }),
        /runtime_identity_check|check constraint/i
    );

    const oversizedClosure = await stageCreateData();
    oversizedClosure.runtimeSourceManifest = structuredClone(oversizedClosure.runtimeSourceManifest) as typeof oversizedClosure.runtimeSourceManifest;
    const oversizedClosureManifest = oversizedClosure.runtimeSourceManifest as unknown as {
        totalSizeBytes: number;
        files: Array<{ sizeBytes: number }>;
    };
    for (const index of [0, 1, 2]) {
        oversizedClosureManifest.files[index]!.sizeBytes = 6 * 1024 * 1024;
    }
    oversizedClosureManifest.totalSizeBytes = oversizedClosureManifest.files.reduce(
        (total, entry) => total + entry.sizeBytes,
        0
    );
    recomputeRuntimeManifestDigests(oversizedClosure);
    await rebindStageAudit(oversizedClosure);
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({ data: oversizedClosure }),
        /runtime_identity_check|check constraint/i
    );

    const executionSourcePolicyDrift = await stageCreateData();
    executionSourcePolicyDrift.executionManifest = structuredClone(executionSourcePolicyDrift.executionManifest) as typeof executionSourcePolicyDrift.executionManifest;
    (executionSourcePolicyDrift.executionManifest as unknown as {
        runtimeSource: { maxTotalBytes: number };
    }).runtimeSource.maxTotalBytes += 1;
    executionSourcePolicyDrift.executionManifestDigest = prefixedPromptRefinerDigest(
        executionSourcePolicyDrift.executionManifest
    );
    await rebindStageAudit(executionSourcePolicyDrift);
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({ data: executionSourcePolicyDrift }),
        /execution_manifest_check|check constraint/i
    );

    const auditMismatch = await stageCreateData();
    auditMismatch.runtimeDeploymentId = "other-valid-deployment";
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({ data: auditMismatch }),
        /authorization audit binding is invalid/i
    );

    const actorMismatch = await stageCreateData();
    actorMismatch.approvedBy = "another-actor";
    await assert.rejects(
        prisma.promptRefinerReservationStage.create({ data: actorMismatch }),
        /authorization audit binding is invalid/i
    );

    await assert.rejects(
        prisma.promptRefinerReservationStage.create({
            data: await stageCreateData({ id: "another_stage" }),
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
    assert.deepEqual(consumed, { ok: false, reason: "dispatch_intent_required" });
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
