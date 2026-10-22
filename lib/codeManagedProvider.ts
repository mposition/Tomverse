import "server-only";
import { generateText, jsonSchema, NoObjectGeneratedError, Output, type LanguageModelUsage } from "ai";
import Ajv from "ajv";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { getActiveAiModel } from "@/lib/activeAiModel";
import type { AiModel } from "@/lib/models";
import { PROVIDER_API_KEY_ENV_NAMES } from "@/lib/modelRegistryShared";
import { CODE_PROVIDER_TIMEOUT_MS, validCodeUsage, type CompleteRequest } from "@/lib/codeManagedCore";
export type CodeProviderResult = {
    value?: unknown;
    validOutput: boolean;
    usage: ReturnType<typeof validCodeUsage>;
    providerReportedModelId?: string;
    latencyMs: number;
};
// The SDK normalises provider cache/reasoning details for success and typed
// structured-output failures alike. Preserve that same accounting envelope.
export const normalizedCodeUsage = (usage: LanguageModelUsage | undefined) => validCodeUsage(usage ? {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteInputTokens: usage.inputTokenDetails?.cacheWriteTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
} : undefined);
/** Metadata only: aliases must resolve to exactly one value, never first-wins. */
export function codeProviderCredentialReady(provider: AiModel["provider"], environment: Record<string, string | undefined> = process.env) {
    const values = new Set(PROVIDER_API_KEY_ENV_NAMES[provider].map(name => environment[name]?.trim()).filter(Boolean));
    return values.size === 1;
}
/** Construction can fail before admission; only the returned function dispatches. */
export function prepareCodeProvider(model: AiModel, request: CompleteRequest) {
    const validate = new Ajv({ allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, logger: false }).compile(request.schema);
    const languageModel = getActiveAiModel(model);
    return async (request: CompleteRequest): Promise<CodeProviderResult> => {
        const started = performance.now();
        try {
            const generated = await generateText({ model: languageModel, system: request.prompt.system, prompt: request.prompt.user,
                maxOutputTokens: request.maxOutputTokens, maxRetries: 0, abortSignal: AbortSignal.timeout(CODE_PROVIDER_TIMEOUT_MS),
                output: Output.object({ schema: jsonSchema(request.schema as JSONSchema7, { validate: value => validate(value) ? { success: true, value } : { success: false, error: new Error("Invalid Code output") } }), name: "tomverse_code_response" }),
                // Code's shared schemas contain free-form MCP arguments and optional
                // properties. OpenAI strict mode refuses these requests before inference.
                // Preserve the shared wire shape and validate locally without coercion.
                providerOptions: { openai: { strictJsonSchema: false } },
                // Deliberately no tools, browsing, cache markers, callbacks or fallbacks.
            });
            const usage = normalizedCodeUsage(generated.usage);
            const envelope = { usage, providerReportedModelId: generated.response.modelId?.slice(0, 512), latencyMs: Math.round(performance.now() - started) };
            try {
                const value = generated.output;
                return { ...envelope, value, validOutput: value !== undefined && Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024 };
            }
            catch {
                return { ...envelope, validOutput: false };
            }
        }
        catch (error) {
            // Never return/log error.text, response bodies, prompts or arbitrary error messages.
            if (NoObjectGeneratedError.isInstance(error))
                return {
                    validOutput: false, usage: normalizedCodeUsage(error.usage),
                    latencyMs: Math.round(performance.now() - started)
                };
            return { validOutput: false, usage: null, latencyMs: Math.round(performance.now() - started) };
        }
    };
}
