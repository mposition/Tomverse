/**
 * How a Chat turn whose provider stream reported done is recorded and settled.
 *
 * `app/api/chat/route.ts` used to decide this inline, from two inputs that
 * each said more than they meant:
 *
 * - **Any rejected completion promise counted as a broken stream.** The route
 *   awaits `response`, `usage`, `finishReason`, `rawFinishReason`, `content`
 *   and `providerMetadata` together, and the first rejection became
 *   `streamFailed`. A provider that finished with `stop` and whose metadata
 *   alone could not be read was then recorded as interrupted and settled as
 *   `cancelled` -- a finished answer, prorated. Only the finish reason says
 *   whether the stream finished, so only its own rejection counts now. A
 *   rejected `usage` is not a broken stream either: the settlement falls back
 *   to the estimate it always used for an answer whose usage nobody reported.
 * - **`tool-calls` counted as a finished answer.** A turn whose step budget ran
 *   out while the model was still calling a tool (an application-managed
 *   search, typically) ended with that finish reason and was stored `normal`
 *   and charged the flat completed rate, although the answer it was gathering
 *   material for was never written. It is now `incomplete` -- with no reason,
 *   because it is neither the output ceiling nor a provider fault, so the
 *   browser says only that the answer did not finish -- and settled the way a
 *   stop is, on what was used. Two exceptions: a turn whose tool stored a file
 *   (docs/policy/generated-artifacts.md section 8: the file is the answer),
 *   and Research Preview, whose accepted report is the answer.
 *
 * Pure: no database, no clock, no network.
 */

import {
    resolveChatCompletionOutcome,
    type ChatCompletionOutcome,
} from "@tomverse/chat-core";

/** What a settled turn is charged as, in `settleChatUsage`'s words. */
export type ChatTurnSettledAs = "completed" | "cancelled" | "empty";

/**
 * The completion status the Message, the attempt row and the stream trailer
 * carry.
 *
 * `finishReason` is `undefined` when its own promise rejected; that, and only
 * that, is a stream that failed to finish.
 */
export const resolveChatTurnCompletion = (input: {
    finishReason: string | undefined;
    rawFinishReason?: string;
    isResearchPreview: boolean;
    /** A file this turn's tool stored and the answer will keep. */
    filesDelivered: boolean;
}): ChatCompletionOutcome => {
    const resolved = resolveChatCompletionOutcome({
        finishReason: input.finishReason ?? "unknown",
        rawFinishReason: input.rawFinishReason,
        streamFailed: input.finishReason === undefined,
    });
    if (input.isResearchPreview) {
        // The accepted report is the answer, whatever the stream did after it.
        return resolved.incompleteReason === "interrupted"
            ? { status: "normal" }
            : resolved;
    }
    if (
        resolved.status === "normal" &&
        input.finishReason === "tool-calls" &&
        !input.filesDelivered
    ) {
        return { status: "incomplete" };
    }
    return resolved;
};

/**
 * What the turn is charged as, and whether the provider broke off.
 *
 * `providerInterrupted` is the one case that is provider health evidence; a
 * turn stopped by its own step budget is not, and is recorded as the
 * cancellation it is settled as.
 */
export const chatTurnSettlement = (input: {
    completion: ChatCompletionOutcome;
    /** Visible text, or a file that reached storage. */
    answerDelivered: boolean;
}): { settledAs: ChatTurnSettledAs; providerInterrupted: boolean } => {
    const providerInterrupted =
        input.answerDelivered &&
        input.completion.incompleteReason === "interrupted";
    const stoppedShort =
        input.answerDelivered &&
        input.completion.status === "incomplete" &&
        input.completion.incompleteReason === undefined;
    return {
        providerInterrupted,
        settledAs:
            providerInterrupted || stoppedShort
                ? "cancelled"
                : input.answerDelivered
                  ? "completed"
                  : "empty",
    };
};
