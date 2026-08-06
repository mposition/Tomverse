/**
 * How many output tokens may this request ask for, given what it is sending?
 *
 * Pure, and separate from the route, for three reasons.
 *
 * **A capability is not a request budget.** A model's maximum output is what it
 * *can* produce; a request's output cap is what this turn asks for. Kimi K3 is
 * the case that proved they must not be one number: its settable ceiling is its
 * entire 1,048,576-token context window, and Moonshot rejects a request whose
 * input plus output cap exceeds that window — so asking for the ceiling every
 * time refused every request at every input size, including a one-token one.
 * Fitting the cap to the room that is actually left is the difference between
 * a usable model and an unusable one.
 *
 * **The boundary is a contract.** A request that exactly fills the window fits;
 * one token more does not. That sentence is cheap to write and easy to get
 * wrong by one, and the cost is either a provider error the user pays for or a
 * refusal they did not deserve.
 *
 * **The Auto Router needs the same answer.** The routing policy requires the
 * context to be checked against the selected model immediately before dispatch,
 * and each fallback candidate to get its own check rather than inheriting the
 * primary's. Two copies of this arithmetic would disagree the first time one of
 * them learned something.
 *
 * What is deliberately NOT here: which input figure to pass. The caller owns
 * that, and the answer is what the request really sends — the reserved input
 * figure, which includes the tool overhead a provider-native search adds, not
 * the raw conversation estimate
 * (docs/ops/tomverse-chat-context-window-rollout.md).
 */

export type ChatOutputBudget =
    /** No declared window, so nothing was checked. See below. */
    | { kind: "unbounded"; outputTokens: number }
    /** Fits, with this much output room. */
    | { kind: "fitted"; outputTokens: number; limitTokens: number }
    /** The input alone leaves no room to answer in. */
    | { kind: "exceeded"; limitTokens: number; reservedInputTokens: number };

/**
 * `unbounded` is a real outcome, not an absent one.
 *
 * A model with no declared context window is not clamped to a safe default —
 * it is not checked at all, and a long request reaches the provider unbounded.
 * Naming the outcome keeps that visible to callers and gives the rollout's
 * fail-closed stage a single place to change: when every enabled model carries
 * a verified window, this case becomes a refusal instead of a pass.
 */
export function fitChatOutputToContextWindow(input: {
    /** The model's declared window, or null/undefined when it declares none. */
    contextWindowTokens: number | null | undefined;
    /** Input tokens the request will really send, tool overhead included. */
    reservedInputTokens: number;
    /** The output cap this application asks for. */
    requestOutputCapTokens: number;
    /** The provider's absolute settable ceiling, where verified. */
    providerMaxOutputTokens?: number | null;
}): ChatOutputBudget {
    // The provider's ceiling only ever lowers what we ask for. An unverified
    // ceiling is unknown, not unlimited-by-assumption, so it is simply absent
    // from the minimum rather than standing in as Infinity.
    const capped =
        input.providerMaxOutputTokens && input.providerMaxOutputTokens > 0
            ? Math.min(input.requestOutputCapTokens, input.providerMaxOutputTokens)
            : input.requestOutputCapTokens;
    const requested = Math.max(0, Math.floor(capped));

    const limitTokens = input.contextWindowTokens;
    if (!limitTokens || limitTokens <= 0) {
        return { kind: "unbounded", outputTokens: requested };
    }

    // Input and output share one window: the model has to hold the prompt
    // while it writes the answer. The room left is the whole of the budget the
    // answer can occupy, so a request is refused only when there is none —
    // not merely because the model's own maximum would not have fitted.
    const remaining = limitTokens - input.reservedInputTokens;
    if (remaining <= 0) {
        return {
            kind: "exceeded",
            limitTokens,
            reservedInputTokens: input.reservedInputTokens,
        };
    }
    return {
        kind: "fitted",
        outputTokens: Math.min(requested, remaining),
        limitTokens,
    };
}
