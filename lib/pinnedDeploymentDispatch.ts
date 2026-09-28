/**
 * The one inference call this path makes.
 *
 * `maxRetries` is fixed here. A caller cannot leave it unset, and this
 * function does not add tools or a multi-step stop condition. The ordinary
 * chat path does not call it.
 */

import { streamText, type LanguageModel } from "ai";

import { PINNED_INFERENCE_MAX_RETRIES } from "@/lib/pinnedDeploymentExecution";

export const streamPinnedInference = (input: {
    model: LanguageModel;
    messages: readonly {
        role: "system" | "user" | "assistant";
        content: string;
    }[];
    maxOutputTokens: number;
    onFinish?: (event: {
        usage: {
            inputTokens: number | undefined;
            outputTokens: number | undefined;
            inputTokenDetails?: {
                cacheWriteTokens?: number | undefined;
            };
        };
    }) => void | Promise<void>;
    onError?: (event: { error: unknown }) => void | Promise<void>;
}) => streamText({
    model: input.model,
    messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
    })),
    maxOutputTokens: input.maxOutputTokens,
    maxRetries: PINNED_INFERENCE_MAX_RETRIES,
    onFinish: input.onFinish,
    onError: input.onError,
});
