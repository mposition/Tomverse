import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    PROMPT_REFINER_EXECUTION_CONTRACT,
    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
    PROMPT_REFINER_MAX_INPUT_TOKENS,
    PROMPT_REFINER_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_RETRY_COUNT,
    PROMPT_REFINER_TIMEOUT_MS,
    admitPromptRefinerExecution,
} from "../lib/promptRefinerExecutionContract.ts";
import {
    PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION,
    PROMPT_REFINER_RESERVATION_CONTRACT,
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    PROMPT_REFINER_RESERVATION_REFUSALS,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
    PROMPT_REFINER_RESERVATION_STAGE_IDS,
    PROMPT_REFINER_RESERVATION_STAGE_STATUSES,
    PROMPT_REFINER_RESERVATION_STATUSES,
    PROMPT_REFINER_RESERVATION_TTL_MS,
    promptRefinerReservationBindingMatches,
    promptRefinerReservationIdentifiersAreValid,
    promptRefinerReservationStageProblems,
} from "../lib/promptRefinerReservationCore.ts";
import { PROMPT_REFINER_VERSION } from "../lib/promptRefinerSuggestion.ts";

const validStage = (overrides = {}) => ({
    id: PROMPT_REFINER_RESERVATION_STAGE_ID,
    contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    status: "approved",
    perRequestCostMicroUsd: 24_916n,
    maxReservations: 100,
    costCeilingMicroUsd: 2_491_600n,
    reservationCount: 0,
    allocatedCostMicroUsd: 0n,
    approvedAt: new Date("2026-09-17T00:00:00.000Z"),
    approvalExpiresAt: new Date("2026-09-17T01:00:00.000Z"),
    ...overrides,
});

test("reservation contract freezes one bounded, content-free authority", () => {
    assert.equal(
        PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION,
        "prompt-refiner-reservation-authority-v2"
    );
    assert.equal(PROMPT_REFINER_RESERVATION_STAGE_ID, "prompt-refiner-shadow-v2");
    assert.deepEqual([...PROMPT_REFINER_RESERVATION_STAGE_IDS], [
        "prompt-refiner-shadow-v1",
        "prompt-refiner-shadow-v2",
    ]);
    assert.equal(PROMPT_REFINER_RESERVATION_TTL_MS, 300_000);
    assert.equal(PROMPT_REFINER_RESERVATION_CONTRACT.perRequestCostMicroUsd, 24_916);
    assert.equal(PROMPT_REFINER_RESERVATION_CONTRACT.maxReservations, 100);
    assert.equal(PROMPT_REFINER_RESERVATION_CONTRACT.costCeilingMicroUsd, 2_491_600);
    assert.equal(
        PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
        "sha256:6b60c957793effe904d82748d9f7353d6490d150eff66ba4a02f1aac63f376d1"
    );
    assert.deepEqual([...PROMPT_REFINER_RESERVATION_STAGE_STATUSES], [
        "approved",
        "closed",
    ]);
    assert.deepEqual(
        [...PROMPT_REFINER_RESERVATION_CONTRACT.stageStates],
        [...PROMPT_REFINER_RESERVATION_STAGE_STATUSES]
    );
    assert.deepEqual([...PROMPT_REFINER_RESERVATION_STATUSES], [
        "reserved",
        "consumed",
        "released",
        "expired",
    ]);
});

test("stage validation rejects every mutable bound and broken accounting", () => {
    assert.deepEqual(promptRefinerReservationStageProblems(validStage()), []);
    const cases = [
        ["id", "other", "stage_id_mismatch"],
        ["contractVersion", "other", "contract_version_mismatch"],
        ["contractDigest", "sha256:bad", "contract_digest_mismatch"],
        ["status", "closed", "stage_not_approved"],
        ["perRequestCostMicroUsd", 24_915n, "request_cost_mismatch"],
        ["maxReservations", 99, "reservation_limit_mismatch"],
        ["costCeilingMicroUsd", 2_491_599n, "stage_cost_mismatch"],
        ["reservationCount", 101, "reservation_count_invalid"],
        ["allocatedCostMicroUsd", 1n, "allocated_cost_invalid"],
        ["approvalExpiresAt", new Date("2026-09-17T00:59:59.999Z"), "approval_window_invalid"],
    ];
    for (const [field, value, expected] of cases) {
        assert.ok(
            promptRefinerReservationStageProblems(
                validStage({ [field]: value })
            ).includes(expected),
            field
        );
    }
    assert.deepEqual(
        promptRefinerReservationStageProblems(validStage({ status: "closed" }), {
            requireApproved: false,
        }),
        []
    );
});

test("request and reservation identifiers are bounded machine ids", () => {
    assert.equal(promptRefinerReservationIdentifiersAreValid({ requestId: "request_01:a-b" }), true);
    assert.equal(promptRefinerReservationIdentifiersAreValid({ requestId: "" }), false);
    assert.equal(promptRefinerReservationIdentifiersAreValid({ requestId: "x".repeat(129) }), false);
    assert.equal(promptRefinerReservationIdentifiersAreValid({ requestId: "prompt text" }), false);
    assert.equal(
        promptRefinerReservationIdentifiersAreValid({
            requestId: "request_1",
            reservationId: "reservation_1",
        }),
        true
    );
});

test("consume binding requires all four exact identities", () => {
    const binding = {
        reservationId: "reservation_1",
        requestId: "request_1",
        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    };
    assert.equal(promptRefinerReservationBindingMatches(binding, binding), true);
    for (const field of ["reservationId", "requestId", "stageId", "contractDigest"]) {
        assert.equal(
            promptRefinerReservationBindingMatches(binding, {
                ...binding,
                [field]: `${binding[field]}_other`,
            }),
            false,
            field
        );
    }
});

test("v1 admission remains fail-closed despite the standalone authority", () => {
    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.stage.reservationAuthority, "unavailable");
    assert.deepEqual(
        admitPromptRefinerExecution({
            mode: "shadow",
            eligible: true,
            stageApproved: true,
            adapterReady: true,
            contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
            refinerVersion: PROMPT_REFINER_VERSION,
            model: { ...PROMPT_REFINER_EXECUTION_MODEL_PIN },
            maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
            timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
            retryCount: PROMPT_REFINER_RETRY_COUNT,
            promptCaching: "disabled",
            tools: "none",
            inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS,
        }),
        { admitted: false, reason: "reservation_authority_unavailable" }
    );
});

test("authority source stores no prompt/content identity and calls no provider", () => {
    const source = readFileSync(
        new URL("../lib/promptRefinerReservationAuthority.ts", import.meta.url),
        "utf8"
    );
    for (const forbidden of [
        "sourceText",
        "executionPrompt",
        "conversationId",
        "userId",
        "providerError",
        "streamText(",
        "generateText(",
        "fetch(",
    ]) {
        assert.equal(source.includes(forbidden), false, forbidden);
    }

    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    // Keep this content-free authority check scoped to the two reservation
    // models. Later, unrelated models may legitimately store their own payloads.
    const reservationModelNames = [
        "PromptRefinerReservationStage",
        "PromptRefinerReservation",
    ];
    const tables = reservationModelNames
        .map((modelName) => {
            const start = schema.indexOf(`model ${modelName} {`);
            assert.notEqual(start, -1, `${modelName} must exist`);

            const end = schema.indexOf("\n}", start);
            assert.notEqual(end, -1, `${modelName} must close`);

            return schema.slice(start, end + 2);
        })
        .join("\n");
    for (const forbiddenColumn of [
        "prompt ",
        "content ",
        "userId ",
        "conversationId ",
        "providerError ",
    ]) {
        assert.equal(tables.includes(forbiddenColumn), false, forbiddenColumn);
    }

    const producers = new Set(
        [...source.matchAll(/refuse\("([a-z_]+)"\)/g)].map((match) => match[1])
    );
    producers.add("request_already_terminal");
    assert.deepEqual(
        [...producers].sort(),
        [...PROMPT_REFINER_RESERVATION_REFUSALS].sort(),
        "the refusal taxonomy must have an explicit producer and no dead reason"
    );

    for (const functionName of [
        "reservePromptRefinerExecution",
        "transitionReservation",
        "expirePromptRefinerReservations",
    ]) {
        const start = source.indexOf(`const ${functionName}`);
        const end = source.indexOf("\n};", start);
        const body = source.slice(start, end);
        const stageLock = body.indexOf("await lockStage");
        const registryLock = body.indexOf("await lockModelRegistry");
        const reservationLock = body.indexOf('FROM "PromptRefinerReservation"');
        assert.ok(stageLock >= 0, `${functionName}: stage lock`);
        assert.ok(registryLock > stageLock, `${functionName}: registry lock order`);
        assert.ok(reservationLock > registryLock, `${functionName}: reservation lock order`);
    }

    const expireStart = source.indexOf("const expirePromptRefinerReservations");
    const expireEnd = source.indexOf("\n};", expireStart);
    const expireBody = source.slice(expireStart, expireEnd);
    assert.match(
        expireBody,
        /"expiresAt" <= \(clock_timestamp\(\) AT TIME ZONE 'UTC'\)[\s\S]*ORDER BY "expiresAt", "id"[\s\S]*LIMIT \$\{limit\}[\s\S]*FOR UPDATE/,
        "the caller limit must bound the ordered DB lock footprint"
    );
});
