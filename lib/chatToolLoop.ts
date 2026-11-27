import "server-only";

import type { ModelMessage, ToolSet } from "ai";
import { estimatePromptTokens, estimateTokenBreakdown, toReservedInputTokens } from "@/lib/chatTokenEstimate";
import type { ProjectToolSource } from "@/lib/projectChatTools";
import type { WebSearchCitation } from "@/lib/webSearchCitations";

/**
 * The budget guard of an application tool loop, shared by the chat read tools.
 *
 * It is the same pricing contract the MCP and project tools use: the tool
 * definitions and a fixed result allowance are reserved for every pass before
 * anything is sent (`additionalToolInputTokens`, `toolInputPasses` in the chat
 * route), each later model call is measured against that reservation here, and
 * settlement uses the provider's per-call usage. A tool call itself has no
 * price: fetching a page or searching the user's own history costs no provider
 * money, so nothing is added to the credit tables. Only the tokens the model
 * reads and writes are charged, the way every other turn is.
 *
 * Because the shape is the project tools' shape, a turn that has these tools
 * plugs into the route's existing `projectTools` slot and every reservation,
 * step cap and `prepareStep` site already handles it.
 */

export class ChatToolLoopError extends Error {
    constructor(readonly code: "model_step_limit" | "model_input_budget" | "model_output_limit") {
        super(code);
        this.name = "ChatToolLoopError";
    }
}

/** What a tool set contributes to a turn: definitions, an allowance, its own step need. */
export type ChatToolPart = {
    tools: ToolSet;
    definitionTokens: number;
    /** A character bound is a conservative token bound for returned data. */
    resultInputAllowance: number;
    maxSteps: number;
};

export type ChatReadPart = ChatToolPart & {
    /** Pages read and past conversations used, as answer sources. */
    citations: () => WebSearchCitation[];
};

type StepUsage = { usage: { inputTokens?: number; outputTokens?: number } };

export type ChatToolLoop = ChatToolPart & {
    sources: () => ProjectToolSource[];
    observedInputTokens: () => number;
    setStepCap: (steps: number) => void;
    setBudget: (budget: { inputTokens: number; outputTokens: number; instructions: string }) => void;
    prepareStep: (options: {
        messages: ModelMessage[];
        steps: StepUsage[];
    }) => { maxOutputTokens: number; toolChoice?: "none" };
    /** Pages read and past conversations used by the read tools of this turn. */
    readCitations: () => WebSearchCitation[];
};

/**
 * What the chat route needs of a turn's application tool loop. The project tools
 * and a project-plus-read loop both satisfy it, so the route holds one slot.
 */
export type ChatToolSlot = Omit<ChatToolLoop, "readCitations">;

export const definitionTokensOf = (tools: ToolSet, rules: string) =>
    estimatePromptTokens(JSON.stringify(tools) + rules);

/**
 * One loop over the parts of a turn. `base` is the project tool set when the
 * conversation is inside a project: its tools, definitions, allowance and
 * sources are kept exactly as they were and the read tools are added to them.
 */
export function composeChatToolLoop(input: {
    signal: AbortSignal;
    base: (ChatToolPart & { sources: () => ProjectToolSource[] }) | null;
    read: ChatReadPart | null;
}): ChatToolLoop | null {
    const { base, read } = input;
    if (!base && !read) return null;
    const parts: ChatToolPart[] = [];
    if (base) parts.push(base);
    if (read) parts.push(read);
    const maxSteps = Math.max(...parts.map((part) => part.maxSteps));
    const definitionTokens = parts.reduce((sum, part) => sum + part.definitionTokens, 0);
    const resultInputAllowance = parts.reduce((sum, part) => sum + part.resultInputAllowance, 0);
    const tools: ToolSet = {};
    for (const part of parts) Object.assign(tools, part.tools);

    let stepCap = maxSteps;
    let outputCeiling = 0;
    let inputCeiling = 0;
    let cumulativeInput = 0;
    let instructions = "";
    return {
        tools,
        definitionTokens,
        resultInputAllowance,
        maxSteps,
        sources: () => base?.sources() ?? [],
        readCitations: () => read?.citations() ?? [],
        observedInputTokens: () => cumulativeInput,
        setStepCap: (steps) => {
            stepCap = Math.max(maxSteps, Math.floor(steps));
        },
        setBudget: (budget) => {
            inputCeiling = budget.inputTokens;
            outputCeiling = budget.outputTokens;
            instructions = budget.instructions;
        },
        prepareStep: ({ messages, steps }) => {
            input.signal.throwIfAborted();
            if (steps.length >= stepCap) throw new ChatToolLoopError("model_step_limit");
            const nextInput =
                Math.max(cumulativeInput, steps.reduce((sum, step) => sum + (step.usage.inputTokens || 0), 0)) +
                toReservedInputTokens(estimateTokenBreakdown(JSON.stringify(messages) + instructions)) +
                definitionTokens;
            if (nextInput > inputCeiling) throw new ChatToolLoopError("model_input_budget");
            // A step whose output the provider did not report is taken to have
            // spent the budget; counting it as zero would reopen the whole cap.
            const used = steps.some((step) => !Number.isSafeInteger(step.usage.outputTokens))
                ? outputCeiling
                : steps.reduce((sum, step) => sum + step.usage.outputTokens!, 0);
            if (used >= outputCeiling) throw new ChatToolLoopError("model_output_limit");
            cumulativeInput = nextInput;
            return {
                maxOutputTokens: outputCeiling - used,
                ...(steps.length === stepCap - 1 ? { toolChoice: "none" as const } : {}),
            };
        },
    };
}
