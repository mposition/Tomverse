/**
 * Does this request fit the model it is about to be sent to?
 *
 * Pure, and separate from the route, for two reasons.
 *
 * **The boundary is a contract, not an implementation detail.** A request that
 * exactly fills the window fits; one token more does not. That sentence is
 * cheap to write and easy to get wrong by one, and the cost of getting it
 * wrong is either a provider error the user pays for or a refusal they did not
 * deserve.
 *
 * **The Auto Router needs the same answer.** The routing policy requires the
 * context to be checked against the selected model immediately before dispatch,
 * and requires each fallback candidate to get its own check rather than
 * inheriting the primary's. Two copies of this comparison would disagree the
 * first time one of them learned something the other did not.
 *
 * What is deliberately NOT here: which token figure to pass. The caller owns
 * that, and the answer is "what the request really sends" — the reserved input
 * figure, which includes the tool overhead a provider-native search adds, not
 * the raw conversation estimate
 * (docs/ops/tomverse-chat-context-window-rollout.md).
 */

export type ChatContextWindowDecision =
    /** No declared window, so nothing was checked. See below. */
    | { kind: "unbounded" }
    | { kind: "within"; requiredTokens: number; limitTokens: number }
    | { kind: "exceeded"; requiredTokens: number; limitTokens: number };

/**
 * `unbounded` is a real outcome, not an absent one.
 *
 * A model with no declared context window is not clamped to a safe default —
 * it is not checked at all, and a long request reaches the provider unbounded.
 * Returning a named outcome rather than a bare `true` keeps that visible to
 * callers and gives the rollout's fail-closed stage a single place to change:
 * when every enabled model carries a verified window, this case becomes a
 * refusal instead of a pass.
 */
export function chatContextWindowDecision(input: {
    /** The model's declared window, or null/undefined when it declares none. */
    contextWindowTokens: number | null | undefined;
    /** Input tokens the request will really send, tool overhead included. */
    inputTokens: number;
    /** Output tokens the request may generate. */
    maxOutputTokens: number;
}): ChatContextWindowDecision {
    const limitTokens = input.contextWindowTokens;
    if (!limitTokens || limitTokens <= 0) return { kind: "unbounded" };
    // Input and output share one window: the model has to hold the prompt
    // while it writes the answer, so a request that fits only because its
    // answer was not counted does not fit.
    const requiredTokens = input.inputTokens + input.maxOutputTokens;
    return requiredTokens > limitTokens
        ? { kind: "exceeded", requiredTokens, limitTokens }
        : { kind: "within", requiredTokens, limitTokens };
}
