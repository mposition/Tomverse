import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { getActiveAiModel } from "@/lib/activeAiModel";
import type { ExtractionModelAdapter } from "@/lib/memoryExtractionPipeline";
import type { AiModel } from "@/lib/models";
import { MEMORY_EXTRACTION_OUTPUT_SCHEMA } from "@/lib/memoryExtractionPrompt";

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
            // The schema goes to the provider rather than being described in
            // prose. v1 told the model to return JSON "matching the requested
            // schema" and requested no schema, so the model guessed the field
            // names and the type of `confidence`; the strict parser rejected
            // every answer it produced.
            output: Output.object({
                // `as const` keeps the schema's literal types, which the
                // fingerprint test reads; `JSONSchema7` wants them mutable.
                // The object is the same either way, and losing the literals
                // to satisfy a parameter would cost the test its precision.
                schema: jsonSchema(
                    MEMORY_EXTRACTION_OUTPUT_SCHEMA as unknown as JSONSchema7
                ),
                name: "memory_extraction_candidates",
            }),
            providerOptions: {
                // Strict mode makes the provider enforce the schema instead of
                // aiming at it. Ignored by providers that do not have it; the
                // schema is written to satisfy it either way.
                openai: { strictJsonSchema: true },
                // No Anthropic `cacheControl` here, deliberately: extraction
                // runs once per conversation over that conversation's own
                // transcript, so a second run is a different prefix and a
                // marker would buy a 1.25x write nothing reads back. Recorded
                // as `memory_extraction` in
                // lib/anthropicPromptCaching.ts.
            },
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

        // The object as the provider returned it, never re-serialised to text:
        // a round trip through JSON.stringify would invent a formatting the
        // model did not choose and hide a shape the parser should judge.
        //
        // There is no fall back to `generated.text`. A refusal, a schema
        // violation or a truncated answer must be recorded as the failure it
        // is; reading the text beside it would turn "the provider would not
        // produce this shape" into a parse error somewhere further down, and
        // docs/policy/external-conversation-import-and-memory.md §12.2 scores failures
        // rather than reshaping them.
        //
        // Structured output does not replace the strict parser. It constrains
        // the shape; `memoryExtractionOutput.ts` still binds every evidence
        // label to a real message, normalises statements, enforces lengths,
        // dates and kinds, and feeds the deterministic validator
        // (docs/policy/external-conversation-import-and-memory.md §8.4).
        return { output: generated.output };
    };
}
