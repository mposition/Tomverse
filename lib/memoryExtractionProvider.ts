import "server-only";

import { generateText } from "ai";
import { getActiveAiModel } from "@/lib/activeAiModel";
import type { ExtractionModelAdapter } from "@/lib/memoryExtractionPipeline";
import type { AiModel } from "@/lib/models";

/**
 * The one place memory extraction actually calls a provider (policy §11).
 *
 * Isolated on purpose. Everything that decides *what* a chunk produces is pure
 * and provider-free (memoryExtractionPrompt / Output / Pipeline), and a test
 * asserts those modules import nothing that can reach a network. This module
 * is the single exception, so "can extraction spend money yet?" is answerable
 * by reading who imports this file.
 *
 * Two settings here are financial decisions rather than reliability
 * preferences:
 *
 * `maxRetries: 0` — the SDK's internal retry would issue several billed calls
 * behind one `await`, and the accounting is per attempt: one attempt row, one
 * operational reservation, one settlement. A retry the processor cannot see is
 * a charge it cannot reserve for. Retrying is the processor's job, where it
 * becomes a new attempt that reserves and settles again.
 *
 * `abortSignal` — the slice's chunk deadline, so a request that has not been
 * sent is never sent and one in flight is dropped. Best-effort by nature: once
 * the request has reached the provider, an abort does not promise the charge
 * goes away, which is exactly why the provider-call ledger records it anyway.
 */

export type ExtractionProviderResult = {
    usage: {
        inputTokens?: number;
        outputTokens?: number;
        /** False when the provider returned no usage metadata at all. */
        usageFromProvider: boolean;
    };
    /** Provider-side response id, for reconciling a charge we cannot confirm. */
    responseId: string | null;
};

export function createExtractionProviderAdapter(input: {
    model: AiModel;
    maxOutputTokens: number;
    signal: AbortSignal;
    /** Called before the request leaves, so the cost can be made durable. */
    onCallIssued: () => Promise<void> | void;
    onResult: (result: ExtractionProviderResult) => void;
}): ExtractionModelAdapter {
    return async ({ prompt }) => {
        // Checked immediately before the call rather than only at the top of
        // the handler: everything between the two takes time, and the cheapest
        // provider request is the one never made.
        input.signal.throwIfAborted();
        await input.onCallIssued();

        const generated = await generateText({
            model: getActiveAiModel(input.model),
            system: prompt.system,
            prompt: prompt.user,
            maxOutputTokens: input.maxOutputTokens,
            maxRetries: 0,
            abortSignal: input.signal,
        });

        const usage = generated.usage as
            | { inputTokens?: number; outputTokens?: number }
            | undefined;
        input.onResult({
            usage: {
                inputTokens: usage?.inputTokens,
                outputTokens: usage?.outputTokens,
                // A provider that reported nothing must not settle as if it
                // reported zero: the caller falls back to the conservative
                // reservation rather than recording a call that happened as
                // free.
                usageFromProvider:
                    typeof usage?.inputTokens === "number" ||
                    typeof usage?.outputTokens === "number",
            },
            responseId: generated.response?.id ?? null,
        });

        // Text rather than a structured-output object: the strict parser in
        // memoryExtractionOutput.ts is the contract, so every provider is
        // decoded through one place where a malformed answer is judged.
        return { text: generated.text };
    };
}
