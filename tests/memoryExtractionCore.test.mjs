import assert from "node:assert/strict";
import test from "node:test";
import {
    isPairRevoked,
    memoryPairLabel,
    parseRevokedPairs,
    revokedPairsRequestProblems,
    serializeRevokedPairs,
} from "../lib/memoryAccess.ts";
import {
    MEMORY_EXTRACTION_CHUNK_MAX_ATTEMPTS,
    MEMORY_EXTRACTION_CHUNK_MAX_BYTES,
    MEMORY_EXTRACTION_CHUNK_MAX_CONVERSATIONS,
    MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS,
    MEMORY_EXTRACTION_LEASE_TTL_MS,
    MEMORY_EXTRACTION_SLICE_BUDGET_MS,
    chunkFailureDisposition,
    decideMemoryExtractionBudget,
    estimateExtraction,
    extractionSliceBudget,
    isRunLeaseExpired,
    mayStartAnotherChunk,
    planExtractionChunks,
    resolveMemoryExtractionSubBudget,
} from "../lib/memoryExtractionCore.ts";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    findApprovedEvalPair,
    findEvalRegisterProblems,
} from "../lib/memoryExtractionEvalRegister.ts";
import { MEMORY_EVAL_DATASET_SCHEMA_VERSION } from "../lib/memoryExtractionEvalCore.ts";

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

// --- revocation writes (§12.1, the Admin Console half) ---

test("a deliberate stop is distinguishable from an unreadable row", () => {
    // Both revoke everything and always must. They are different situations:
    // one is an operator having pulled the feature, the other is a corrupted
    // setting nobody has noticed, and a screen that shows them identically
    // sends the operator looking for the wrong problem.
    const stopped = parseRevokedPairs('["*"]');
    assert.deepEqual(stopped, { kind: "revoke_all", reason: "operator" });
    assert.deepEqual(parseRevokedPairs("not json"), {
        kind: "revoke_all",
        reason: "malformed",
    });
    assert.equal(
        isPairRevoked(stopped, {
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
        }),
        true
    );
});

test("every accepted request reads back as the state it asked for", () => {
    // The property the admin control exists for. A hand-written UPDATE has no
    // such guarantee: one typo and the row parses as revoke-everything, which
    // is both the wrong action and indistinguishable afterwards from data
    // corruption.
    const requests = [
        { mode: "none" },
        { mode: "all" },
        { mode: "pairs", labels: ["gpt-5-6-luna::mem-extract-v1"] },
        {
            mode: "pairs",
            labels: ["gpt-5-6-luna::mem-extract-v1", "gpt-5-4-mini::mem-extract-v1"],
        },
    ];
    for (const request of requests) {
        assert.deepEqual(revokedPairsRequestProblems(request), [], request.mode);
        const state = parseRevokedPairs(serializeRevokedPairs(request));
        if (request.mode === "none") {
            assert.deepEqual(state, { kind: "none" });
        } else if (request.mode === "all") {
            assert.deepEqual(state, { kind: "revoke_all", reason: "operator" });
        } else {
            assert.equal(state.kind, "revoked");
            assert.deepEqual(state.pairs.map(memoryPairLabel), [...request.labels]);
        }
    }
});

test("a request that would read back as revoke-everything is refused", () => {
    // Each of these round-trips as `revoke_all: malformed` -- a typo in one
    // label stopping every pair, and reading afterwards as corruption.
    for (const label of [
        "",
        "   ",
        " gpt-5-6-luna::mem-extract-v1",
        "no-separator",
        "::mem-extract-v1",
        "gpt-5-6-luna::",
        "a::b::c",
    ]) {
        const problems = revokedPairsRequestProblems({ mode: "pairs", labels: [label] });
        assert.equal(problems.length, 1, JSON.stringify(label));
    }
});

test("the stop-everything entry is refused as a pair, and duplicates are named", () => {
    assert.match(
        revokedPairsRequestProblems({ mode: "pairs", labels: ["*"] })[0],
        /stop-everything/
    );
    assert.match(
        revokedPairsRequestProblems({
            mode: "pairs",
            labels: ["a::b", "a::b"],
        })[0],
        /listed twice/
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
        // The schema an approved entry must declare, which is whatever the
        // gate requires now. Written as 2 until 2026-08-28, when the gate
        // moved to 3 and this fixture started describing an approval §12.3
        // would refuse.
        datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
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

test("an approval that does not state the dataset schema fails closed", () => {
    // The 2026-08-25 scoring amendment added two metrics that a schema-1
    // dataset cannot produce. Silence is refused rather than read as
    // schema 2: an approval nobody wrote the schema on is an approval
    // nobody checked it on.
    const unstated = approvedEntry();
    delete unstated.evaluation.datasetSchemaVersion;
    const problems = findEvalRegisterProblems([unstated], NOW);
    assert.ok(
        problems.some((line) => line.includes("(unstated)")),
        problems.join("\n")
    );

    const legacy = approvedEntry({
        evaluation: { ...approvedEntry().evaluation, datasetSchemaVersion: 1 },
    });
    assert.ok(
        findEvalRegisterProblems([legacy], NOW).some((line) =>
            line.includes("dataset schema 1")
        )
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

// --- slice budget and retry disposition (§11 durability) ---

test("a slice budget is bounded by both a chunk count and a wall clock", () => {
    const startedAt = new Date("2026-08-03T12:00:00.000Z");
    const budget = extractionSliceBudget(startedAt, {
        maxChunks: 2,
        budgetMs: 30_000,
    });
    assert.equal(budget.maxChunks, 2);
    assert.equal(budget.deadline.toISOString(), "2026-08-03T12:00:30.000Z");

    // Room on both axes.
    assert.deepEqual(
        mayStartAnotherChunk({ chunksProcessed: 1, budget, now: startedAt }),
        { start: true }
    );
    // Chunk count is spent.
    assert.deepEqual(
        mayStartAnotherChunk({ chunksProcessed: 2, budget, now: startedAt }),
        { start: false, reason: "chunk_budget" }
    );
    // Time is spent, and the deadline is inclusive: at the deadline, stop.
    assert.deepEqual(
        mayStartAnotherChunk({
            chunksProcessed: 0,
            budget,
            now: budget.deadline,
        }),
        { start: false, reason: "time_budget" }
    );
});

test("the slice defaults leave lease headroom to release cleanly", () => {
    // A slice that runs to the very end of its budget must still hold a live
    // lease, or it could not hand the run back and would have to wait for the
    // TTL to lapse instead.
    assert.ok(
        MEMORY_EXTRACTION_SLICE_BUDGET_MS < MEMORY_EXTRACTION_LEASE_TTL_MS,
        "the slice budget must fit inside one lease"
    );
    assert.ok(
        MEMORY_EXTRACTION_CHUNK_TIMEOUT_MS <= MEMORY_EXTRACTION_SLICE_BUDGET_MS,
        "a single chunk must not outlast the whole slice"
    );
});

test("a failed chunk retries below its cap and is terminal at it", () => {
    assert.deepEqual(chunkFailureDisposition({ attemptCount: 1 }), {
        status: "pending",
    });
    assert.deepEqual(
        chunkFailureDisposition({
            attemptCount: MEMORY_EXTRACTION_CHUNK_MAX_ATTEMPTS - 1,
        }),
        { status: "pending" }
    );
    assert.deepEqual(
        chunkFailureDisposition({
            attemptCount: MEMORY_EXTRACTION_CHUNK_MAX_ATTEMPTS,
        }),
        { status: "failed" }
    );
    // Past the cap stays terminal rather than wrapping back to retryable.
    assert.deepEqual(
        chunkFailureDisposition({
            attemptCount: MEMORY_EXTRACTION_CHUNK_MAX_ATTEMPTS + 5,
        }),
        { status: "failed" }
    );
});

// --- eval budget contents (docs/policy/external-conversation-import-and-memory.md §12.5) ---

test("a half-filled eval budget fails wherever it appears", () => {
    // Filling the budget is what opens `--live`. A candidate carrying an
    // incomplete one is the dangerous state, not a harmless one: spending is
    // unlocked and the record naming who authorised it has a hole. So the
    // check does not wait for `status: "approved"` -- by then the money is
    // already spendable.
    const candidateWith = (budget) => [
        {
            extractionModelId: "gpt-5-6-luna",
            promptVersion: "mem-extract-v1",
            status: "candidate",
            owner: "@qa",
            registeredAt: "2026-08-03",
            evalBudget: budget,
            evaluation: null,
        },
    ];
    const complete = {
        approvedBy: "@qa",
        maxUsd: 20,
        ticket: "https://example.invalid/1",
        approvedAt: "2026-08-03",
    };

    assert.deepEqual(findEvalRegisterProblems(candidateWith(complete), NOW), []);
    // No budget at all stays the ordinary waiting state of
    // docs/policy/external-conversation-import-and-memory.md §12.5.
    assert.deepEqual(findEvalRegisterProblems(candidateWith(null), NOW), []);

    for (const field of ["approvedBy", "ticket", "approvedAt"]) {
        const problems = findEvalRegisterProblems(
            candidateWith({ ...complete, [field]: "  " }),
            NOW
        );
        assert.ok(
            problems.some((line) => line.includes(`empty ${field}`)),
            `an empty ${field} passed`
        );
    }
});

test("the spend ceiling must be a positive number", () => {
    // The harness reads `maxUsd` as the ceiling. Zero stops every live run at
    // the first case, and a negative number is a ceiling nobody chose -- both
    // are records that look filled in and are not.
    for (const maxUsd of [0, -1, Number.NaN]) {
        const problems = findEvalRegisterProblems(
            [
                {
                    extractionModelId: "gpt-5-6-luna",
                    promptVersion: "mem-extract-v1",
                    status: "candidate",
                    owner: "@qa",
                    registeredAt: "2026-08-03",
                    evalBudget: {
                        approvedBy: "@qa",
                        maxUsd,
                        ticket: "https://example.invalid/1",
                        approvedAt: "2026-08-03",
                    },
                    evaluation: null,
                },
            ],
            NOW
        );
        assert.ok(
            problems.some((line) => line.includes("maxUsd must be a positive number")),
            `maxUsd=${maxUsd} passed`
        );
    }
});

test("the shipped budget names a ticket and a positive ceiling", () => {
    // The register's own entry, not a fixture: an approval recorded with a
    // blank ticket is an approval nobody can trace.
    const funded = MEMORY_EXTRACTION_EVAL_REGISTER.filter((entry) => entry.evalBudget);
    for (const entry of funded) {
        assert.ok(entry.evalBudget.ticket.trim().length > 0);
        assert.ok(entry.evalBudget.approvedBy.trim().length > 0);
        assert.ok(entry.evalBudget.maxUsd > 0);
    }
    // A funded pair is still not an approved pair.
    for (const entry of funded) {
        assert.notEqual(entry.status, "approved");
    }
});
