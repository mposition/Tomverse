import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import corpusJson from "@/docs/ops/prompt-refiner-shadow/corpus-v1.json";
import evidenceSpecJson from "@/docs/ops/prompt-refiner-shadow/evidence-spec-v1.json";

import { prisma } from "@/lib/prisma";
import {
    consumePromptRefinerReservation,
    reservePromptRefinerExecution,
} from "@/lib/promptRefinerReservationAuthority";
import {
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
} from "@/lib/promptRefinerReservationCore";
import {
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
    PROMPT_REFINER_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_RETRY_COUNT,
    PROMPT_REFINER_TIMEOUT_MS,
} from "@/lib/promptRefinerExecutionContract";
import {
    createPromptRefinerReservationStage,
    promptRefinerStagePreview,
} from "@/lib/promptRefinerStageAdmission";
import {
    PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
    PROMPT_REFINER_SHADOW_CASE_IDS,
    PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG,
    PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
    PROMPT_REFINER_SHADOW_RUN_ID,
    PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
    PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
    PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
} from "@/lib/promptRefinerShadowRunContract";
import {
    evaluatePromptRefinerShadowCaseEvidence,
    validatePromptRefinerShadowEvidenceSpec,
} from "@/lib/promptRefinerShadowEvidenceCore";
import { validatePromptRefinerShadowCorpus } from "@/lib/promptRefinerShadowHarness";
import {
    createPromptRefinerShadowRun,
    promptRefinerShadowRunPreview,
    readPromptRefinerShadowEvidenceBundle,
    readPromptRefinerShadowExecutionState,
    recordPromptRefinerShadowDispatchIntent,
    recordPromptRefinerShadowTerminal,
    sweepPromptRefinerShadowUnknowns,
} from "@/lib/promptRefinerShadowRunStore";
import { staticModelRegistrySeedRows } from "@/lib/modelRegistryShared";

const FIXTURE_COMMIT_SHA = "a".repeat(40);
const FIXTURE_DEPLOYMENT_ID = "prompt-refiner-shadow-run-db-test";
process.env.RAILWAY_ENVIRONMENT_NAME = "staging";
process.env.RAILWAY_GIT_COMMIT_SHA = FIXTURE_COMMIT_SHA;
process.env.RAILWAY_DEPLOYMENT_ID = FIXTURE_DEPLOYMENT_ID;
process.env.ADMIN_AUDIT_INTEGRITY_KEY =
    "prompt-refiner-shadow-run-strong-fixture-key";
process.env[PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG] = "true";

const fixtureSession = {
    user: { id: "mposition", email: "owner@example.com" },
} as Session;
const fixtureRequest = new Request(
    "http://127.0.0.1:3100/api/admin/prompt-refiner/shadow-run",
    { headers: { "user-agent": "prompt-refiner-shadow-run-db-integration" } }
);

const reset = async () => {
    await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE
          "PromptRefinerShadowAttempt",
          "PromptRefinerShadowRun",
          "PromptRefinerReservation",
          "PromptRefinerReservationStage",
          "AdminAuditLog"
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

const approveStage = async () => {
    const preview = await promptRefinerStagePreview();
    return createPromptRefinerReservationStage({
        session: fixtureSession,
        request: fixtureRequest,
        expected: {
            proposalDigest: preview.proposalDigest,
            runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
            executionManifestDigest: preview.executionManifestDigest,
            previewBindingDigest: preview.previewBindingDigest,
        },
    });
};

const approveRun = async () => {
    const preview = await promptRefinerShadowRunPreview();
    return createPromptRefinerShadowRun({
        session: fixtureSession,
        request: fixtureRequest,
        expected: {
            runContractDigest: preview.runContractDigest,
            stageRuntimeSourceManifestDigest:
                preview.stageRuntimeSourceManifestDigest,
            runSourceManifestDigest: preview.runSourceManifestDigest,
            previewBindingDigest: preview.previewBindingDigest,
        },
    });
};

const reserve = async (requestId: string) => {
    const result = await reservePromptRefinerExecution({ requestId });
    assert.equal(result.ok, true, result.ok ? undefined : result.reason);
    if (!result.ok) throw new Error("reservation fixture failed");
    return result.value.reservation;
};

const dispatch = async (input: {
    requestId: string;
    caseIndex: number;
}) => {
    const reservation = await reserve(input.requestId);
    const result = await recordPromptRefinerShadowDispatchIntent({
        runId: PROMPT_REFINER_SHADOW_RUN_ID,
        caseId: PROMPT_REFINER_SHADOW_CASE_IDS[input.caseIndex]!,
        caseIndex: input.caseIndex,
        reservation: {
            reservationId: reservation.reservationId,
            requestId: reservation.requestId,
            stageId: reservation.stageId,
            contractDigest: reservation.contractDigest,
        },
        fact: {
            requestId: reservation.requestId,
            adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
            provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
            modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
            apiModelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId,
            maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
            timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
            retryCount: PROMPT_REFINER_RETRY_COUNT,
            tokenizerPackage: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
            tokenizerPackageVersion:
                PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
            tokenizerEncoding: PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
            admissionInputTokens: 100,
        },
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("dispatch fixture failed");
    return { reservation, attempt: result.attempt };
};

const usage = (costUpperBoundMicroUsd: number | null = 44) => ({
    inputTokens: costUpperBoundMicroUsd === null ? null : 100,
    cachedInputTokens: costUpperBoundMicroUsd === null ? null : 0,
    cacheWriteInputTokens: costUpperBoundMicroUsd === null ? null : 0,
    outputTokens: costUpperBoundMicroUsd === null ? null : 20,
    reasoningTokens: costUpperBoundMicroUsd === null ? null : 8,
    costUpperBoundMicroUsd,
});

const corpus = validatePromptRefinerShadowCorpus(corpusJson);
const evidenceSpec = validatePromptRefinerShadowEvidenceSpec(evidenceSpecJson);
const evidenceFor = (
    caseIndex: number,
    terminalStatus: "suggested" | "failed" | "unknown"
) =>
    evaluatePromptRefinerShadowCaseEvidence({
        corpus,
        spec: evidenceSpec,
        caseIndex,
        terminalStatus,
        refinedPrompt:
            terminalStatus === "suggested"
                ? `${corpus.cases[caseIndex]!.sourceText} refined`
                : null,
    });

before(async () => {
    await ensureRuntimeModel();
});

beforeEach(async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = FIXTURE_COMMIT_SHA;
    process.env.RAILWAY_DEPLOYMENT_ID = FIXTURE_DEPLOYMENT_ID;
    process.env[PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG] = "true";
    await reset();
});

test("run approval is default-off and writes no run or audit when disabled", async () => {
    await approveStage();
    const before = await prisma.adminAuditLog.count();
    delete process.env[PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG];
    const preview = await promptRefinerShadowRunPreview();
    assert.equal(preview.approvalEnabled, false);
    await assert.rejects(
        approveRun(),
        (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "PROMPT_REFINER_SHADOW_RUN_APPROVAL_DISABLED"
    );
    assert.equal(await prisma.promptRefinerShadowRun.count(), 0);
    assert.equal(await prisma.adminAuditLog.count(), before);
});

test("exact preview approval is create-once, signed and content-free", async () => {
    await approveStage();
    const first = await approveRun();
    assert.equal(first.created, true);
    assert.equal(first.run.id, PROMPT_REFINER_SHADOW_RUN_ID);
    assert.equal(first.run.runContractDigest, PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST);
    assert.equal(first.run.dispatchCount, 0);
    const replay = await approveRun();
    assert.equal(replay.created, false);
    assert.equal(replay.replayed, true);
    assert.equal(await prisma.promptRefinerShadowRun.count(), 1);
    const audit = await prisma.adminAuditLog.findUniqueOrThrow({
        where: { id: first.run.authorizationAuditLogId },
    });
    assert.ok(audit.entryHash);
    assert.equal(audit.action, "prompt_refiner.shadow_run.approved");
    const serialized = JSON.stringify(
        { run: first.run, audit },
        (_key, value) => (typeof value === "bigint" ? value.toString() : value)
    );
    assert.doesNotMatch(serialized, /sourceText|refinedPrompt|responseBody|credential/i);
});

test("dispatch intent, reservation consume, audit and run accounting commit atomically", async () => {
    await approveStage();
    await approveRun();
    const result = await dispatch({ requestId: "shadow_db_dispatch_1", caseIndex: 0 });
    const [reservation, run, audit] = await Promise.all([
        prisma.promptRefinerReservation.findUniqueOrThrow({
            where: { id: result.reservation.reservationId },
        }),
        prisma.promptRefinerShadowRun.findUniqueOrThrow({
            where: { id: PROMPT_REFINER_SHADOW_RUN_ID },
        }),
        prisma.adminAuditLog.findUniqueOrThrow({
            where: { id: result.attempt.dispatchAuditLogId },
        }),
    ]);
    assert.equal(reservation.status, "consumed");
    assert.ok(reservation.consumedAt);
    assert.equal(run.status, "running");
    assert.equal(run.dispatchCount, 1);
    assert.equal(run.terminalCount, 0);
    assert.equal(audit.action, "prompt_refiner.shadow_dispatch.intent_recorded");
    const metadata = audit.metadata as Record<string, unknown>;
    assert.equal(metadata.systemActor, "prompt-refiner-shadow-runner");
    assert.equal(metadata.tokenizerPackage, PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE);
    assert.equal(
        metadata.tokenizerPackageVersion,
        PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION
    );
    assert.equal(metadata.tokenizerEncoding, PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING);
    assert.equal(metadata.admissionInputTokens, 100);
    const state = await readPromptRefinerShadowExecutionState();
    assert.equal(state.dispatchCount, 1);
    assert.equal(state.terminalCount, 0);
    assert.equal(state.nextCaseIndex, null);
    assert.equal(state.inFlightAttemptId, result.attempt.id);
});

test("an injected attempt failure rolls audit, attempt, consume and run counter back", async () => {
    await approveStage();
    await approveRun();
    const reservation = await reserve("shadow_db_rollback_1");
    await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION "prompt_refiner_test_fail_attempt"()
        RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'injected attempt failure'; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER "prompt_refiner_test_fail_attempt_trigger"
        BEFORE INSERT ON "PromptRefinerShadowAttempt"
        FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_test_fail_attempt"();
    `);
    try {
        await assert.rejects(
            recordPromptRefinerShadowDispatchIntent({
                runId: PROMPT_REFINER_SHADOW_RUN_ID,
                caseId: PROMPT_REFINER_SHADOW_CASE_IDS[0],
                caseIndex: 0,
                reservation: {
                    reservationId: reservation.reservationId,
                    requestId: reservation.requestId,
                    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
                    contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
                },
                fact: {
                    requestId: reservation.requestId,
                    adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
                    provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
                    modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
                    apiModelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId,
                    maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
                    timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
                    retryCount: 0,
                    tokenizerPackage: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
                    tokenizerPackageVersion:
                        PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
                    tokenizerEncoding: PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
                    admissionInputTokens: 100,
                },
            }),
            /injected attempt failure/
        );
    } finally {
        await prisma.$executeRawUnsafe(`
            DROP TRIGGER IF EXISTS "prompt_refiner_test_fail_attempt_trigger" ON "PromptRefinerShadowAttempt";
            DROP FUNCTION IF EXISTS "prompt_refiner_test_fail_attempt"();
        `);
    }
    assert.equal(await prisma.promptRefinerShadowAttempt.count(), 0);
    assert.equal(
        (
            await prisma.promptRefinerReservation.findUniqueOrThrow({
                where: { id: reservation.reservationId },
            })
        ).status,
        "reserved"
    );
    const run = await prisma.promptRefinerShadowRun.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_SHADOW_RUN_ID },
    });
    assert.equal(run.dispatchCount, 0);
    assert.equal(
        await prisma.adminAuditLog.count({
            where: { action: "prompt_refiner.shadow_dispatch.intent_recorded" },
        }),
        0
    );
});

test("terminal receipt is immutable, idempotent only when exact, and updates cost", async () => {
    await approveStage();
    await approveRun();
    const { attempt } = await dispatch({ requestId: "shadow_db_terminal_1", caseIndex: 0 });
    await assert.rejects(
        recordPromptRefinerShadowTerminal({
            attemptId: attempt.id,
            terminalReason: "suggested",
            durationMs: 12,
            usage: usage(44),
            evidence: {
                ...evidenceFor(0, "suggested"),
                sourceText: corpus.cases[0]!.sourceText,
            },
        }),
        (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "PROMPT_REFINER_SHADOW_EVIDENCE_INVALID"
    );
    assert.equal(
        await prisma.adminAuditLog.count({
            where: { action: "prompt_refiner.shadow_dispatch.terminal_recorded" },
        }),
        0
    );
    assert.equal(
        (
            await prisma.promptRefinerShadowAttempt.findUniqueOrThrow({
                where: { id: attempt.id },
            })
        ).status,
        "dispatch_intent"
    );
    const first = await recordPromptRefinerShadowTerminal({
        attemptId: attempt.id,
        terminalReason: "suggested",
        durationMs: 12,
        usage: usage(44),
        evidence: evidenceFor(0, "suggested"),
    });
    assert.equal(first.created, true);
    assert.equal(first.attempt.status, "terminal");
    assert.ok(first.attempt.terminalAt);
    assert.equal(first.run.terminalCount, 1);
    assert.equal(first.run.knownActualCostMicroUsd, BigInt(44));
    const replay = await recordPromptRefinerShadowTerminal({
        attemptId: attempt.id,
        terminalReason: "suggested",
        durationMs: 12,
        usage: usage(44),
        evidence: evidenceFor(0, "suggested"),
    });
    assert.equal(replay.replayed, true);
    await assert.rejects(
        recordPromptRefinerShadowTerminal({
            attemptId: attempt.id,
            terminalReason: "provider_error",
            durationMs: 12,
            usage: usage(null),
            evidence: evidenceFor(0, "failed"),
        }),
        (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "PROMPT_REFINER_SHADOW_TERMINAL_CONFLICT"
    );
    assert.equal(
        await prisma.adminAuditLog.count({
            where: { action: "prompt_refiner.shadow_dispatch.terminal_recorded" },
        }),
        1
    );
});

test("completed durable evidence rebuilds a content-free aggregate from all 16 cases", async () => {
    await approveStage();
    await approveRun();
    for (let caseIndex = 0; caseIndex < PROMPT_REFINER_SHADOW_CASE_IDS.length; caseIndex += 1) {
        const { attempt } = await dispatch({
            requestId: `shadow_db_evidence_${caseIndex}`,
            caseIndex,
        });
        await recordPromptRefinerShadowTerminal({
            attemptId: attempt.id,
            terminalReason: "provider_error",
            durationMs: 10 + caseIndex,
            usage: usage(null),
            evidence: evidenceFor(caseIndex, "failed"),
        });
    }

    const bundle = await readPromptRefinerShadowEvidenceBundle();
    assert.ok(bundle);
    assert.equal(bundle.gateOutcome, "fail");
    assert.equal(bundle.summary.attemptedCases, 16);
    assert.equal(bundle.summary.suggestedCases, 0);
    assert.equal(bundle.summary.failedCases, 16);
    assert.equal(bundle.summary.unknownCases, 0);
    assert.equal(bundle.summary.costReportedCases, 0);
    assert.equal(bundle.summary.totalCostMicroUsd, null);
    assert.equal(bundle.summary.latencyReportedCases, 16);
    assert.equal(bundle.summary.latencyMaxMs, 25);
    assert.ok(bundle.gateReasons.includes("terminal_failure_present"));
    assert.ok(bundle.gateReasons.includes("cost_incomplete"));
    assert.equal(bundle.cases.length, 16);

    const [attempts, audits, run] = await Promise.all([
        prisma.promptRefinerShadowAttempt.findMany({
            where: { runId: PROMPT_REFINER_SHADOW_RUN_ID },
            orderBy: { caseIndex: "asc" },
        }),
        prisma.adminAuditLog.findMany({
            where: { action: "prompt_refiner.shadow_dispatch.terminal_recorded" },
            orderBy: { createdAt: "asc" },
        }),
        prisma.promptRefinerShadowRun.findUniqueOrThrow({
            where: { id: PROMPT_REFINER_SHADOW_RUN_ID },
        }),
    ]);
    assert.equal(run.status, "completed");
    assert.equal(run.terminalCount, 16);
    assert.equal(attempts.length, 16);
    assert.equal(audits.length, 16);
    for (const attempt of attempts) {
        assert.notEqual(attempt.evidence, null);
        const audit = audits.find((candidate) => candidate.targetId === attempt.id);
        assert.ok(audit);
        assert.deepEqual(
            (audit.metadata as { evidence: unknown }).evidence,
            attempt.evidence
        );
    }
    const serialized = JSON.stringify({ bundle, attempts, audits });
    assert.doesNotMatch(
        serialized,
        /sourceText|refinedPrompt|responseBody|credential/i
    );
});

test("unknown terminal latches the run and refuses every later case without redispatch", async () => {
    await approveStage();
    await approveRun();
    const { attempt } = await dispatch({ requestId: "shadow_db_unknown_1", caseIndex: 0 });
    const { attempt: secondAttempt } = await dispatch({
        requestId: "shadow_db_unknown_2",
        caseIndex: 1,
    });
    const terminal = await recordPromptRefinerShadowTerminal({
        attemptId: attempt.id,
        terminalReason: "unknown_after_dispatch",
        durationMs: 60_000,
        usage: usage(null),
        evidence: evidenceFor(0, "unknown"),
    });
    assert.equal(terminal.run.status, "stopped_unknown");
    assert.equal(terminal.run.stopReason, "unknown_after_dispatch");
    assert.ok(terminal.run.stoppedAt);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const catchUp = await recordPromptRefinerShadowTerminal({
        attemptId: secondAttempt.id,
        terminalReason: "suggested",
        durationMs: 12,
        usage: usage(44),
        evidence: evidenceFor(1, "suggested"),
    });
    assert.equal(catchUp.run.status, "stopped_unknown");
    assert.equal(catchUp.run.terminalCount, 2);
    assert.equal(catchUp.run.knownActualCostMicroUsd, BigInt(44));
    assert.equal(
        catchUp.run.stoppedAt?.toISOString(),
        terminal.run.stoppedAt?.toISOString()
    );
    const reservation = await reserve("shadow_db_unknown_3");
    await assert.rejects(
        recordPromptRefinerShadowDispatchIntent({
            runId: PROMPT_REFINER_SHADOW_RUN_ID,
            caseId: PROMPT_REFINER_SHADOW_CASE_IDS[2],
            caseIndex: 2,
            reservation: {
                reservationId: reservation.reservationId,
                requestId: reservation.requestId,
                stageId: reservation.stageId,
                contractDigest: reservation.contractDigest,
            },
            fact: {
                requestId: reservation.requestId,
                adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
                provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
                modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
                apiModelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId,
                maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
                timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
                retryCount: 0,
                tokenizerPackage: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
                tokenizerPackageVersion:
                    PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
                tokenizerEncoding: PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
                admissionInputTokens: 100,
            },
        }),
        (error: unknown) =>
            error instanceof Error &&
            "code" in error &&
            error.code === "PROMPT_REFINER_SHADOW_DISPATCH_RUN_INVALID"
    );
    assert.equal(
        (
            await prisma.promptRefinerReservation.findUniqueOrThrow({
                where: { id: reservation.reservationId },
            })
        ).status,
        "reserved"
    );
});

test("bounded sweep closes every selected stale intent after the first unknown latch", async () => {
    await approveStage();
    await approveRun();
    const { attempt: firstAttempt } = await dispatch({
        requestId: "shadow_db_sweep_1",
        caseIndex: 0,
    });
    const { attempt: secondAttempt } = await dispatch({
        requestId: "shadow_db_sweep_2",
        caseIndex: 1,
    });
    await prisma.$executeRawUnsafe(
        'ALTER TABLE "PromptRefinerShadowAttempt" DISABLE TRIGGER "prompt_refiner_shadow_attempt_guard_trigger"'
    );
    try {
        await prisma.$executeRaw`
            UPDATE "PromptRefinerShadowAttempt"
            SET "dispatchIntentAt" = (clock_timestamp() AT TIME ZONE 'UTC')
                - CASE WHEN "caseIndex" = 0 THEN INTERVAL '62 seconds'
                       ELSE INTERVAL '61 seconds' END
            WHERE "id" IN (${firstAttempt.id}, ${secondAttempt.id})
        `;
    } finally {
        await prisma.$executeRawUnsafe(
            'ALTER TABLE "PromptRefinerShadowAttempt" ENABLE TRIGGER "prompt_refiner_shadow_attempt_guard_trigger"'
        );
    }
    const sweep = await sweepPromptRefinerShadowUnknowns();
    assert.deepEqual(
        [...sweep.closedUnknownAttemptIds].sort(),
        [firstAttempt.id, secondAttempt.id].sort()
    );
    assert.deepEqual(sweep.unresolvedStaleAttemptIds, []);
    assert.equal(sweep.redispatched, 0);
    assert.equal(sweep.retryCount, 0);
    const run = await prisma.promptRefinerShadowRun.findUniqueOrThrow({
        where: { id: PROMPT_REFINER_SHADOW_RUN_ID },
    });
    assert.equal(run.status, "stopped_unknown");
    assert.equal(run.terminalCount, 2);
    assert.equal(run.stopReason, "unknown_after_dispatch");
    assert.ok(run.stoppedAt);
});

test("sweep reports a conflicting known receipt race without discarding prior closures", async () => {
    await approveStage();
    await approveRun();
    const { attempt: firstAttempt } = await dispatch({
        requestId: "shadow_db_race_1",
        caseIndex: 0,
    });
    const { attempt: secondAttempt } = await dispatch({
        requestId: "shadow_db_race_2",
        caseIndex: 1,
    });
    await prisma.$executeRawUnsafe(
        'ALTER TABLE "PromptRefinerShadowAttempt" DISABLE TRIGGER "prompt_refiner_shadow_attempt_guard_trigger"'
    );
    try {
        await prisma.$executeRaw`
            UPDATE "PromptRefinerShadowAttempt"
            SET "dispatchIntentAt" = (clock_timestamp() AT TIME ZONE 'UTC')
                - CASE WHEN "caseIndex" = 0 THEN INTERVAL '62 seconds'
                       ELSE INTERVAL '61 seconds' END
            WHERE "id" IN (${firstAttempt.id}, ${secondAttempt.id})
        `;
    } finally {
        await prisma.$executeRawUnsafe(
            'ALTER TABLE "PromptRefinerShadowAttempt" ENABLE TRIGGER "prompt_refiner_shadow_attempt_guard_trigger"'
        );
    }
    await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "prompt_refiner_test_delay_first_terminal"()
        RETURNS TRIGGER AS $$
        BEGIN
            IF OLD."caseIndex" = 0 THEN PERFORM pg_sleep(0.25); END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER "prompt_refiner_test_delay_first_terminal_trigger"
        BEFORE UPDATE ON "PromptRefinerShadowAttempt"
        FOR EACH ROW EXECUTE FUNCTION "prompt_refiner_test_delay_first_terminal"();
    `);
    let sweep: Awaited<ReturnType<typeof sweepPromptRefinerShadowUnknowns>>;
    try {
        const sweepPromise = sweepPromptRefinerShadowUnknowns();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const knownReceiptPromise = recordPromptRefinerShadowTerminal({
            attemptId: secondAttempt.id,
            terminalReason: "suggested",
            durationMs: 12,
            usage: usage(44),
            evidence: evidenceFor(1, "suggested"),
        });
        [sweep] = await Promise.all([sweepPromise, knownReceiptPromise]);
    } finally {
        await prisma.$executeRawUnsafe(`
            DROP TRIGGER IF EXISTS "prompt_refiner_test_delay_first_terminal_trigger"
                ON "PromptRefinerShadowAttempt";
            DROP FUNCTION IF EXISTS "prompt_refiner_test_delay_first_terminal"();
        `);
    }
    assert.deepEqual(sweep.closedUnknownAttemptIds, [firstAttempt.id]);
    assert.deepEqual(sweep.unresolvedStaleAttemptIds, [secondAttempt.id]);
    const second = await prisma.promptRefinerShadowAttempt.findUniqueOrThrow({
        where: { id: secondAttempt.id },
    });
    assert.equal(second.terminalReason, "suggested");
    assert.equal(second.actualCostMicroUsd, BigInt(44));
});

test("unknown sweep uses the PostgreSQL clock instead of a skewed application clock", async () => {
    await approveStage();
    await approveRun();
    await dispatch({ requestId: "shadow_db_clock_1", caseIndex: 0 });
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 120_000;
    try {
        const sweep = await sweepPromptRefinerShadowUnknowns();
        assert.equal(sweep.staleCandidates, 0);
        assert.deepEqual(sweep.closedUnknownAttemptIds, []);
        assert.deepEqual(sweep.unresolvedStaleAttemptIds, []);
        assert.ok(new Date(sweep.observedAt).getTime() < Date.now() - 60_000);
    } finally {
        Date.now = realDateNow;
    }
});

test("standalone consume and direct SQL cannot create consumed-without-intent", async () => {
    await approveStage();
    const reservation = await reserve("shadow_db_direct_consume_1");
    assert.deepEqual(
        await consumePromptRefinerReservation({
            reservationId: reservation.reservationId,
            requestId: reservation.requestId,
            stageId: reservation.stageId,
            contractDigest: reservation.contractDigest,
        }),
        { ok: false, reason: "dispatch_intent_required" }
    );
    await assert.rejects(
        prisma.$executeRaw`
            UPDATE "PromptRefinerReservation"
            SET "status" = 'consumed'
            WHERE "id" = ${reservation.reservationId}
        `,
        /consume requires one dispatch intent/i
    );
    assert.equal(
        (
            await prisma.promptRefinerReservation.findUniqueOrThrow({
                where: { id: reservation.reservationId },
            })
        ).status,
        "reserved"
    );
});
