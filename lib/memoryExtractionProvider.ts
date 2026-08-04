import "server-only";

import { generateText } from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import type { ExtractionModelAdapter } from "@/lib/memoryExtractionPipeline";
import type { AiModel } from "@/lib/models";

/**
 * The one place memory extraction actually calls a provider (Release B,
 * slice 1.6b).
 *
 * Isolated on purpose. Everything that decides *what* a chunk produces is
 * pure and provider-free (lib/memoryExtractionPrompt.ts,
 * memoryExtractionOutput.ts, memoryExtractionPipeline.ts), and a test asserts
 * those modules import nothing that can reach a network. This module is the
 * single exception, so "can extraction spend money yet?" is answerable by
 * looking at who imports this file.
 *
 * Retries are OFF (`maxRetries: 0`) and that is a financial decision, not a
 * reliability preference. The SDK's internal retry would issue several billed
 * calls behind one `await`, and the run's accounting is per *attempt* — an
 * attempt row, a reservation, a settlement. A retry the processor cannot see
 * is a charge it cannot reserve for or settle, so retrying is the processor's
 * job: it opens a new attempt, which reserves again and is recorded again.
 */

export type ExtractionProviderResult = {
    output: unknown;
    usage: {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
        reasoningTokens?: number;
        /** False when the provider returned no usage metadata at all. */
        usageFromProvider: boolean;
    };
    /** Provider-side response id, for reconciling a charge we cannot confirm. */
    responseId: string | null;
};

/**
 * Builds the adapter the pipeline takes. Keeping the pipeline's seam as the
 * public shape means the offline analysis path and the live one are the same
 * code with a different function passed in — the fake used in tests and this
 * are interchangeable by construction.
 */
export function createExtractionProviderAdapter(input: {
    model: AiModel;
    maxOutputTokens: number;
    onResult: (result: ExtractionProviderResult) => void;
}): ExtractionModelAdapter {
    return async ({ prompt }) => {
        const generated = await generateText({
            model: getActiveAiModel(input.model),
            system: prompt.system,
            prompt: prompt.user,
            maxOutputTokens: input.maxOutputTokens,
            // See the module comment: an invisible retry is an unreservable,
            // unsettleable charge.
            maxRetries: 0,
        });

        const usage = generated.usage as
            | {
                  inputTokens?: number;
                  cachedInputTokens?: number;
                  outputTokens?: number;
                  reasoningTokens?: number;
              }
            | undefined;
        input.onResult({
            output: generated.text,
            usage: {
                inputTokens: usage?.inputTokens,
                cachedInputTokens: usage?.cachedInputTokens,
                outputTokens: usage?.outputTokens,
                reasoningTokens: usage?.reasoningTokens,
                // A provider that reported nothing must not be settled as if
                // it reported zero: the caller falls back to the reservation
                // rather than charging nothing for a call that happened.
                usageFromProvider:
                    typeof usage?.inputTokens === "number" ||
                    typeof usage?.outputTokens === "number",
            },
            responseId: generated.response?.id ?? null,
        });

        // Text rather than a structured-output object: the strict parser in
        // memoryExtractionOutput.ts is the contract, and routing every
        // provider through the same decoding path keeps one place where a
        // malformed answer is judged.
        return { text: generated.text };
    };
}
