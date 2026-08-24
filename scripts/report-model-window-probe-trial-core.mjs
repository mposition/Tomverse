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
 * Pure: string inspection only. The script does the I/O.
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
 * - `accepted`          HTTP 200. The input fitted; the window is larger than
 *                       what was sent. Not a disproof, an undersized try.
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
    if (status === 200) return "accepted";
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
