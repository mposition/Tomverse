import { estimatePromptTokens, WEB_SEARCH_INPUT_TOKEN_OVERHEAD } from "@/lib/chatTokenEstimate";

/**
 * The application tool loop (generated artifacts, app-managed search) on a
 * long-context turn: every step re-sends the whole prompt -- plus whatever the
 * tools returned -- and may write up to the request's output cap, but the turn
 * was reserved for a fixed number of calls and one output budget, and
 * settlement never charges past the reservation (reviews
 * r-20261118-102103-16e00a, r-20261118-105614-1047a3, r-20261118-111248-a62933).
 *
 * As the MCP loop does (lib/mcpConnectorChatTool.ts):
 *  - each step's prompt is measured from the messages it will actually send,
 *    tool results included, and a step that would not fit the input
 *    reservation or the context window is never sent;
 *  - the steps share one output budget, each writing only what the earlier
 *    ones left, capped by the room the window leaves after its prompt;
 *  - a step answers without tools when it is the last reserved call, when the
 *    output is spent, or when the reservation would not hold another step of
 *    the same size plus a tool result;
 *  - a finished step whose usage the provider did not report is counted at
 *    the most it was allowed -- its measured prompt and its whole output cap --
 *    so an unmeasured step never reopens the budget.
 */

type StepUsage = {
    usage: { inputTokens?: number; outputTokens?: number };
};

export type LongContextToolLoopLimits = {
    /** The output budget the reservation holds across the whole loop. */
    maxOutputTokens: number;
    /** The input tokens the reservation holds across the whole loop. */
    inputTokens: number;
    /** The first call's prompt, as the reservation sized one call. */
    firstPromptTokens: number;
    /** The provider calls the reservation holds. */
    callCap: number;
    /** The model's context window: prompt and answer together. */
    contextWindowTokens: number;
};

export type LongContextToolLoopStep = {
    maxOutputTokens: number;
    toolChoice?: "none";
};

/** Raised before a step that would not fit; that call is never sent. */
export class LongContextToolLoopLimitError extends Error {
    constructor(readonly reason: "input_budget" | "context_window" | "output_budget") {
        super(`long-context tool loop: ${reason}`);
        this.name = "LongContextToolLoopLimitError";
    }
}

/** The least room a later step keeps in the window to write its answer. */
export const NEXT_ANSWER_ROOM_TOKENS = 4_096;

const counted = (value: number | undefined): value is number =>
    Number.isSafeInteger(value) && value! >= 0;

export type LongContextToolLoop = {
    /** For the SDK's `prepareStep`. */
    prepareStep: (options: {
        steps: readonly StepUsage[];
        messages: unknown;
    }) => LongContextToolLoopStep;
    /**
     * For the SDK's `stopWhen`: the reserved output is spent, so another call
     * could only re-send the prompt for an answer it has no room to write.
     */
    outputSpent: (options: { steps: readonly StepUsage[] }) => boolean;
    /** What the finished steps used, unreported ones at their allowance. */
    spent: () => { inputTokens: number; outputTokens: number; steps: number };
};

export const longContextToolLoopStep = (
    limits: LongContextToolLoopLimits
): LongContextToolLoop => {
    // Per step, what this loop allowed it: its prompt and its output cap.
    const allowed: Array<{ prompt: number; outputCap: number }> = [];
    let firstMessagesTokens = 0;
    let lastTally = { inputTokens: 0, outputTokens: 0, steps: 0 };
    const tally = (steps: readonly StepUsage[]) => {
        let inputTokens = 0;
        let outputTokens = 0;
        steps.forEach((step, index) => {
            const granted = allowed.at(index);
            inputTokens += counted(step.usage.inputTokens)
                ? step.usage.inputTokens
                : granted?.prompt ?? limits.firstPromptTokens;
            outputTokens += counted(step.usage.outputTokens)
                ? step.usage.outputTokens
                : granted?.outputCap ?? limits.maxOutputTokens;
        });
        lastTally = { inputTokens, outputTokens, steps: steps.length };
        return lastTally;
    };
    const prepareStep = ({
        steps,
        messages,
    }: {
        steps: readonly StepUsage[];
        messages: unknown;
    }): LongContextToolLoopStep => {
        const messagesTokens = estimatePromptTokens(JSON.stringify(messages ?? []));
        const { inputTokens: usedInput, outputTokens: usedOutput } = tally(steps);
        let largestGrowth = 0;
        let prompt: number;
        if (steps.length === 0) {
            firstMessagesTokens = messagesTokens;
            prompt = limits.firstPromptTokens;
        } else {
            const first = steps.at(0)!;
            const firstPrompt = counted(first.usage.inputTokens)
                ? first.usage.inputTokens
                : limits.firstPromptTokens;
            // The first prompt as the provider counted it, plus everything the
            // messages gained since: answers and tool results.
            prompt = firstPrompt + Math.max(0, messagesTokens - firstMessagesTokens);
            for (const [index, granted] of allowed.entries()) {
                const next = allowed.at(index + 1)?.prompt ?? prompt;
                largestGrowth = Math.max(largestGrowth, next - granted.prompt);
            }
            if (usedInput + prompt > limits.inputTokens) {
                throw new LongContextToolLoopLimitError("input_budget");
            }
            if (prompt >= limits.contextWindowTokens) {
                throw new LongContextToolLoopLimitError("context_window");
            }
        }
        const remainingOutput = limits.maxOutputTokens - usedOutput;
        // Never reached with nothing left to write: `outputSpent` ends the
        // loop first. Defensive only.
        if (steps.length > 0 && remainingOutput <= 0) {
            throw new LongContextToolLoopLimitError("output_budget");
        }
        const answerCap = Math.max(
            1,
            Math.min(remainingOutput, limits.contextWindowTokens - prompt)
        );
        // A step that may call a tool leaves room for the step after it: its
        // own output is held to what keeps that next prompt -- this one, this
        // answer and a tool result at least as large as the largest growth so
        // far (never below the search allowance) -- inside the window with
        // room to answer, and inside the input reservation.
        const toolResult = Math.max(largestGrowth, WEB_SEARCH_INPUT_TOKEN_OVERHEAD);
        const toolStepCap = Math.min(
            answerCap,
            limits.contextWindowTokens - prompt - toolResult - NEXT_ANSWER_ROOM_TOKENS,
            limits.inputTokens - usedInput - 2 * prompt - toolResult
        );
        const finalCall =
            steps.length + 1 >= limits.callCap ||
            remainingOutput <= 0 ||
            toolStepCap < 1;
        const outputCap = finalCall ? answerCap : toolStepCap;
        allowed.splice(steps.length, allowed.length, { prompt, outputCap });
        return {
            maxOutputTokens: outputCap,
            ...(finalCall ? { toolChoice: "none" as const } : {}),
        };
    };
    return {
        prepareStep,
        outputSpent: ({ steps }) => tally(steps).outputTokens >= limits.maxOutputTokens,
        spent: () => lastTally,
    };
};
