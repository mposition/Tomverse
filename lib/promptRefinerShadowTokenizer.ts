import "server-only";

import { getEncoding } from "js-tiktoken";

import { PROMPT_REFINER_MAX_INPUT_TOKENS } from "@/lib/promptRefinerExecutionContract";
import { promptRefinerModelMessages } from "@/lib/promptRefinerModelPrompt";
import {
    PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE,
    PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
    PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
    PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
} from "@/lib/promptRefinerShadowRunContract";
import type { PromptRefinerRequest } from "@/lib/promptRefinerSuggestion";

const encoding = getEncoding(PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING);

export type PromptRefinerShadowTokenCount = Readonly<{
    package: typeof PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE;
    packageVersion: typeof PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION;
    encoding: typeof PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING;
    contentTokens: number;
    framingTokens: typeof PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE;
    totalInputTokens: number;
    admitted: boolean;
}>;

/**
 * Counts the exact text bytes with the run contract's pinned BPE encoding.
 *
 * Chat/Responses wire framing is not represented by the two content strings,
 * so the separately reviewed fixed framing allowance remains additive. The
 * caller must perform this check before recording dispatch intent. Raw tokens
 * and message text are deliberately not returned.
 */
export const countPromptRefinerShadowInputTokens = (
    request: PromptRefinerRequest
): PromptRefinerShadowTokenCount => {
    const messages = promptRefinerModelMessages(request);
    const contentTokens = messages.reduce(
        (total, message) =>
            total + encoding.encode(message.content, [], []).length,
        0
    );
    const totalInputTokens =
        contentTokens + PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE;
    return Object.freeze({
        package: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
        packageVersion: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
        encoding: PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
        contentTokens,
        framingTokens:
            PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE,
        totalInputTokens,
        admitted: totalInputTokens <= PROMPT_REFINER_MAX_INPUT_TOKENS,
    });
};
