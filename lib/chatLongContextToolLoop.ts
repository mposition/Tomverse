/**
 * The application tool loop (generated artifacts, app-managed search) on a
 * long-context turn: every step re-sends the whole prompt and may write up to
 * the request's output cap, but the turn was reserved for a fixed number of
 * calls and one output budget, and settlement never charges past the
 * reservation (reviews r-20261118-102103-16e00a and r-20261118-105614-1047a3).
 *
 * So, as the MCP loop already does, the steps share one output budget -- each
 * step may write only what the earlier ones left -- and the loop is told to
 * answer (no further tool calls) on the last reserved call, or as soon as the
 * input budget would not hold another full step.
 */

type StepUsage = {
    usage: { inputTokens?: number; outputTokens?: number };
};

export type LongContextToolLoopLimits = {
    /** The output budget the reservation holds across the whole loop. */
    maxOutputTokens: number;
    /** The input tokens the reservation holds across the whole loop. */
    inputTokens: number;
    /** The provider calls the reservation holds. */
    callCap: number;
};

export type LongContextToolLoopStep = {
    maxOutputTokens: number;
    toolChoice?: "none";
};

const count = (value: number | undefined) =>
    Number.isFinite(value) && value! > 0 ? Math.trunc(value!) : 0;

export const longContextToolLoopStep =
    (limits: LongContextToolLoopLimits) =>
    ({ steps }: { steps: readonly StepUsage[] }): LongContextToolLoopStep => {
        let usedInput = 0;
        let usedOutput = 0;
        let lastInput = 0;
        let lastOutput = 0;
        for (const step of steps) {
            lastInput = count(step.usage.inputTokens);
            lastOutput = count(step.usage.outputTokens);
            usedInput += lastInput;
            usedOutput += lastOutput;
        }
        const remainingOutput = limits.maxOutputTokens - usedOutput;
        // The next prompt is at least the last one plus what it produced.
        const nextPrompt = lastInput + lastOutput;
        const finalCall =
            steps.length + 1 >= limits.callCap ||
            remainingOutput <= 0 ||
            usedInput + 2 * nextPrompt > limits.inputTokens;
        return {
            maxOutputTokens: Math.max(1, remainingOutput),
            ...(finalCall ? { toolChoice: "none" as const } : {}),
        };
    };
