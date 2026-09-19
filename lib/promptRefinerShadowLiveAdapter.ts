/**
 * Isolated provider adapter for the future Prompt Refiner staging shadow.
 *
 * No product route, admin route, script or cron imports this module. The live
 * export dynamically imports the provider SDK boundary only after a future
 * durable runner has called it. Tests use createPromptRefinerShadowSdkAdapter
 * with an in-memory language model and never resolve credentials or network.
 */
import "server-only";

import {
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
    PROMPT_REFINER_MAX_INPUT_TOKENS,
    PROMPT_REFINER_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    PROMPT_REFINER_RETRY_COUNT,
    PROMPT_REFINER_TIMEOUT_MS,
    promptRefinerExecutionContractProblems,
    promptRefinerWorstCaseCostMicroUsd,
    type PromptRefinerTerminalReason,
} from "@/lib/promptRefinerExecutionContract";
import { getModelGenerationSettings } from "@/lib/modelGenerationCompatibility";
import { getEnabledModel, type AiModel } from "@/lib/models";
import { promptRefinerModelMessages } from "@/lib/promptRefinerModelPrompt";
import {
    PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
    PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE,
    promptRefinerShadowRunContractProblems,
} from "@/lib/promptRefinerShadowRunContract";
import { parsePromptRefinerShadowOutput } from "@/lib/promptRefinerShadowHarness";
import {
    promptRefinerRequestSchema,
    type PromptRefinerRequest,
} from "@/lib/promptRefinerSuggestion";

type NullableCount = number | null;

export type PromptRefinerShadowUsage = {
    inputTokens: NullableCount;
    cachedInputTokens: NullableCount;
    outputTokens: NullableCount;
    reasoningTokens: NullableCount;
    /** Conservative pinned-rate amount, not a provider invoice. */
    costUpperBoundMicroUsd: NullableCount;
};

type CommonOutcome = {
    adapterVersion: typeof PROMPT_REFINER_SHADOW_ADAPTER_VERSION;
    provider: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.provider;
    modelId: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId;
    terminalReason: PromptRefinerTerminalReason;
    durationMs: number;
    usage: PromptRefinerShadowUsage;
};

export type PromptRefinerShadowAdapterOutcome =
    | (CommonOutcome & {
          status: "suggested";
          terminalReason: "suggested";
          /** Transient result. No writer exists in this adapter. */
          refinedPrompt: string;
      })
    | (CommonOutcome & {
          status: "failed";
          terminalReason: Exclude<
              PromptRefinerTerminalReason,
              | "suggested"
              | "eligibility_refused"
              | "execution_not_approved"
              | "execution_contract_mismatch"
              | "adapter_unavailable"
              | "reservation_authority_unavailable"
              | "cancelled_before_dispatch"
          >;
          refinedPrompt: null;
      });

export type PromptRefinerShadowDispatchFact = {
    requestId: string;
    adapterVersion: typeof PROMPT_REFINER_SHADOW_ADAPTER_VERSION;
    provider: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.provider;
    modelId: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId;
    apiModelId: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId;
    maxOutputTokens: typeof PROMPT_REFINER_MAX_OUTPUT_TOKENS;
    timeoutMs: typeof PROMPT_REFINER_TIMEOUT_MS;
    retryCount: typeof PROMPT_REFINER_RETRY_COUNT;
};

export type PromptRefinerShadowAdapterRequest = PromptRefinerRequest & {
    /** Future durable runner consumes the exact reservation here. */
    onDispatch: (
        fact: PromptRefinerShadowDispatchFact
    ) => Promise<void> | void;
};

type GenerateResult = {
    text?: unknown;
    usage?: unknown;
    warnings?: unknown;
    steps?: unknown;
};

export type PromptRefinerShadowSdkDependencies = {
    generate: (options: Record<string, unknown>) => Promise<GenerateResult>;
    languageModel: unknown;
    now?: () => number;
};

export class PromptRefinerShadowPreDispatchError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = "PromptRefinerShadowPreDispatchError";
    }
}

const nullUsage = (): PromptRefinerShadowUsage => ({
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    costUpperBoundMicroUsd: null,
});

const asRecord = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

const count = (value: unknown): NullableCount =>
    Number.isSafeInteger(value) && (value as number) >= 0
        ? (value as number)
        : null;

const safeErrorFacts = (error: unknown): { name: string; statusCode: number | null } => {
    try {
        const value = asRecord(error);
        return {
            name:
                error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
                    ? error.name
                    : "UnknownError",
            statusCode:
                Number.isSafeInteger(value.statusCode) &&
                (value.statusCode as number) >= 400 &&
                (value.statusCode as number) <= 599
                    ? (value.statusCode as number)
                    : null,
        };
    } catch {
        return { name: "UnknownError", statusCode: null };
    }
};

const usageFrom = (value: unknown): PromptRefinerShadowUsage => {
    const usage = asRecord(value);
    const inputTokens = count(usage.inputTokens);
    const outputTokens = count(usage.outputTokens);
    const cachedInputTokens = count(asRecord(usage.inputTokenDetails).cacheReadTokens);
    const reasoningTokens = count(
        asRecord(usage.outputTokenDetails).reasoningTokens
    );
    // The provider's total input/output counts already include cached input
    // and billed reasoning output under the frozen pricing contract. Requiring
    // all four fields is nevertheless intentional: partial provider telemetry
    // must remain visibly unknown rather than looking like a complete cost
    // observation.
    const costUpperBoundMicroUsd =
        inputTokens !== null &&
        outputTokens !== null &&
        cachedInputTokens !== null &&
        reasoningTokens !== null
            ? promptRefinerWorstCaseCostMicroUsd({
                  inputTokens,
                  outputTokens,
              })
            : null;
    return {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningTokens,
        costUpperBoundMicroUsd,
    };
};

/**
 * Byte-level BPE safety prefilter: every content token covers at least one
 * UTF-8 byte. The fixed allowance covers message framing. This deliberately
 * does not satisfy the frozen preregistration's future actual-tokenizer
 * requirement. The run remains unadmitted until that requirement is fulfilled
 * or a separate contract revision is approved; this adapter only fails closed
 * before dispatch when even the conservative bound exceeds the ceiling.
 */
export const promptRefinerRenderedInputTokenUpperBound = (
    request: PromptRefinerRequest
): number => {
    const messages = promptRefinerModelMessages(request);
    return (
        messages.reduce(
            (total, message) => total + Buffer.byteLength(message.content, "utf8"),
            0
        ) + PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE
    );
};

const exactModel = (): AiModel => {
    const model = getEnabledModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
    if (
        !model ||
        promptRefinerExecutionContractProblems({ model }).length > 0 ||
        promptRefinerShadowRunContractProblems().length > 0
    ) {
        throw new PromptRefinerShadowPreDispatchError(
            "prompt_refiner_execution_contract_mismatch"
        );
    }
    return model;
};

const outcomeBase = (durationMs: number, usage: PromptRefinerShadowUsage) => ({
    adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
    provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
    modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
    durationMs,
    usage,
});

export function createPromptRefinerShadowSdkAdapter(
    dependencies: PromptRefinerShadowSdkDependencies
) {
    const model = exactModel();
    const generationSettings = getModelGenerationSettings(model);
    const now = dependencies.now ?? Date.now;

    return async (
        unsafeRequest: PromptRefinerShadowAdapterRequest
    ): Promise<PromptRefinerShadowAdapterOutcome> => {
        const request = promptRefinerRequestSchema.parse({
            requestId: unsafeRequest.requestId,
            prompt: unsafeRequest.prompt,
        });
        const upperBound = promptRefinerRenderedInputTokenUpperBound(request);
        if (upperBound > PROMPT_REFINER_MAX_INPUT_TOKENS) {
            throw new PromptRefinerShadowPreDispatchError(
                "prompt_refiner_input_token_ceiling_exceeded"
            );
        }
        const messages = promptRefinerModelMessages(request);
        await unsafeRequest.onDispatch({
            requestId: request.requestId,
            adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
            provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
            modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
            apiModelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId,
            maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
            timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
            retryCount: PROMPT_REFINER_RETRY_COUNT,
        });

        const started = now();
        let generated: GenerateResult;
        try {
            generated = await dependencies.generate({
                model: dependencies.languageModel,
                system: messages[0].content,
                prompt: messages[1].content,
                ...generationSettings,
                maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
                maxRetries: PROMPT_REFINER_RETRY_COUNT,
                timeout: PROMPT_REFINER_TIMEOUT_MS,
                include: { requestBody: false, responseBody: false },
            });
        } catch (error) {
            const durationMs = Math.max(0, Math.round(now() - started));
            const facts = safeErrorFacts(error);
            const terminalReason =
                facts.name === "AbortError" || facts.name === "TimeoutError"
                    ? "timeout"
                    : facts.statusCode !== null
                      ? "provider_error"
                      : "unknown_after_dispatch";
            return {
                ...outcomeBase(durationMs, nullUsage()),
                status: "failed",
                terminalReason,
                refinedPrompt: null,
            };
        }

        const durationMs = Math.max(0, Math.round(now() - started));
        const usage = usageFrom(generated.usage);
        const warnings = Array.isArray(generated.warnings)
            ? generated.warnings
            : [];
        const steps = Array.isArray(generated.steps) ? generated.steps : null;
        if (
            warnings.length > 0 ||
            (steps !== null && steps.length !== 1) ||
            (usage.inputTokens !== null &&
                usage.inputTokens > PROMPT_REFINER_MAX_INPUT_TOKENS) ||
            (usage.outputTokens !== null &&
                usage.outputTokens > PROMPT_REFINER_MAX_OUTPUT_TOKENS) ||
            (usage.costUpperBoundMicroUsd !== null &&
                usage.costUpperBoundMicroUsd >
                    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD)
        ) {
            return {
                ...outcomeBase(durationMs, usage),
                status: "failed",
                terminalReason: "unknown_after_dispatch",
                refinedPrompt: null,
            };
        }

        const parsed = parsePromptRefinerShadowOutput({
            sourceText: request.prompt,
            outputText: typeof generated.text === "string" ? generated.text : "",
        });
        if (parsed.status === "suggested") {
            return {
                ...outcomeBase(durationMs, usage),
                status: "suggested",
                terminalReason: "suggested",
                refinedPrompt: parsed.refinedPrompt,
            };
        }
        return {
            ...outcomeBase(durationMs, usage),
            status: "failed",
            terminalReason: parsed.failureCode,
            refinedPrompt: null,
        };
    };
}

/**
 * The only concrete provider-capable export. It is intentionally unreachable
 * from every shipped entry point until a separately reviewed durable runner
 * records approval, consumes a reservation and owns terminal receipts.
 */
export async function runPromptRefinerShadowLiveAdapter(
    request: PromptRefinerShadowAdapterRequest
): Promise<PromptRefinerShadowAdapterOutcome> {
    const model = exactModel();
    const [{ generateText }, { getActiveAiModel }] = await Promise.all([
        import("ai"),
        import("@/lib/activeAiModel"),
    ]);
    const adapter = createPromptRefinerShadowSdkAdapter({
        generate: (options) =>
            generateText(options as Parameters<typeof generateText>[0]),
        languageModel: getActiveAiModel(model),
    });
    return adapter(request);
}
