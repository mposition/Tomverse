import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
    PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION,
    PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
    PROMPT_REFINER_RECEIPT_BUNDLE_VERSION,
    promptRefinerDispositionReceiptSchema,
    promptRefinerExecutionReceiptSchema,
    promptRefinerReceiptBundleSchema,
    summarizePromptRefinerReceipts,
} from "../lib/promptRefinerReceiptCore.ts";

const execution = (overrides = {}) => ({
    receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
    receiptId: "exec_1",
    requestId: "request_1",
    suggestionId: "suggestion_1",
    refinerVersion: "suggest-v1",
    provider: "example",
    modelId: "example/refiner-1",
    adapterVersion: "adapter-v1",
    outcome: "suggested",
    failureLayer: "none",
    failureCode: null,
    requestedAt: "2026-09-15T00:00:00.000Z",
    dispatchedAt: "2026-09-15T00:00:00.100Z",
    completedAt: "2026-09-15T00:00:01.000Z",
    preparationLatencyMs: 1_000,
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningTokens: null,
    actualCostMicroUsd: 1_000,
    retryCount: 0,
    ...overrides,
});

const disposition = (overrides = {}) => ({
    receiptVersion: PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION,
    dispositionId: "decision_1",
    executionReceiptId: "exec_1",
    requestId: "request_1",
    suggestionId: "suggestion_1",
    outcome: "accepted",
    staleReason: null,
    observedAt: "2026-09-15T00:00:02.000Z",
    ...overrides,
});

const bundle = (executions = [execution()], dispositions = [disposition()]) => ({
    bundleVersion: PROMPT_REFINER_RECEIPT_BUNDLE_VERSION,
    executions,
    dispositions,
});

test("execution receipts keep success, failure and refusal facts distinct", () => {
    assert.equal(promptRefinerExecutionReceiptSchema.parse(execution()).outcome, "suggested");
    assert.equal(
        promptRefinerExecutionReceiptSchema.parse(
            execution({
                receiptId: "exec_failed",
                requestId: "request_failed",
                suggestionId: null,
                outcome: "failed",
                failureLayer: "provider",
                failureCode: "provider_error",
            })
        ).outcome,
        "failed"
    );
    assert.equal(
        promptRefinerExecutionReceiptSchema.parse(
            execution({
                receiptId: "exec_refused",
                requestId: "request_refused",
                suggestionId: null,
                provider: null,
                modelId: null,
                adapterVersion: null,
                outcome: "refused_before_dispatch",
                failureLayer: "adapter",
                failureCode: "adapter_unavailable",
                dispatchedAt: null,
                completedAt: "2026-09-15T00:00:00.050Z",
                preparationLatencyMs: 50,
                inputTokens: null,
                cachedInputTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                actualCostMicroUsd: null,
            })
        ).outcome,
        "refused_before_dispatch"
    );
});

test("failure codes require their exact lifecycle layer", () => {
    const refusal = {
        receiptId: "exec_exact_layer",
        requestId: "request_exact_layer",
        suggestionId: null,
        provider: null,
        modelId: null,
        adapterVersion: null,
        outcome: "refused_before_dispatch",
        dispatchedAt: null,
        completedAt: "2026-09-15T00:00:00.050Z",
        preparationLatencyMs: 50,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        actualCostMicroUsd: null,
    };
    const exactPairs = [
        ["eligibility_refused", "admission"],
        ["execution_not_approved", "admission"],
        ["execution_contract_mismatch", "admission"],
        ["reservation_authority_unavailable", "admission"],
        ["adapter_unavailable", "adapter"],
    ];

    for (const [failureCode, failureLayer] of exactPairs) {
        assert.equal(
            promptRefinerExecutionReceiptSchema.safeParse(
                execution({ ...refusal, failureCode, failureLayer })
            ).success,
            true
        );
    }
    assert.equal(
        promptRefinerExecutionReceiptSchema.safeParse(
            execution({
                ...refusal,
                failureCode: "execution_not_approved",
                failureLayer: "adapter",
            })
        ).success,
        false
    );
    assert.equal(
        promptRefinerExecutionReceiptSchema.safeParse(
            execution({
                ...refusal,
                failureCode: "adapter_unavailable",
                failureLayer: "admission",
            })
        ).success,
        false
    );
    assert.equal(
        promptRefinerExecutionReceiptSchema.safeParse(
            execution({
                receiptId: "exec_postdispatch_adapter_layer",
                requestId: "request_postdispatch_adapter_layer",
                suggestionId: null,
                outcome: "failed",
                failureCode: "provider_error",
                failureLayer: "adapter",
            })
        ).success,
        false
    );
});

test("execution receipts reject contradictory lifecycle and telemetry claims", () => {
    const refusal = {
        outcome: "refused_before_dispatch",
        suggestionId: null,
        provider: null,
        modelId: null,
        adapterVersion: null,
        failureLayer: "adapter",
        dispatchedAt: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        actualCostMicroUsd: null,
    };
    const invalid = [
        execution({ suggestionId: null }),
        execution({ preparationLatencyMs: 999 }),
        execution({ completedAt: "2026-09-14T23:59:59.000Z", preparationLatencyMs: 0 }),
        execution({
            outcome: "failed",
            suggestionId: null,
            failureLayer: "admission",
            failureCode: "reservation_authority_unavailable",
        }),
        execution({
            outcome: "failed",
            suggestionId: null,
            provider: null,
            modelId: null,
            adapterVersion: null,
            failureLayer: "adapter",
            failureCode: "adapter_unavailable",
            dispatchedAt: null,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            actualCostMicroUsd: null,
        }),
        execution({
            outcome: "failed",
            suggestionId: null,
            failureLayer: "provider",
            failureCode: "provider_error",
            dispatchedAt: null,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            actualCostMicroUsd: null,
        }),
        execution({
            ...refusal,
            failureCode: "adapter_unavailable",
            inputTokens: 1,
        }),
        execution({
            provider: "example",
            modelId: null,
            adapterVersion: null,
            outcome: "refused_before_dispatch",
            suggestionId: null,
            failureLayer: "adapter",
            failureCode: "adapter_unavailable",
            dispatchedAt: null,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            actualCostMicroUsd: null,
        }),
        ...[
            "provider_error",
            "timeout",
            "invalid_response",
            "empty_response",
            "no_change",
            "unknown_after_dispatch",
        ].map((failureCode) => execution({ ...refusal, failureCode })),
        ...["adapter_unavailable", "reservation_authority_unavailable"].map((failureCode) =>
            execution({
                outcome: "failed",
                suggestionId: null,
                failureLayer: "adapter",
                failureCode,
            })
        ),
    ];
    for (const receipt of invalid) {
        assert.equal(promptRefinerExecutionReceiptSchema.safeParse(receipt).success, false);
    }
});

test("receipt schemas have no prompt, identity or provider-error prose channel", () => {
    assert.equal(
        promptRefinerExecutionReceiptSchema.safeParse({
            ...execution(),
            prompt: "private user text",
        }).success,
        false
    );
    assert.equal(
        promptRefinerExecutionReceiptSchema.safeParse({
            ...execution(),
            userId: "user_1",
        }).success,
        false
    );
    assert.equal(
        promptRefinerExecutionReceiptSchema.safeParse({
            ...execution({
                outcome: "failed",
                suggestionId: null,
                failureLayer: "provider",
                failureCode: "Provider said the prompt was invalid",
            }),
        }).success,
        false
    );
});

test("disposition receipts encode explicit choice or a stage-bound stale reason", () => {
    assert.equal(promptRefinerDispositionReceiptSchema.parse(disposition()).outcome, "accepted");
    assert.equal(
        promptRefinerDispositionReceiptSchema.parse(
            disposition({
                outcome: "stale",
                suggestionId: null,
                staleReason: "draft_changed_while_requesting",
                observedAt: "2026-09-15T00:00:00.500Z",
            })
        ).outcome,
        "stale"
    );
    assert.equal(
        promptRefinerDispositionReceiptSchema.parse(
            disposition({
                outcome: "stale",
                staleReason: "draft_changed_after_ready",
            })
        ).outcome,
        "stale"
    );
});

test("disposition receipts reject missing choices and contradictory stale stages", () => {
    const invalid = [
        disposition({ suggestionId: null }),
        disposition({ staleReason: "draft_changed_after_ready" }),
        disposition({ outcome: "stale", staleReason: null }),
        disposition({
            outcome: "stale",
            suggestionId: null,
            staleReason: "draft_changed_after_ready",
        }),
        disposition({
            outcome: "stale",
            staleReason: "draft_changed_while_requesting",
        }),
    ];
    for (const receipt of invalid) {
        assert.equal(promptRefinerDispositionReceiptSchema.safeParse(receipt).success, false);
    }
});

test("bundle parsing refuses duplicate, orphan and mismatched receipts", () => {
    const secondExecution = execution({
        receiptId: "exec_2",
        requestId: "request_2",
        suggestionId: "suggestion_2",
    });
    const invalid = [
        bundle([execution(), execution()]),
        bundle([execution(), secondExecution], [
            disposition(),
            disposition({ dispositionId: "decision_2" }),
        ]),
        bundle([execution()], [
            disposition({ executionReceiptId: "missing_execution" }),
        ]),
        bundle([execution()], [disposition({ requestId: "request_other" })]),
        bundle([execution()], [
            disposition({ suggestionId: "suggestion_other" }),
        ]),
        bundle([execution()], [
            disposition({ observedAt: "2026-09-14T23:59:59.000Z" }),
        ]),
    ];
    for (const value of invalid) {
        assert.equal(promptRefinerReceiptBundleSchema.safeParse(value).success, false);
    }
});

test("a stale observation made while requesting can outlive any execution outcome", () => {
    const failed = execution({
        suggestionId: null,
        outcome: "failed",
        failureLayer: "provider",
        failureCode: "provider_error",
    });
    const stale = disposition({
        suggestionId: null,
        outcome: "stale",
        staleReason: "scope_changed_while_requesting",
        observedAt: "2026-09-15T00:00:00.500Z",
    });
    assert.equal(promptRefinerReceiptBundleSchema.parse(bundle([failed], [stale])).dispositions.length, 1);
});

test("summary exposes every denominator and preserves unknown telemetry", () => {
    const executions = [
        execution({
            receiptId: "exec_1",
            requestId: "request_1",
            suggestionId: "suggestion_1",
            preparationLatencyMs: 100,
            completedAt: "2026-09-15T00:00:00.100Z",
            dispatchedAt: "2026-09-15T00:00:00.010Z",
            actualCostMicroUsd: 1_000,
        }),
        execution({
            receiptId: "exec_2",
            requestId: "request_2",
            suggestionId: "suggestion_2",
            preparationLatencyMs: 400,
            completedAt: "2026-09-15T00:00:00.400Z",
            dispatchedAt: "2026-09-15T00:00:00.020Z",
            actualCostMicroUsd: null,
        }),
        execution({
            receiptId: "exec_3",
            requestId: "request_3",
            suggestionId: null,
            outcome: "failed",
            failureLayer: "provider",
            failureCode: "provider_error",
            preparationLatencyMs: 300,
            completedAt: "2026-09-15T00:00:00.300Z",
            dispatchedAt: "2026-09-15T00:00:00.030Z",
            actualCostMicroUsd: 400,
        }),
        execution({
            receiptId: "exec_4",
            requestId: "request_4",
            suggestionId: null,
            provider: null,
            modelId: null,
            adapterVersion: null,
            outcome: "refused_before_dispatch",
            failureLayer: "adapter",
            failureCode: "adapter_unavailable",
            dispatchedAt: null,
            completedAt: "2026-09-15T00:00:00.050Z",
            preparationLatencyMs: 50,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            actualCostMicroUsd: null,
        }),
    ];
    const dispositions = [
        disposition(),
        disposition({
            dispositionId: "decision_2",
            executionReceiptId: "exec_2",
            requestId: "request_2",
            suggestionId: "suggestion_2",
            outcome: "stale",
            staleReason: "draft_changed_after_ready",
            observedAt: "2026-09-15T00:00:01.000Z",
        }),
    ];
    const summary = summarizePromptRefinerReceipts(bundle(executions, dispositions));

    assert.equal(summary.requests, 4);
    assert.deepEqual(summary.outcomes, {
        suggested: 2,
        failed: 1,
        refusedBeforeDispatch: 1,
    });
    assert.equal(summary.dispatched, 3);
    assert.equal(summary.dispatchedFailures, 1);
    assert.equal(summary.dispatchedFailureRate, 1 / 3);
    assert.equal(summary.suggestionYieldRate, 1 / 2);
    assert.deepEqual(summary.suggestionPreparationLatencyMs, {
        count: 2,
        p50: 100,
        p95: 400,
    });
    assert.equal(summary.dispositions.staleRequestRate, 1 / 4);
    assert.equal(summary.dispositions.explicitChoiceRatePerSuggestion, 1 / 2);
    assert.equal(summary.dispositions.acceptanceRatePerChoice, 1);
    assert.deepEqual(summary.telemetry.actualCostMicroUsd, {
        population: 3,
        reported: 2,
        missing: 1,
        total: 1_400,
    });
    assert.equal(summary.unattributedRequests, 1);
    assert.equal(summary.byProviderModel[0].requests, 3);
});

test("empty input reports null rates and percentiles instead of invented zeroes", () => {
    const summary = summarizePromptRefinerReceipts(bundle([], []));
    assert.equal(summary.requests, 0);
    assert.equal(summary.suggestionYieldRate, null);
    assert.equal(summary.dispatchedFailureRate, null);
    assert.equal(summary.suggestionPreparationLatencyMs.p50, null);
    assert.equal(summary.dispositions.staleRequestRate, null);
    assert.equal(summary.dispositions.acceptanceRatePerChoice, null);
});

test("the CLI emits aggregate-only JSON and a non-approval disclaimer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prompt-refiner-receipts-"));
    const inputPath = join(directory, "receipts.json");
    try {
        const value = bundle(
            [
                execution({
                    receiptId: "sensitive_receipt_id",
                    requestId: "sensitive_request_id",
                    suggestionId: "sensitive_suggestion_id",
                }),
            ],
            [
                disposition({
                    executionReceiptId: "sensitive_receipt_id",
                    requestId: "sensitive_request_id",
                    suggestionId: "sensitive_suggestion_id",
                }),
            ]
        );
        await writeFile(inputPath, JSON.stringify(value), "utf8");

        const jsonRun = spawnSync(
            process.execPath,
            [
                "--import",
                "tsx",
                "scripts/report-prompt-refiner-receipts.mjs",
                `--input=${inputPath}`,
                "--json",
            ],
            { cwd: process.cwd(), encoding: "utf8" }
        );
        assert.equal(jsonRun.status, 0, jsonRun.stderr);
        const output = JSON.parse(jsonRun.stdout);
        assert.equal(output.requests, 1);
        for (const secret of [
            "sensitive_receipt_id",
            "sensitive_request_id",
            "sensitive_suggestion_id",
        ]) {
            assert.equal(jsonRun.stdout.includes(secret), false);
        }

        const humanRun = spawnSync(
            process.execPath,
            [
                "--import",
                "tsx",
                "scripts/report-prompt-refiner-receipts.mjs",
                `--input=${inputPath}`,
            ],
            { cwd: process.cwd(), encoding: "utf8" }
        );
        assert.equal(humanRun.status, 0, humanRun.stderr);
        assert.match(humanRun.stdout, /does not judge quality, release readiness, or rollout approval/);
        for (const label of [
            "actual cost",
            "input tokens",
            "cached input tokens",
            "output tokens",
            "reasoning tokens",
        ]) {
            assert.match(
                humanRun.stdout,
                new RegExp(`${label}: population=1, reported=[01], missing=[01], total=`)
            );
        }

        const forbiddenText = "never-echo-this-private-prompt";
        await writeFile(
            inputPath,
            JSON.stringify({
                ...value,
                executions: [{ ...value.executions[0], prompt: forbiddenText }],
            }),
            "utf8"
        );
        const invalidRun = spawnSync(
            process.execPath,
            [
                "--import",
                "tsx",
                "scripts/report-prompt-refiner-receipts.mjs",
                `--input=${inputPath}`,
            ],
            { cwd: process.cwd(), encoding: "utf8" }
        );
        assert.notEqual(invalidRun.status, 0);
        assert.match(invalidRun.stderr, /prompt_refiner_report_schema_invalid/);
        assert.equal(invalidRun.stderr.includes(forbiddenText), false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
