/**
 * How a continuation's messages become one panel per selected model, and what
 * happens when the model selection changes.
 *
 * Policy: docs/policy/external-conversation-continuation.md §5.1, §8.3.
 *
 * Pure, and separate from the component, because these two decisions are the
 * ones that would be wrong quietly:
 *
 *   * a per-model history that included another model's answers would send one
 *     model the other's words as if they were its own, which is the same
 *     confusion the whole feature exists to avoid -- just inside the divider
 *     instead of across it;
 *   * a selection change at the cap that silently dropped a model would
 *     change what the next turn costs without anyone choosing it.
 */

export type ContinuationPanelMessage = {
    id: string;
    role: string;
    content: string;
    modelId?: string | null;
    status?: string;
};

export type ContinuationTurn<T extends ContinuationPanelMessage> = {
    /** Stable across re-renders: the user message's id, or the turn index. */
    key: string;
    /** The question, shown once. Null only for answers with no question above. */
    user: T | null;
    /** One entry per selected model, in selection order. */
    answers: { modelId: string; message: T | null }[];
};

/**
 * The transcript one model's request carries.
 *
 * The user's own turns belong to every model -- they asked all of them the
 * same question -- and an assistant turn belongs only to the model that wrote
 * it. Exactly the rule `/api/chat/preflight` prices with
 * (`belongsToModel`), so the quote and the request describe the same history.
 *
 * A user message that carries a `modelId` is one addressed to a single panel;
 * it stays out of the others.
 */
export const messagesForModel = <T extends ContinuationPanelMessage>(
    messages: readonly T[],
    modelId: string
): T[] =>
    messages.filter((message) =>
        message.role === "user"
            ? !message.modelId || message.modelId === modelId
            : message.role === "assistant" && message.modelId === modelId
    );

/**
 * The conversation as turns, each with one question and one panel per model.
 *
 * The question is rendered once and the answers beside each other, which is
 * what makes this a comparison rather than N transcripts. Panels follow the
 * *selection* order rather than the order answers arrived, so they do not
 * reshuffle between turns and a model added just now shows an empty panel
 * instead of not existing at all.
 *
 * An assistant message whose model is no longer selected is dropped from the
 * panels but not from the row: `orphanedAnswers` reports it so the screen can
 * say the answer is still stored rather than appearing to have deleted it.
 */
export const continuationTurns = <T extends ContinuationPanelMessage>(
    messages: readonly T[],
    selectedModels: readonly string[]
): { turns: ContinuationTurn<T>[]; orphanedAnswers: T[] } => {
    const turns: ContinuationTurn<T>[] = [];
    const orphanedAnswers: T[] = [];
    const selected = new Set(selectedModels);

    const startTurn = (key: string, user: T | null) => {
        const turn: ContinuationTurn<T> = {
            key,
            user,
            answers: selectedModels.map((modelId) => ({
                modelId,
                message: null,
            })),
        };
        turns.push(turn);
        return turn;
    };

    for (const [index, message] of messages.entries()) {
        if (message.role === "user" && !message.modelId) {
            startTurn(message.id || `turn-${index}`, message);
            continue;
        }
        if (message.role !== "assistant") continue;
        const modelId = message.modelId ?? "";
        if (!selected.has(modelId)) {
            orphanedAnswers.push(message);
            continue;
        }
        // An answer with no question above it (an imported-guest merge, a
        // deleted user row) still has to be readable, so it opens a turn of
        // its own rather than being dropped.
        const turn = turns.at(-1) ?? startTurn(`turn-${index}`, null);
        const slot = turn.answers.find((entry) => entry.modelId === modelId);
        if (slot && slot.message === null) {
            slot.message = message;
        } else {
            // A second answer from the same model in one turn: a re-run. It
            // gets its own row rather than overwriting the first, because the
            // first is what the user already read and paid for.
            const extra = startTurn(`turn-${index}`, null);
            const extraSlot = extra.answers.find(
                (entry) => entry.modelId === modelId
            );
            if (extraSlot) extraSlot.message = message;
        }
    }

    return { turns, orphanedAnswers };
};

export type ModelSelectionPlan =
    /** Not selected, and there is room. */
    | { kind: "add"; modelIds: string[] }
    /** Selected, and it is not the last one. */
    | { kind: "remove"; modelIds: string[] }
    /** Not selected and the cap is full: the owner picks what it replaces. */
    | { kind: "swap_required"; incomingModelId: string }
    /** Selected and alone: removing it would leave nothing to answer with. */
    | { kind: "refused"; reason: "last_model" };

/**
 * What toggling one model in the picker does.
 *
 * The cap is the plan's, and the server enforces it -- `PATCH
 * /api/conversations/[conversationId]` answers `modelLimitResponse()` and this
 * feature adds no limit of its own (§8.3). This function exists so the screen
 * asks the question *before* sending a change the server would refuse, and so
 * that at the cap the answer is a choice rather than a silent substitution.
 */
export const planModelSelectionChange = (input: {
    selected: readonly string[];
    modelId: string;
    maxModels: number;
}): ModelSelectionPlan => {
    const { selected, modelId, maxModels } = input;
    if (selected.includes(modelId)) {
        if (selected.length <= 1) return { kind: "refused", reason: "last_model" };
        return {
            kind: "remove",
            modelIds: selected.filter((id) => id !== modelId),
        };
    }
    if (selected.length >= Math.max(1, maxModels)) {
        return { kind: "swap_required", incomingModelId: modelId };
    }
    return { kind: "add", modelIds: [...selected, modelId] };
};

/** The list after the owner chose which model the incoming one replaces. */
export const applyModelSwap = (input: {
    selected: readonly string[];
    outgoingModelId: string;
    incomingModelId: string;
}): string[] =>
    input.selected.map((id) =>
        id === input.outgoingModelId ? input.incomingModelId : id
    );
