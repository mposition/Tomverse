import assert from "node:assert/strict";
import test from "node:test";

import { getModel } from "../lib/models.ts";
import { getModelPricingProfile } from "../lib/modelPricing.ts";
import {
    PROMPT_REFINER_ADMISSION_REFUSAL_REASONS,
    PROMPT_REFINER_EXECUTION_CONTRACT,
    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
    PROMPT_REFINER_MAX_INPUT_TOKENS,
    PROMPT_REFINER_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_MESSAGE_FRAMING_TOKEN_ALLOWANCE,
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    PROMPT_REFINER_REQUIRED_CONTEXT_TOKENS,
    PROMPT_REFINER_RETRY_COUNT,
    PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
    PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
    PROMPT_REFINER_TERMINAL_REASONS,
    PROMPT_REFINER_TIMEOUT_MS,
    admitPromptRefinerExecution,
    promptRefinerExecutionContractProblems,
    promptRefinerTerminalReceiptFacts,
} from "../lib/promptRefinerExecutionContract.ts";
import { promptRefinerModelMessages } from "../lib/promptRefinerModelPrompt.ts";
import {
    PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
    PROMPT_REFINER_FAILURE_CODES,
    promptRefinerExecutionReceiptSchema,
} from "../lib/promptRefinerReceiptCore.ts";
import { PROMPT_REFINER_VERSION } from "../lib/promptRefinerSuggestion.ts";

const candidate = (overrides = {}) => ({
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
    ...overrides,
});

test("execution contract freezes the shadow limits and worst-case cost", () => {
    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.mode, "shadow");
    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.userVisible, false);
    assert.equal(PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId, "gpt-5.6-luna");
    assert.equal(PROMPT_REFINER_EXECUTION_MODEL_PIN.contextWindowTokens, 1_050_000);
    assert.equal(PROMPT_REFINER_REQUIRED_CONTEXT_TOKENS, 104_096);
    assert.equal(PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningTokenBilling, "billed_as_output");
    assert.equal(PROMPT_REFINER_MAX_OUTPUT_TOKENS, 4_096);
    assert.equal(PROMPT_REFINER_TIMEOUT_MS, 15_000);
    assert.equal(PROMPT_REFINER_RETRY_COUNT, 0);
    assert.equal(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD, 24_916);
    assert.equal(PROMPT_REFINER_SHADOW_MAX_DISPATCHES, 100);
    assert.equal(PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD, 2_491_600);
    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.request.promptCaching, "disabled");
    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.request.tools, "none");
    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.stage.requiresSeparateApproval, true);
    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.stage.reservationAuthority, "unavailable");
    assert.equal(Object.isFrozen(PROMPT_REFINER_ADMISSION_REFUSAL_REASONS), true);
    assert.equal(Object.isFrozen(PROMPT_REFINER_TERMINAL_REASONS), true);
});

test("the maximum escaped request fits the offline token upper bound", () => {
    const messages = promptRefinerModelMessages({
        requestId: "request_max_escaped",
        prompt: "\0".repeat(16_000),
    });
    const renderedUtf8Bytes = messages.reduce(
        (total, message) => total + new TextEncoder().encode(message.content).length,
        0
    );
    // Apply the documented byte-level-BPE lemma before adding the separate
    // token-denominated offline framing allowance.
    const maxRenderedContentTokenUpperBound = renderedUtf8Bytes;
    const maxRenderedRequestTokenUpperBound =
        maxRenderedContentTokenUpperBound +
        PROMPT_REFINER_MESSAGE_FRAMING_TOKEN_ALLOWANCE;

    assert.equal(messages.length, 2);
    assert.equal(renderedUtf8Bytes, 96_848);
    assert.equal(maxRenderedContentTokenUpperBound, 96_848);
    assert.ok(maxRenderedRequestTokenUpperBound <= PROMPT_REFINER_MAX_INPUT_TOKENS);
});

test("the checked-in catalogue and pricing must match the exact pin", () => {
    assert.deepEqual(promptRefinerExecutionContractProblems(), []);
    assert.deepEqual(
        promptRefinerExecutionContractProblems({ model: null, pricing: null }),
        ["model_missing", "pricing_missing"]
    );

    const model = getModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
    const pricing = getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
    assert.ok(model);
    assert.ok(pricing);
    assert.ok(
        promptRefinerExecutionContractProblems({
            model: { ...model, apiModel: "drifted-model" },
            pricing,
        }).includes("api_model_mismatch")
    );
    assert.ok(
        promptRefinerExecutionContractProblems({
            model,
            pricing: { ...pricing, pricingVersion: "drifted-price" },
        }).includes("pricing_version_mismatch")
    );
    assert.ok(
        promptRefinerExecutionContractProblems({
            model,
            pricing: {
                ...pricing,
                tiers: pricing.tiers.map((tier, index) =>
                    index === 0
                        ? { ...tier, inputUsdPerMillionTokens: 999 }
                        : tier
                ),
            },
        }).includes("input_price_mismatch")
    );
    assert.ok(
        promptRefinerExecutionContractProblems({
            model: { ...model, contextWindowTokens: 100_000 },
            pricing,
        }).includes("context_window_mismatch")
    );
    assert.ok(
        promptRefinerExecutionContractProblems({
            model,
            pricing: { ...pricing, reasoningTokenBilling: "not_billed" },
        }).includes("reasoning_token_billing_mismatch")
    );
});

test("an otherwise eligible request cannot fabricate successful admission", () => {
    assert.deepEqual(admitPromptRefinerExecution(candidate()), {
        admitted: false,
        reason: "reservation_authority_unavailable",
    });
    assert.deepEqual(
        admitPromptRefinerExecution(
            candidate({
                stageReservation: {
                    kind: "forged",
                    leaseId: "caller_controlled",
                },
            })
        ),
        {
            admitted: false,
            reason: "reservation_authority_unavailable",
        }
    );
});

test("unknown, unapproved, drifted and authority-less candidates fail closed", () => {
    const cases = [
        [candidate({ eligible: null }), "eligibility_refused"],
        [candidate({ mode: "product" }), "eligibility_refused"],
        [candidate({ stageApproved: null }), "execution_not_approved"],
        [candidate({ adapterReady: null }), "adapter_unavailable"],
        [candidate({ contractVersion: "drifted" }), "execution_contract_mismatch"],
        [candidate({ retryCount: 1 }), "execution_contract_mismatch"],
        [candidate({ promptCaching: "enabled" }), "execution_contract_mismatch"],
        [candidate({ tools: "allowed" }), "execution_contract_mismatch"],
        [candidate({ inputTokenCeiling: null }), "execution_contract_mismatch"],
        [candidate({ inputTokenCeiling: 0 }), "execution_contract_mismatch"],
        [candidate({ inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS - 1 }), "execution_contract_mismatch"],
        [candidate({ inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS + 1 }), "execution_contract_mismatch"],
        [candidate(), "reservation_authority_unavailable"],
    ];

    for (const [input, reason] of cases) {
        assert.deepEqual(admitPromptRefinerExecution(input), {
            admitted: false,
            reason,
        });
    }
    assert.deepEqual(
        [...PROMPT_REFINER_ADMISSION_REFUSAL_REASONS].sort(),
        [...new Set(cases.map(([, reason]) => reason))].sort()
    );
});

test("every terminal reason has one content-free receipt and disposition mapping", () => {
    const expected = {
        suggested: ["suggested", "none", null, "choice_or_stale_after_ready"],
        eligibility_refused: ["refused_before_dispatch", "admission", "eligibility_refused", "stale_before_ready_only"],
        execution_not_approved: ["refused_before_dispatch", "admission", "execution_not_approved", "stale_before_ready_only"],
        execution_contract_mismatch: ["refused_before_dispatch", "admission", "execution_contract_mismatch", "stale_before_ready_only"],
        adapter_unavailable: ["refused_before_dispatch", "adapter", "adapter_unavailable", "stale_before_ready_only"],
        reservation_authority_unavailable: ["refused_before_dispatch", "admission", "reservation_authority_unavailable", "stale_before_ready_only"],
        cancelled_before_dispatch: ["refused_before_dispatch", "admission", "cancelled", "stale_before_ready_only"],
        provider_error: ["failed", "provider", "provider_error", "stale_before_ready_only"],
        timeout: ["failed", "provider", "timeout", "stale_before_ready_only"],
        invalid_response: ["failed", "response_validation", "invalid_response", "stale_before_ready_only"],
        empty_response: ["failed", "response_validation", "empty_response", "stale_before_ready_only"],
        no_change: ["failed", "response_validation", "no_change", "stale_before_ready_only"],
        cancelled_after_dispatch: ["failed", "provider", "cancelled", "stale_before_ready_only"],
        unknown_after_dispatch: ["failed", "provider", "unknown_after_dispatch", "stale_before_ready_only"],
    };

    assert.deepEqual(Object.keys(expected), [...PROMPT_REFINER_TERMINAL_REASONS]);
    assert.deepEqual(
        [...new Set(Object.values(expected).map(([, , code]) => code).filter(Boolean))].sort(),
        [...PROMPT_REFINER_FAILURE_CODES].sort()
    );
    for (const reason of PROMPT_REFINER_ADMISSION_REFUSAL_REASONS) {
        assert.ok(PROMPT_REFINER_TERMINAL_REASONS.includes(reason));
        const facts = promptRefinerTerminalReceiptFacts(reason);
        assert.ok(facts);
        assert.equal(
            promptRefinerExecutionReceiptSchema.safeParse({
                receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
                receiptId: `execution_${reason}`,
                requestId: `request_${reason}`,
                suggestionId: null,
                refinerVersion: PROMPT_REFINER_VERSION,
                provider: null,
                modelId: null,
                adapterVersion: null,
                outcome: facts.outcome,
                failureLayer: facts.failureLayer,
                failureCode: facts.failureCode,
                requestedAt: "2026-09-16T00:00:00.000Z",
                dispatchedAt: null,
                completedAt: "2026-09-16T00:00:00.050Z",
                preparationLatencyMs: 50,
                inputTokens: null,
                cachedInputTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                actualCostMicroUsd: null,
                retryCount: facts.retryCount,
            }).success,
            true
        );
    }
    for (const reason of PROMPT_REFINER_TERMINAL_REASONS) {
        const facts = promptRefinerTerminalReceiptFacts(reason);
        assert.deepEqual(
            [facts.outcome, facts.failureLayer, facts.failureCode, facts.dispositionPolicy],
            expected[reason]
        );
        assert.equal(facts.retryCount, 0);
        const dispatched = facts.outcome !== "refused_before_dispatch";
        assert.equal(
            promptRefinerExecutionReceiptSchema.safeParse({
                receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
                receiptId: `terminal_${reason}`,
                requestId: `terminal_request_${reason}`,
                suggestionId:
                    facts.outcome === "suggested"
                        ? `terminal_suggestion_${reason}`
                        : null,
                refinerVersion: PROMPT_REFINER_VERSION,
                provider: dispatched
                    ? PROMPT_REFINER_EXECUTION_MODEL_PIN.provider
                    : null,
                modelId: dispatched
                    ? PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId
                    : null,
                adapterVersion: dispatched
                    ? PROMPT_REFINER_EXECUTION_CONTRACT_VERSION
                    : null,
                outcome: facts.outcome,
                failureLayer: facts.failureLayer,
                failureCode: facts.failureCode,
                requestedAt: "2026-09-16T00:00:00.000Z",
                dispatchedAt: dispatched
                    ? "2026-09-16T00:00:00.100Z"
                    : null,
                completedAt: dispatched
                    ? "2026-09-16T00:00:01.000Z"
                    : "2026-09-16T00:00:00.050Z",
                preparationLatencyMs: dispatched ? 1_000 : 50,
                inputTokens: null,
                cachedInputTokens: null,
                outputTokens: null,
                reasoningTokens: null,
                actualCostMicroUsd: null,
                retryCount: facts.retryCount,
            }).success,
            true,
            reason
        );
    }
});

test("execution receipt schema structurally rejects any retry", () => {
    const receipt = {
        receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
        receiptId: "execution_1",
        requestId: "request_1",
        suggestionId: "suggestion_1",
        refinerVersion: PROMPT_REFINER_VERSION,
        provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
        modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId,
        adapterVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
        outcome: "suggested",
        failureLayer: "none",
        failureCode: null,
        requestedAt: "2026-09-16T00:00:00.000Z",
        dispatchedAt: "2026-09-16T00:00:00.100Z",
        completedAt: "2026-09-16T00:00:01.000Z",
        preparationLatencyMs: 1_000,
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: null,
        actualCostMicroUsd: 2,
        retryCount: 0,
    };

    assert.equal(promptRefinerExecutionReceiptSchema.safeParse(receipt).success, true);
    assert.equal(
        promptRefinerExecutionReceiptSchema.safeParse({ ...receipt, retryCount: 1 }).success,
        false
    );
});
