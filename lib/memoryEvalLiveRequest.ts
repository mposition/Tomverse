/**
 * The request the eval harness sends to a provider.
 *
 * docs/policy/external-conversation-import-and-memory.md §12.2.
 *
 * Extracted from the harness so it can be asserted without a provider. The
 * live path had no test and no smoke coverage -- the smoke adapter replaces
 * the call rather than shaping it -- so the first live run was the first time
 * this object had ever been built, and it was wrong in two ways at once.
 */

import type { ExtractionPrompt } from "@/lib/memoryExtractionPrompt";

export type LiveExtractionRequest = {
    instructions: string;
    messages: { role: "user"; content: string }[];
    maxOutputTokens: number;
};

export function buildLiveExtractionRequest(input: {
    prompt: ExtractionPrompt;
    /**
     * The model's output *capability*, from its pricing profile.
     *
     * Not `reservationOutputTokens`. AGENTS.md keeps those apart because one
     * is what the model can do and the other is what a request is allowed to
     * reserve, and the harness had been sending the reservation as the cap.
     * On a reasoning model that is how a run ends in empty answers: the
     * reasoning tokens spend the budget and nothing is left for the JSON,
     * which this repository has already watched happen once.
     */
    maxOutputTokens: number;
}): LiveExtractionRequest {
    return {
        // The system prompt travels in `instructions`, never as a message.
        // AI SDK 7 rejects a system role inside `messages` outright -- "System
        // messages are not allowed in the prompt or messages fields" -- and
        // the chat route has always passed it this way.
        instructions: input.prompt.system,
        messages: [{ role: "user", content: input.prompt.user }],
        maxOutputTokens: input.maxOutputTokens,
    };
}
