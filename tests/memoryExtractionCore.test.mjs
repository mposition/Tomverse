import assert from "node:assert/strict";
import test from "node:test";
import {
    isPairRevoked,
    parseRevokedPairs,
} from "../lib/memoryAccess.ts";
import {
    MEMORY_EXTRACTION_CHUNK_MAX_BYTES,
    MEMORY_EXTRACTION_CHUNK_MAX_CONVERSATIONS,
    decideMemoryExtractionBudget,
    estimateExtraction,
    isRunLeaseExpired,
    planExtractionChunks,
    resolveMemoryExtractionSubBudget,
} from "../lib/memoryExtractionCore.ts";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    findApprovedEvalPair,
    findEvalRegisterProblems,
} from "../lib/memoryExtractionEvalRegister.ts";

// --- revocation semantics (§12.1, lib/memoryAccess.ts) ---

test("absent or empty revocation lists revoke nothing", () => {
    assert.equal(parseRevokedPairs(null).kind, "none");
    assert.equal(parseRevokedPairs("").kind, "none");
    assert.equal(parseRevokedPairs("[]").kind, "none");
});

test("a malformed revocation list revokes everything (fail-closed direction)", () => {
    for (const value of ["not json", "{}", '["missing-separator"]', "[42]"]) {
        const state = parseRevokedPairs(value);
        assert.equal(state.kind, "revoke_all", value);
        assert.equal(
            isPairRevoked(state, {
                extractionModelId: "gpt-5-6-luna",
                promptVersion: "mem-extract-v1",
            }),
            true,
            value
        );
    }
});

test("a well-formed revocation revokes exactly the named pair", () => {
    const state = parseRevokedPairs('["gpt-5-6-luna::mem-extract-v1"]');
    assert.equal(
        isPairRevoked(state, {
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
        }),
        true
    );
    assert.equal(
        isPairRevoked(state, {
            extractionModelId: "gpt-5-4-mini",
            promptVersion: "mem-extract-v1",
        }),
        false
    );
});

// --- eval register (§12.1, §12.3) ---

const approvedEntry = (overrides = {}) => ({
    extractionModelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
    status: "approved",
    owner: "@qa",
    registeredAt: "2026-08-03",
    evalBudget: {
        approvedBy: "@qa",
        maxUsd: 100,
        ticket: "TICKET-1",
        approvedAt: "2026-08-03",
    },
    evaluation: {
        artifactRef: "artifacts/mem-extract-v1",
        evaluatedCommit: "a".repeat(40),
        datasetVersion: "v1",
        languages: ["ko", "en"],
        sampleCounts: Object.fromEntries(
            ["1", "2", "3", "4"].flatMap((category) =>
                ["ko", "en"].map((language) => [`${category}:${language}`, 200])
            )
        ),
        metrics: {
            precisionWilsonLowerAggregate: 0.96,
            recallWilsonLowerAggregate: 0.9,
            precisionWilsonLowerByArm: { ko: 0.96, en: 0.95 },
            recallWilsonLowerByArm: { ko: 0.9, en: 0.86 },
        },
        criticalFalseAcceptances: 0,
        approver: "@qa",
        approvedAt: "2026-08-03",
        expiresAt: "2027-08-03",
        knownLimitations: "ko/en only",
    },
    ...overrides,
});

const NOW = new Date("2026-08-03T12:00:00.000Z");

test("the shipped register has no problems and no approved pairs", () => {
    assert.deepEqual(findEvalRegisterProblems(MEMORY_EXTRACTION_EVAL_REGISTER, NOW), []);
    assert.equal(
        MEMORY_EXTRACTION_EVAL_REGISTER.filter((entry) => entry.status === "approved")
            .length,
        0
    );
});

test("candidate pairs are never resolvable as approved", () => {
    assert.equal(
        findApprovedEvalPair(
            { extractionModelId: "gpt-5-6-luna", promptVersion: "mem-extract-v1" },
            { kind: "none" }
        ),
        null
    );
});

test("a complete approved entry passes and resolves, unless revoked", () => {
    const register = [approvedEntry()];
    assert.deepEqual(findEvalRegisterProblems(register, NOW), []);
    const pair = {
        extractionModelId: "gpt-5-6-luna",
        promptVersion: "mem-extract-v1",
    };
    assert.ok(findApprovedEvalPair(pair, { kind: "none" }, register));
    assert.equal(
        findApprovedEvalPair(pair, { kind: "revoke_all", reason: "malformed" }, register),
        null
    );
});

test("approval without evidence, budget, samples, metrics or freshness fails the check", () => {
    const broken = [
        approvedEntry({ evaluation: null }),
        approvedEntry({ evalBudget: null }),
        approvedEntry({
            evaluation: {
                ...approvedEntry().evaluation,
                sampleCounts: { "1:ko": 199 },
            },
        }),
        approvedEntry({
            evaluation: {
                ...approvedEntry().evaluation,
                metrics: {
                    ...approvedEntry().evaluation.metrics,
                    precisionWilsonLowerAggregate: 0.949,
                },
            },
        }),
        approvedEntry({
            evaluation: {
                ...approvedEntry().evaluation,
                criticalFalseAcceptances: 1,
            },
        }),
        approvedEntry({
            evaluation: {
                ...approvedEntry().evaluation,
                expiresAt: "2026-08-01",
            },
        }),
    ];
    for (const entry of broken) {
        assert.ok(
            findEvalRegisterProblems([entry], NOW).length > 0,
            JSON.stringify(entry).slice(0, 120)
        );
    }
});

// --- chunk planning and estimate (§11) ---

test("chunks respect byte and conversation-count bounds on conversation boundaries", () => {
    const conversations = Array.from({ length: 25 }, (_, index) => ({
        id: `conv-${index}`,
        messageCount: 10,
        contentBytes: 30_000,
    }));
    const chunks = planExtractionChunks(conversations);
    for (const chunk of chunks) {
        assert.ok(chunk.contentBytes <= MEMORY_EXTRACTION_CHUNK_MAX_BYTES);
        assert.ok(
            chunk.conversationIds.length <=
                MEMORY_EXTRACTION_CHUNK_MAX_CONVERSATIONS
        );
    }
    assert.deepEqual(
        chunks.flatMap((chunk) => chunk.conversationIds),
        conversations.map((conversation) => conversation.id)
    );
});

test("an oversized conversation stays whole in its own chunk", () => {
    const chunks = planExtractionChunks([
        { id: "small", messageCount: 2, contentBytes: 1_000 },
        {
            id: "huge",
            messageCount: 500,
            contentBytes: MEMORY_EXTRACTION_CHUNK_MAX_BYTES * 3,
        },
        { id: "tail", messageCount: 2, contentBytes: 1_000 },
    ]);
    assert.deepEqual(
        chunks.map((chunk) => chunk.conversationIds),
        [["small"], ["huge"], ["tail"]]
    );
});

test("an empty selection is refused", () => {
    assert.throws(() => planExtractionChunks([]));
});

test("the estimate is conservative and covers credits and internal cost", () => {
    const chunks = planExtractionChunks([
        { id: "a", messageCount: 5, contentBytes: 90_000 },
        { id: "b", messageCount: 5, contentBytes: 90_000 },
    ]);
    const estimate = estimateExtraction(chunks, {
        inputMicroUsdPerMTokens: 200_000, // US$0.20 / M tokens
        outputMicroUsdPerMTokens: 1_200_000,
        creditsPerCall: 1,
    });
    assert.equal(estimate.chunkCount, 2);
    assert.equal(estimate.estimatedCredits, 2);
    assert.ok(estimate.estimatedInputTokens > (180_000 / 3));
    assert.ok(estimate.estimatedCostMicroUsd > 0);
    assert.equal(estimate.basis, "conservative_default");
});

// --- sub-budget (§3, §23 item 5) ---

test("the sub-budget defaults to 10% and can never exceed the provider budget", () => {
    assert.equal(
        resolveMemoryExtractionSubBudget({ providerBudgetMicroUsd: 1_000_000 }),
        100_000
    );
    assert.equal(
        resolveMemoryExtractionSubBudget({
            providerBudgetMicroUsd: 1_000_000,
            percentOverride: 25,
        }),
        250_000
    );
    // An absolute override above the provider budget is capped: batch never
    // borrows the interactive ceiling.
    assert.equal(
        resolveMemoryExtractionSubBudget({
            providerBudgetMicroUsd: 1_000_000,
            absoluteOverrideMicroUsd: 5_000_000,
        }),
        1_000_000
    );
});

test("budget decisions check provider total first, then the batch share, per window", () => {
    const windows = {
        day: {
            providerLimit: 1_000_000,
            providerUsed: 0,
            subBudgetLimit: 100_000,
            subBudgetUsed: 0,
            resetAt: "2026-08-04T00:00:00.000Z",
        },
        month: {
            providerLimit: 10_000_000,
            providerUsed: 0,
            subBudgetLimit: 1_000_000,
            subBudgetUsed: 0,
            resetAt: "2026-09-01T00:00:00.000Z",
        },
    };
    assert.deepEqual(
        decideMemoryExtractionBudget({ estimatedCostMicroUsd: 50_000, ...windows }),
        { allowed: true }
    );

    const subExhausted = decideMemoryExtractionBudget({
        estimatedCostMicroUsd: 50_000,
        ...windows,
        day: { ...windows.day, subBudgetUsed: 80_000 },
    });
    assert.equal(subExhausted.allowed, false);
    assert.equal(subExhausted.scope, "batch_sub_budget");
    assert.equal(subExhausted.window, "day");

    const providerExhausted = decideMemoryExtractionBudget({
        estimatedCostMicroUsd: 50_000,
        ...windows,
        day: { ...windows.day, providerUsed: 990_000 },
    });
    assert.equal(providerExhausted.allowed, false);
    assert.equal(providerExhausted.scope, "provider_total");
});

// --- lease clock (§3) ---

test("lease expiry is a strict clock comparison", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    assert.equal(isRunLeaseExpired({ leaseExpiresAt: null }, now), false);
    assert.equal(
        isRunLeaseExpired(
            { leaseExpiresAt: new Date("2026-08-03T12:00:01.000Z") },
            now
        ),
        false
    );
    assert.equal(
        isRunLeaseExpired(
            { leaseExpiresAt: new Date("2026-08-03T12:00:00.000Z") },
            now
        ),
        true
    );
});
