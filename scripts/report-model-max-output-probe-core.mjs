/**
 * Asking a provider for the largest answer it will let a request ask for.
 *
 * ## What this measures, and what it was built to measure
 *
 * It was built to find context windows, by asking for an impossible number of
 * completion tokens on the theory that the refusal would name the window. Run
 * against staging on 2026-08-24 that theory turned out to be wrong, in a way
 * every provider agreed on:
 *
 *     openai      "supports at most 128000 completion tokens"
 *     qwen        "Range of max_tokens should be [1, 131072]"
 *     zhipu       "The max_tokens parameter is illegal.: 限制数值范围[1,131072]"
 *     perplexity  "max_tokens must be at most 128000"
 *
 * Every one names a `max_tokens` ceiling. None names a context window, because
 * the code path that validates `max_tokens` checks the output cap, not the
 * window. Nine models answered and the context-window question was left
 * exactly where it started.
 *
 * That is a different answer rather than a useless one.
 * docs/policy/tomverse-chat-context-window-register.yaml carries
 * `maxOutputTokens` beside `contextWindowTokens`, and its one verified row
 * describes that field as "the provider's absolute settable ceiling for
 * max_completion_tokens, not the value Tomverse sends". That is precisely what
 * a refusal here names. So the probe keeps its method and drops its old claim:
 * it measures the settable output ceiling, and says nothing about the window.
 *
 * Measuring the window needs the other half of the same idea -- an oversized
 * *input* rather than an oversized cap -- which has a different cost profile
 * and is not built here.
 *
 * ## What it does not do
 *
 * It does not decide. The register requires `sourceUrl`, `sourceTitle`,
 * `verifiedAt` and `verifiedBy` before a row may carry any number, and whether
 * an API refusal satisfies that is the register owner's call. Output is
 * evidence for a person.
 *
 * Pure: request shaping and message parsing only. The script does the I/O.
 */

/**
 * Large enough that no real ceiling contains it, small enough to stay an
 * integer every provider will parse rather than reject as malformed.
 */
export const IMPOSSIBLE_COMPLETION_TOKENS = 1_000_000_000;

/**
 * The two request shapes the models in question need.
 *
 * Anthropic, Google and MiniMax speak different dialects. None of the models
 * this exists for belongs to them, so rather than write three request builders
 * that nothing exercises, an unsupported protocol is refused by name -- a
 * wrong request would come back with a parse error that reads exactly like a
 * provider declining to state its ceiling.
 */
export function probeRequestFor({ provider, apiModel, baseUrl, protocol }) {
    if (protocol !== "native" && protocol !== "openai-compatible") {
        throw new Error(`Unsupported protocol "${protocol}" for ${provider}.`);
    }
    if (protocol === "native" && provider !== "openai") {
        throw new Error(
            `${provider} speaks its own dialect; this probe only builds OpenAI-shaped requests. ` +
                "Add a builder for it before probing, rather than sending a request it will reject for the wrong reason."
        );
    }
    // OpenAI renamed the field; the compatible providers kept the old one.
    const capField = provider === "openai" ? "max_completion_tokens" : "max_tokens";
    return {
        url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
        capField,
        body: {
            model: apiModel,
            messages: [{ role: "user", content: "hi" }],
            [capField]: IMPOSSIBLE_COMPLETION_TOKENS,
        },
    };
}

/**
 * A number, either plain or written with thousands separators.
 *
 * The grouped form is tried first and requires every group after the first to
 * be exactly three digits, with no digit following the match. Without that
 * rule a *range* reads as one number: `[1, 131072]` parsed as 1,131,072 in the
 * first version of this file, which turned four of the nine answers into
 * figures no provider had said. A range's low bound is one digit and its high
 * bound is six, so neither fits the grouping, and both fall through to the
 * plain alternative as the two separate numbers they are.
 */
const NUMBER_PATTERN = /\d{1,3}(?:[,_ ]\d{3})+(?!\d)|\d+/g;

/**
 * Every plausible token count in a provider's refusal, with the words around
 * it.
 *
 * Deliberately all of them, not a guess at which one is the ceiling. A refusal
 * names what was asked for as well as what is allowed, and a range names its
 * floor too. Picking one by position or by size would be this script inventing
 * the answer, which is the whole failure it exists to avoid. A person reads
 * the phrases and decides.
 *
 * `IMPOSSIBLE_COMPLETION_TOKENS` is dropped because it is this probe's own
 * input echoed back, never the provider's ceiling.
 */
export function parseLimitCandidates(message) {
    if (typeof message !== "string" || message.trim() === "") return [];
    const seen = new Set();
    const candidates = [];
    for (const match of message.matchAll(NUMBER_PATTERN)) {
        const raw = match[0];
        const tokens = Number(raw.replace(/[,_ ]/g, ""));
        if (!Number.isFinite(tokens)) continue;
        // Below this nothing is an output ceiling, and rejections are full of
        // small numbers -- status codes, range floors, retry counts.
        if (tokens < 1024) continue;
        if (tokens === IMPOSSIBLE_COMPLETION_TOKENS) continue;
        if (seen.has(tokens)) continue;
        seen.add(tokens);
        const start = Math.max(0, match.index - 60);
        const end = Math.min(message.length, match.index + raw.length + 60);
        candidates.push({
            tokens,
            phrase: message.slice(start, end).replace(/\s+/g, " ").trim(),
        });
    }
    return candidates.sort((left, right) => right.tokens - left.tokens);
}

/**
 * The message a provider's error body carries, wherever it keeps it.
 *
 * Returns null rather than a stringified object when nothing readable is
 * found: "the provider said nothing about a ceiling" and "this script could
 * not find where it said it" must not look the same in the output.
 */
export function errorMessageFrom(body) {
    if (typeof body === "string") return body.trim() || null;
    if (!body || typeof body !== "object") return null;
    const candidates = [
        body.error?.message,
        body.error?.metadata?.raw,
        body.message,
        body.detail?.message,
        body.detail,
        body.msg,
    ];
    for (const value of candidates) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}
