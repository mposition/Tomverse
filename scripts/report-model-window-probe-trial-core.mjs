/**
 * Reading what a provider's refusal was actually about.
 *
 * ## Why this exists
 *
 * The first version of the trial had no such step. It sent an oversized input,
 * took any non-200 as a refusal about that input, and printed a verdict on the
 * technique. Run against `perplexity/sonar` on 2026-08-24 the provider answered:
 *
 *     HTTP 400  "max_tokens must be at least 16"
 *
 * which is not about the input at all. The trial set `max_tokens: 1` to keep an
 * accidental acceptance down to one token, and 1 is below Perplexity's floor, so
 * the request died on cap validation before the 150,000-token input was ever
 * counted. The script read that as "the technique does not answer the question"
 * and told the operator to delete it. Nothing had been learned about the window,
 * and the recommendation was to throw the method away on the strength of it.
 *
 * A trial that cannot tell "my request was malformed" from "the provider will
 * not name its window" produces confident answers to a question it never asked.
 * Hence this module: classify first, conclude second.
 *
 * ## The rule, and how it fails
 *
 * Keyword matching over provider prose is not a decision procedure, and this
 * does not pretend otherwise. What it is built for is one asymmetry: every
 * misreading must land somewhere that asks a person to look, never somewhere
 * that condemns the technique.
 *
 * So `refusedOnLength` is the only verdict that permits a conclusion, and it is
 * the one requiring positive evidence -- the provider using length vocabulary.
 * A refusal this cannot place becomes `refusedForOtherReason`, which prints the
 * message and says the trial did not run. A provider phrasing a length refusal
 * in words not listed here is therefore under-read into "go look", which costs
 * one reading. The opposite mistake would cost the method.
 *
 * ## The success path is not a success
 *
 * HTTP 200 was, in the version after that one, printed as ACCEPTED with the
 * words "the input fitted, so the window is larger than this request". Run
 * against `perplexity/sonar` on 2026-08-24 with ~150,000 tokens of filler,
 * that is exactly what it said -- while Perplexity's own model page puts
 * sonar at 128K. A provider that silently truncates an over-long input
 * answers 200, and the old line read that as a window measurement.
 *
 * 200 means the provider answered. Nothing more. What the provider will tell
 * you is `usage.prompt_tokens`, and that is the number this module reads.
 * Even then the claim it supports is narrow: the provider counted, and
 * billed, that many input tokens. It is not evidence that the model attended
 * to every position of what was sent.
 *
 * Pure: string and object inspection only. The script does the I/O.
 */

/**
 * The field the trial sets, under both spellings. OpenAI renamed it; the
 * compatible providers kept the old name, and a refusal quotes whichever one it
 * validates.
 */
const CAP_FIELD_PATTERN = /max_tokens|max_completion_tokens/i;

/**
 * Vocabulary a provider reaches for when the *input* is the problem.
 *
 * `max_tokens` is deliberately absent: a message naming only that field is
 * about the cap, which is the case that started this file.
 *
 * "exceed" is not here on its own either. It was, in the first draft, and it
 * read "Rate limit exceeded for requests per minute." as a refusal about
 * length -- which would have printed the delete-this-script verdict for a
 * message that is only ever a reason to wait and ask again. So the word counts
 * only next to something being exceeded that is a length.
 */
const LENGTH_PATTERN = new RegExp(
    [
        "context (?:window|length|size)",
        "maximum context",
        "input (?:is |too |length|tokens?)",
        "prompt (?:is |too |length|tokens?)",
        "too (?:long|large|many tokens)",
        "token limit",
        "reduce the length",
        // "exceeds the maximum", "exceeded the allowed", "exceeds model"
        "exceed[a-z]*\\s+(?:the\\s+)?(?:maximum|model|context|input|prompt|token|allowed)",
        // "input exceeds", "context length exceeded"
        "(?:context|input|prompt|token)[a-z_ ]{0,20}exceed",
        "\u8bf7\u6c42\u8fc7\u957f",
        "\u4e0a\u4e0b\u6587",
    ].join("|"),
    "i"
);

/**
 * What a provider's answer to the trial was about.
 *
 * - `answered`          HTTP 200. The provider replied. That alone says
 *                       nothing about the window -- see classifyCountedInput.
 * - `refusedOnLength`   The refusal talks about input, prompt or context
 *                       length. This is the trial actually running, and the
 *                       only verdict from which the technique may be judged.
 * - `refusedOnCap`      The refusal names the cap field and no length term, so
 *                       it is about the value the trial sent for `max_tokens`,
 *                       not about the input. The trial did not run.
 * - `refusedForOtherReason`
 *                       Anything else -- auth, rate limits, an unknown model,
 *                       or length vocabulary this does not recognise. The trial
 *                       did not run, and a person should read the message.
 */
export function classifyTrialAnswer({ status, message }) {
    if (status === 200) return "answered";
    const text = typeof message === "string" ? message : "";
    // Length wins when a message carries both. "max_tokens plus your input
    // exceeds the context window" is a refusal about the window that happens to
    // name the field, and reading it as a malformed cap would discard the one
    // answer the trial is for.
    if (LENGTH_PATTERN.test(text)) return "refusedOnLength";
    if (CAP_FIELD_PATTERN.test(text)) return "refusedOnCap";
    return "refusedForOtherReason";
}

/**
 * The smallest completion cap the trial will send.
 *
 * Not a considered figure so much as the only floor a provider has ever stated
 * to us: Perplexity's "max_tokens must be at least 16". Others are unknown and
 * may be higher, which is why a cap refusal tells the operator to re-run with
 * the number the provider named rather than guessing upward in the script.
 *
 * It stays as small as it can because it is the blast radius of the outcome
 * nobody wants: if the input turns out to fit, the provider answers, and this
 * is the length of the answer that gets billed.
 */
export const DEFAULT_COMPLETION_CAP = 16;

/**
 * The share of the requested input a provider must have counted before the run
 * is described as having carried it.
 *
 * The figure is chosen against the case it exists to catch. A 128,000-token
 * window truncating a ~150,000-token request counts 85% of what was sent, so
 * any tolerance looser than that would report the truncation as a clean
 * carry -- the precise mistake this file is here to stop. 0.9 sits above it
 * with room left for the thing that is genuine slack: `--approx-input-tokens`
 * is a repetition count, not a token count, and no two tokenisers agree on
 * what a repeated word costs.
 */
export const COUNTED_INPUT_TOLERANCE = 0.9;

/**
 * The two facts a success body is worth reading for.
 *
 * `promptTokens` is null unless the provider gave a finite positive number:
 * a string, an object or a missing field must not be coerced into a count,
 * because "the provider did not say" and "the provider said a small number"
 * lead to opposite conclusions. `requestId` is for quoting in the register or
 * to the provider's support -- an observation nobody can look up again is
 * weaker evidence than one they can.
 */
export function readSuccessTelemetry(body) {
    if (!body || typeof body !== "object") return { promptTokens: null, requestId: null };
    const raw = body.usage?.prompt_tokens;
    const promptTokens =
        typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
    const id = body.id ?? body.request_id ?? body.requestId;
    return {
        promptTokens,
        requestId: typeof id === "string" && id.trim() ? id.trim() : null,
    };
}

/**
 * What the provider's own token count says about the input it received.
 *
 * Three readings, none of which is "the input fitted":
 *
 * - `INCONCLUSIVE`  the provider reported no usable count, so the run
 *                   produced no measurement at all.
 * - `POSSIBLE_TRUNCATION`
 *                   it counted materially less than was sent. Either it
 *                   truncated, or it pre-processed, or the filler tokenised
 *                   far shorter than one token a word. Which of those it is
 *                   cannot be told from here.
 * - `PROVIDER_COUNTED_APPROXIMATELY_REQUESTED_INPUT`
 *                   it counted about what was sent. This says the tokens were
 *                   counted and billed; it does not say the model read them,
 *                   and it does not name a window.
 */
export function classifyCountedInput({ promptTokens, approxRequestedTokens }) {
    if (typeof promptTokens !== "number" || !Number.isFinite(promptTokens) || promptTokens <= 0) {
        return "INCONCLUSIVE";
    }
    if (
        typeof approxRequestedTokens !== "number" ||
        !Number.isFinite(approxRequestedTokens) ||
        approxRequestedTokens <= 0
    ) {
        return "INCONCLUSIVE";
    }
    return promptTokens >= approxRequestedTokens * COUNTED_INPUT_TOLERANCE
        ? "PROVIDER_COUNTED_APPROXIMATELY_REQUESTED_INPUT"
        : "POSSIBLE_TRUNCATION";
}
