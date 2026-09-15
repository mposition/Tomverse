import { z } from "zod";

/**
 * Content-free Prompt Refiner observability.
 *
 * The server-side execution receipt and the browser-originated disposition
 * receipt are separate immutable facts. The first says what the adapter did;
 * the second says what happened to the proposal in the composer. Keeping them
 * separate prevents a late client event from rewriting provider telemetry and
 * lets every rate retain its real denominator.
 *
 * docs/policy/prompt-refiner-observability.md
 */

export const PROMPT_REFINER_EXECUTION_RECEIPT_VERSION =
    "prompt-refiner-execution-v1" as const;
export const PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION =
    "prompt-refiner-disposition-v1" as const;
export const PROMPT_REFINER_RECEIPT_BUNDLE_VERSION =
    "prompt-refiner-observability-v1" as const;
export const PROMPT_REFINER_RECEIPT_MAX_RECORDS = 100_000;

export const PROMPT_REFINER_EXECUTION_OUTCOMES = [
    "suggested",
    "failed",
    "refused_before_dispatch",
] as const;
export const PROMPT_REFINER_FAILURE_LAYERS = [
    "none",
    "admission",
    "adapter",
    "provider",
    "response_validation",
] as const;
export type PromptRefinerFailureLayer =
    (typeof PROMPT_REFINER_FAILURE_LAYERS)[number];
export const PROMPT_REFINER_FAILURE_CODES = [
    "eligibility_refused",
    "execution_not_approved",
    "execution_contract_mismatch",
    "reservation_authority_unavailable",
    "adapter_unavailable",
    "invalid_response",
    "empty_response",
    "no_change",
    "provider_error",
    "timeout",
    "cancelled",
    "unknown_after_dispatch",
] as const;
export type PromptRefinerFailureCode =
    (typeof PROMPT_REFINER_FAILURE_CODES)[number];
type FixedLayerFailureCode = Exclude<PromptRefinerFailureCode, "cancelled">;
type FailureLayer = Exclude<PromptRefinerFailureLayer, "none">;
const FAILURE_LAYER_BY_CODE = {
    eligibility_refused: "admission",
    execution_not_approved: "admission",
    execution_contract_mismatch: "admission",
    reservation_authority_unavailable: "admission",
    adapter_unavailable: "adapter",
    provider_error: "provider",
    timeout: "provider",
    unknown_after_dispatch: "provider",
    invalid_response: "response_validation",
    empty_response: "response_validation",
    no_change: "response_validation",
} as const satisfies Record<FixedLayerFailureCode, FailureLayer>;

const expectedFailureLayer = (
    code: PromptRefinerFailureCode,
    dispatched: boolean
): FailureLayer =>
    code === "cancelled"
        ? dispatched
            ? "provider"
            : "admission"
        : FAILURE_LAYER_BY_CODE[code];
export const PROMPT_REFINER_DISPOSITION_OUTCOMES = [
    "accepted",
    "kept_original",
    "stale",
] as const;
export const PROMPT_REFINER_STALE_REASONS = [
    "draft_changed_while_requesting",
    "scope_changed_while_requesting",
    "request_superseded",
    "submitted_before_ready",
    "draft_changed_after_ready",
    "scope_changed_after_ready",
] as const;

const identifier = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/);
const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const isoTimestamp = z.string().datetime({ offset: true });
const optionalTelemetryCount = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable();

const executionReceiptBaseSchema = z
    .object({
        receiptVersion: z.literal(PROMPT_REFINER_EXECUTION_RECEIPT_VERSION),
        receiptId: opaqueId,
        requestId: opaqueId,
        suggestionId: opaqueId.nullable(),
        /** Tomverse prompt contract version, never a provider/model alias. */
        refinerVersion: z.string().regex(/^suggest-v[1-9][0-9]{0,3}$/),
        provider: identifier.nullable(),
        modelId: identifier.nullable(),
        adapterVersion: identifier.nullable(),
        outcome: z.enum(PROMPT_REFINER_EXECUTION_OUTCOMES),
        failureLayer: z.enum(PROMPT_REFINER_FAILURE_LAYERS),
        /** Closed code only. Provider error prose has no field in this schema. */
        failureCode: z.enum(PROMPT_REFINER_FAILURE_CODES).nullable(),
        requestedAt: isoTimestamp,
        dispatchedAt: isoTimestamp.nullable(),
        completedAt: isoTimestamp,
        /** Derived requestedAt -> completedAt wall time. */
        preparationLatencyMs: z.number().int().nonnegative(),
        inputTokens: optionalTelemetryCount,
        cachedInputTokens: optionalTelemetryCount,
        outputTokens: optionalTelemetryCount,
        reasoningTokens: optionalTelemetryCount,
        actualCostMicroUsd: optionalTelemetryCount,
        retryCount: z.literal(0),
    })
    .strict();

export const promptRefinerExecutionReceiptSchema =
    executionReceiptBaseSchema.superRefine((receipt, context) => {
        const requestedAt = Date.parse(receipt.requestedAt);
        const completedAt = Date.parse(receipt.completedAt);
        const dispatchedAt = receipt.dispatchedAt
            ? Date.parse(receipt.dispatchedAt)
            : null;
        const issue = (message: string, path: Array<string | number>) =>
            context.addIssue({ code: "custom", message, path });

        if (completedAt < requestedAt) {
            issue("prompt_refiner_completion_precedes_request", ["completedAt"]);
        }
        if (
            dispatchedAt !== null &&
            (dispatchedAt < requestedAt || dispatchedAt > completedAt)
        ) {
            issue("prompt_refiner_dispatch_outside_execution_window", [
                "dispatchedAt",
            ]);
        }
        if (
            receipt.preparationLatencyMs !==
            Math.max(0, completedAt - requestedAt)
        ) {
            issue("prompt_refiner_latency_does_not_match_timestamps", [
                "preparationLatencyMs",
            ]);
        }

        const hasCompleteAttribution =
            receipt.provider !== null &&
            receipt.modelId !== null &&
            receipt.adapterVersion !== null;
        const attributionCount = [
            receipt.provider,
            receipt.modelId,
            receipt.adapterVersion,
        ].filter((value) => value !== null).length;
        const hasAnyTelemetry =
            receipt.inputTokens !== null ||
            receipt.cachedInputTokens !== null ||
            receipt.outputTokens !== null ||
            receipt.reasoningTokens !== null ||
            receipt.actualCostMicroUsd !== null;

        if (receipt.outcome === "suggested") {
            if (!receipt.suggestionId) {
                issue("prompt_refiner_success_requires_suggestion", [
                    "suggestionId",
                ]);
            }
            if (dispatchedAt === null || !hasCompleteAttribution) {
                issue("prompt_refiner_success_requires_dispatch_attribution", [
                    "outcome",
                ]);
            }
            if (receipt.failureLayer !== "none" || receipt.failureCode !== null) {
                issue("prompt_refiner_success_cannot_carry_failure", [
                    "failureLayer",
                ]);
            }
        } else {
            if (receipt.suggestionId !== null) {
                issue("prompt_refiner_non_success_cannot_carry_suggestion", [
                    "suggestionId",
                ]);
            }
            if (receipt.failureLayer === "none" || receipt.failureCode === null) {
                issue("prompt_refiner_non_success_requires_failure", [
                    "failureLayer",
                ]);
            }
        }

        if (attributionCount !== 0 && attributionCount !== 3) {
            issue("prompt_refiner_attribution_is_partial", ["provider"]);
        }

        if (receipt.outcome === "refused_before_dispatch") {
            if (dispatchedAt !== null || hasAnyTelemetry || receipt.retryCount !== 0) {
                issue("prompt_refiner_refusal_cannot_claim_provider_work", [
                    "outcome",
                ]);
            }
            if (
                receipt.failureLayer !== "admission" &&
                receipt.failureLayer !== "adapter"
            ) {
                issue("prompt_refiner_refusal_has_invalid_failure_layer", [
                    "failureLayer",
                ]);
            }
        }

        if (receipt.outcome === "failed") {
            if (dispatchedAt === null) {
                issue("prompt_refiner_failure_requires_dispatch", [
                    "dispatchedAt",
                ]);
            }
            if (receipt.failureLayer === "admission") {
                issue("prompt_refiner_failure_cannot_use_admission_layer", [
                    "failureLayer",
                ]);
            }
        }
        if (dispatchedAt !== null && !hasCompleteAttribution) {
            issue("prompt_refiner_dispatch_requires_attribution", ["provider"]);
        }
        if (dispatchedAt === null && hasAnyTelemetry) {
            issue("prompt_refiner_undispatched_receipt_cannot_have_telemetry", [
                "inputTokens",
            ]);
        }
        if (receipt.failureCode !== null) {
            const expectedLayer = expectedFailureLayer(
                receipt.failureCode,
                dispatchedAt !== null
            );
            const codeRequiresDispatch =
                expectedLayer === "provider" ||
                expectedLayer === "response_validation";
            if (dispatchedAt === null && codeRequiresDispatch) {
                issue("prompt_refiner_post_dispatch_code_requires_dispatch", [
                    "failureCode",
                ]);
            }
            if (dispatchedAt !== null && !codeRequiresDispatch) {
                issue("prompt_refiner_pre_dispatch_code_forbids_dispatch", [
                    "failureCode",
                ]);
            }
            if (receipt.failureLayer !== expectedLayer) {
                issue("prompt_refiner_failure_code_layer_mismatch", [
                    "failureLayer",
                ]);
            }
        }
    });

const staleBeforeReady = new Set<string>([
    "draft_changed_while_requesting",
    "scope_changed_while_requesting",
    "request_superseded",
    "submitted_before_ready",
]);

export const promptRefinerDispositionReceiptSchema = z
    .object({
        receiptVersion: z.literal(PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION),
        dispositionId: opaqueId,
        executionReceiptId: opaqueId,
        requestId: opaqueId,
        suggestionId: opaqueId.nullable(),
        outcome: z.enum(PROMPT_REFINER_DISPOSITION_OUTCOMES),
        staleReason: z.enum(PROMPT_REFINER_STALE_REASONS).nullable(),
        observedAt: isoTimestamp,
    })
    .strict()
    .superRefine((receipt, context) => {
        const issue = (message: string, path: Array<string | number>) =>
            context.addIssue({ code: "custom", message, path });
        if (receipt.outcome === "stale") {
            if (receipt.staleReason === null) {
                issue("prompt_refiner_stale_requires_reason", ["staleReason"]);
            } else if (
                staleBeforeReady.has(receipt.staleReason) !==
                (receipt.suggestionId === null)
            ) {
                issue("prompt_refiner_stale_stage_does_not_match_suggestion", [
                    "suggestionId",
                ]);
            }
        } else {
            if (receipt.suggestionId === null) {
                issue("prompt_refiner_choice_requires_suggestion", [
                    "suggestionId",
                ]);
            }
            if (receipt.staleReason !== null) {
                issue("prompt_refiner_choice_cannot_carry_stale_reason", [
                    "staleReason",
                ]);
            }
        }
    });

const receiptBundleBaseSchema = z
    .object({
        bundleVersion: z.literal(PROMPT_REFINER_RECEIPT_BUNDLE_VERSION),
        executions: z
            .array(promptRefinerExecutionReceiptSchema)
            .max(PROMPT_REFINER_RECEIPT_MAX_RECORDS),
        dispositions: z
            .array(promptRefinerDispositionReceiptSchema)
            .max(PROMPT_REFINER_RECEIPT_MAX_RECORDS),
    })
    .strict();

export const promptRefinerReceiptBundleSchema =
    receiptBundleBaseSchema.superRefine((bundle, context) => {
        const executionsById = new Map(
            bundle.executions.map((receipt) => [receipt.receiptId, receipt])
        );
        const duplicateValues = (
            values: readonly string[],
            path: "executions" | "dispositions",
            label: string
        ) => {
            const seen = new Set<string>();
            for (const [index, value] of values.entries()) {
                if (seen.has(value)) {
                    context.addIssue({
                        code: "custom",
                        message: `prompt_refiner_duplicate_${label}`,
                        path: [path, index],
                    });
                }
                seen.add(value);
            }
        };

        duplicateValues(
            bundle.executions.map((receipt) => receipt.receiptId),
            "executions",
            "execution_receipt_id"
        );
        duplicateValues(
            bundle.executions.map((receipt) => receipt.requestId),
            "executions",
            "request_id"
        );
        duplicateValues(
            bundle.executions.flatMap((receipt) =>
                receipt.suggestionId ? [receipt.suggestionId] : []
            ),
            "executions",
            "suggestion_id"
        );
        duplicateValues(
            bundle.dispositions.map((receipt) => receipt.dispositionId),
            "dispositions",
            "disposition_id"
        );
        duplicateValues(
            bundle.dispositions.map((receipt) => receipt.executionReceiptId),
            "dispositions",
            "execution_disposition"
        );

        for (const [index, disposition] of bundle.dispositions.entries()) {
            const execution = executionsById.get(disposition.executionReceiptId);
            const issue = (message: string, field: string) =>
                context.addIssue({
                    code: "custom",
                    message,
                    path: ["dispositions", index, field],
                });
            if (!execution) {
                issue("prompt_refiner_orphan_disposition", "executionReceiptId");
                continue;
            }
            if (execution.requestId !== disposition.requestId) {
                issue("prompt_refiner_disposition_request_mismatch", "requestId");
            }
            const beforeReadyStale =
                disposition.outcome === "stale" &&
                disposition.staleReason !== null &&
                staleBeforeReady.has(disposition.staleReason);
            if (!beforeReadyStale) {
                if (execution.outcome !== "suggested") {
                    issue(
                        "prompt_refiner_disposition_requires_suggestion_outcome",
                        "outcome"
                    );
                }
                if (execution.suggestionId !== disposition.suggestionId) {
                    issue(
                        "prompt_refiner_disposition_suggestion_mismatch",
                        "suggestionId"
                    );
                }
            }

            const observedAt = Date.parse(disposition.observedAt);
            if (observedAt < Date.parse(execution.requestedAt)) {
                issue("prompt_refiner_disposition_precedes_request", "observedAt");
            }
            if (
                !beforeReadyStale &&
                observedAt < Date.parse(execution.completedAt)
            ) {
                issue("prompt_refiner_ready_disposition_precedes_completion", "observedAt");
            }
        }
    });

export type PromptRefinerExecutionReceipt = z.infer<
    typeof promptRefinerExecutionReceiptSchema
>;
export type PromptRefinerDispositionReceipt = z.infer<
    typeof promptRefinerDispositionReceiptSchema
>;
export type PromptRefinerReceiptBundle = z.infer<
    typeof promptRefinerReceiptBundleSchema
>;

export type PromptRefinerPercentiles = {
    count: number;
    p50: number | null;
    p95: number | null;
};

export type PromptRefinerTelemetryCoverage = {
    population: number;
    reported: number;
    missing: number;
    total: number;
};

export type PromptRefinerModelBreakdown = {
    provider: string;
    modelId: string;
    requests: number;
    dispatched: number;
    suggested: number;
    failed: number;
    refusedBeforeDispatch: number;
    dispatchedFailureRate: number | null;
    suggestionPreparationLatencyMs: PromptRefinerPercentiles;
};

export type PromptRefinerReceiptSummary = {
    requests: number;
    outcomes: {
        suggested: number;
        failed: number;
        refusedBeforeDispatch: number;
    };
    dispatched: number;
    dispatchedFailures: number;
    dispatchedFailureRate: number | null;
    failedRequestRate: number | null;
    refusalRate: number | null;
    suggestionYieldRate: number | null;
    terminalLatencyMs: PromptRefinerPercentiles;
    suggestionPreparationLatencyMs: PromptRefinerPercentiles;
    dispositions: {
        observed: number;
        unobservedRequests: number;
        accepted: number;
        keptOriginal: number;
        stale: number;
        staleRequestRate: number | null;
        explicitChoices: number;
        explicitChoiceRatePerSuggestion: number | null;
        acceptanceRatePerChoice: number | null;
        keptOriginalRatePerChoice: number | null;
    };
    telemetry: {
        actualCostMicroUsd: PromptRefinerTelemetryCoverage;
        inputTokens: PromptRefinerTelemetryCoverage;
        outputTokens: PromptRefinerTelemetryCoverage;
        reasoningTokens: PromptRefinerTelemetryCoverage;
        cachedInputTokens: PromptRefinerTelemetryCoverage;
    };
    failureCodes: Record<string, number>;
    unattributedRequests: number;
    byProviderModel: PromptRefinerModelBreakdown[];
};

const rate = (numerator: number, denominator: number): number | null =>
    denominator === 0 ? null : numerator / denominator;

const percentiles = (values: readonly number[]): PromptRefinerPercentiles => {
    if (values.length === 0) return { count: 0, p50: null, p95: null };
    const sorted = [...values].sort((left, right) => left - right);
    const at = (quantile: number) =>
        sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
    return { count: sorted.length, p50: at(0.5), p95: at(0.95) };
};

const telemetryCoverage = (
    receipts: readonly PromptRefinerExecutionReceipt[],
    field:
        | "actualCostMicroUsd"
        | "inputTokens"
        | "outputTokens"
        | "reasoningTokens"
        | "cachedInputTokens"
): PromptRefinerTelemetryCoverage => {
    const dispatched = receipts.filter((receipt) => receipt.dispatchedAt !== null);
    const reported = dispatched
        .map((receipt) => receipt[field])
        .filter((value): value is number => value !== null);
    return {
        population: dispatched.length,
        reported: reported.length,
        missing: dispatched.length - reported.length,
        total: reported.reduce((sum, value) => sum + value, 0),
    };
};

const summarizeModel = (
    provider: string,
    modelId: string,
    receipts: readonly PromptRefinerExecutionReceipt[]
): PromptRefinerModelBreakdown => {
    const dispatched = receipts.filter((receipt) => receipt.dispatchedAt !== null);
    const failed = receipts.filter((receipt) => receipt.outcome === "failed").length;
    const dispatchedFailures = dispatched.filter(
        (receipt) => receipt.outcome === "failed"
    ).length;
    return {
        provider,
        modelId,
        requests: receipts.length,
        dispatched: dispatched.length,
        suggested: receipts.filter((receipt) => receipt.outcome === "suggested")
            .length,
        failed,
        refusedBeforeDispatch: receipts.filter(
            (receipt) => receipt.outcome === "refused_before_dispatch"
        ).length,
        dispatchedFailureRate: rate(dispatchedFailures, dispatched.length),
        suggestionPreparationLatencyMs: percentiles(
            receipts
                .filter((receipt) => receipt.outcome === "suggested")
                .map((receipt) => receipt.preparationLatencyMs)
        ),
    };
};

/**
 * Computes descriptive observability only. No threshold here can approve a
 * provider, infer quality, activate rollout, or satisfy a release gate.
 */
export const summarizePromptRefinerReceipts = (
    input: unknown
): PromptRefinerReceiptSummary => {
    const bundle = promptRefinerReceiptBundleSchema.parse(input);
    const executions = bundle.executions;
    const dispositions = bundle.dispositions;
    const suggested = executions.filter(
        (receipt) => receipt.outcome === "suggested"
    ).length;
    const failed = executions.filter(
        (receipt) => receipt.outcome === "failed"
    ).length;
    const refusedBeforeDispatch = executions.filter(
        (receipt) => receipt.outcome === "refused_before_dispatch"
    ).length;
    const dispatched = executions.filter(
        (receipt) => receipt.dispatchedAt !== null
    );
    const dispatchedFailures = dispatched.filter(
        (receipt) => receipt.outcome === "failed"
    ).length;
    const accepted = dispositions.filter(
        (receipt) => receipt.outcome === "accepted"
    ).length;
    const keptOriginal = dispositions.filter(
        (receipt) => receipt.outcome === "kept_original"
    ).length;
    const stale = dispositions.filter(
        (receipt) => receipt.outcome === "stale"
    ).length;
    const explicitChoices = accepted + keptOriginal;
    const grouped = new Map<string, PromptRefinerExecutionReceipt[]>();
    let unattributedRequests = 0;
    for (const receipt of executions) {
        if (!receipt.provider || !receipt.modelId) {
            unattributedRequests += 1;
            continue;
        }
        const key = `${receipt.provider}\u0000${receipt.modelId}`;
        const group = grouped.get(key) ?? [];
        group.push(receipt);
        grouped.set(key, group);
    }
    const failureCodes: Record<string, number> = {};
    for (const receipt of executions) {
        if (!receipt.failureCode) continue;
        failureCodes[receipt.failureCode] =
            (failureCodes[receipt.failureCode] ?? 0) + 1;
    }

    return {
        requests: executions.length,
        outcomes: { suggested, failed, refusedBeforeDispatch },
        dispatched: dispatched.length,
        dispatchedFailures,
        dispatchedFailureRate: rate(dispatchedFailures, dispatched.length),
        failedRequestRate: rate(failed, executions.length),
        refusalRate: rate(refusedBeforeDispatch, executions.length),
        suggestionYieldRate: rate(suggested, executions.length),
        terminalLatencyMs: percentiles(
            executions.map((receipt) => receipt.preparationLatencyMs)
        ),
        suggestionPreparationLatencyMs: percentiles(
            executions
                .filter((receipt) => receipt.outcome === "suggested")
                .map((receipt) => receipt.preparationLatencyMs)
        ),
        dispositions: {
            observed: dispositions.length,
            unobservedRequests: executions.length - dispositions.length,
            accepted,
            keptOriginal,
            stale,
            staleRequestRate: rate(stale, executions.length),
            explicitChoices,
            explicitChoiceRatePerSuggestion: rate(explicitChoices, suggested),
            acceptanceRatePerChoice: rate(accepted, explicitChoices),
            keptOriginalRatePerChoice: rate(keptOriginal, explicitChoices),
        },
        telemetry: {
            actualCostMicroUsd: telemetryCoverage(
                executions,
                "actualCostMicroUsd"
            ),
            inputTokens: telemetryCoverage(executions, "inputTokens"),
            outputTokens: telemetryCoverage(executions, "outputTokens"),
            reasoningTokens: telemetryCoverage(executions, "reasoningTokens"),
            cachedInputTokens: telemetryCoverage(
                executions,
                "cachedInputTokens"
            ),
        },
        failureCodes: Object.fromEntries(
            Object.entries(failureCodes).sort(([left], [right]) =>
                left.localeCompare(right)
            )
        ),
        unattributedRequests,
        byProviderModel: [...grouped.entries()]
            .map(([key, receipts]) => {
                const [provider, modelId] = key.split("\u0000");
                return summarizeModel(provider, modelId, receipts);
            })
            .sort(
                (left, right) =>
                    right.requests - left.requests ||
                    left.provider.localeCompare(right.provider) ||
                    left.modelId.localeCompare(right.modelId)
            ),
    };
};
