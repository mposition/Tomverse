/**
 * Asking a provider what its own context window is, by asking for too much.
 *
 * `report:model-context-window-evidence` reads what providers publish on their
 * model-list endpoints. For ten enabled models nothing is published there, and
 * docs/policy/tomverse-chat-context-window-register.yaml forbids the obvious
 * shortcuts: a window is "never estimated, inferred from a sibling model, or
 * copied from a provider's marketing page".
 *
 * There is one more party who knows the answer and will say it plainly. Ask a
 * provider for an impossible number of completion tokens and it refuses,
 * naming the limit it refused against:
 *
 *     "max_tokens is too large: 1000000000. This model supports at most 128000
 *      completion tokens"
 *
 * That is the limit in force at that moment, from the system that enforces it,
 * which is a stronger claim than a documentation page makes -- a page is
 * edited by hand and lags the model.
 *
 * ## What this deliberately does not do
 *
 * It does not decide anything. It reports what the provider said and the
 * numbers in it, and stops. Two reasons, and both are the register's:
 *
 *   - the register requires `sourceUrl`, `sourceTitle`, `verifiedAt` and
 *     `verifiedBy` before a row may carry a number, and whether an API
 *     rejection can satisfy that is a decision for the register's owner, not
 *     for this script;
 *   - `contextWindowIncludesOutput` "must be stated explicitly", and a refusal
 *     about *completion* tokens does not always say whether the figure it
 *     names is the whole window or the answer's share of it.
 *
 * So the output is evidence for a person, in the same sense the evidence
 * report is. Nothing here writes to lib/models.ts or to the register.
 *
 * Pure: request shaping and message parsing only. The script does the I/O.
 */

/**
 * Large enough that no real window contains it, small enough to stay an
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
 * provider declining to state its limit.
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
 * Every plausible token count in a provider's refusal, with the words around
 * it.
 *
 * Deliberately all of them, not a guess at which one is the window. A refusal
 * often names two numbers -- what was asked for and what is allowed -- and
 * some name a third. Picking one by position or by size would be this script
 * inventing the answer, which is the whole failure it exists to avoid. A
 * person reads the phrases and decides.
 *
 * `IMPOSSIBLE_COMPLETION_TOKENS` is dropped because it is this probe's own
 * input echoed back, never the provider's limit.
 */
export function parseLimitCandidates(message) {
    if (typeof message !== "string" || message.trim() === "") return [];
    const seen = new Set();
    const candidates = [];
    // Digits, optionally with thousands separators, and the surrounding words.
    const pattern = /(\d[\d,_ ]{2,})/g;
    for (const match of message.matchAll(pattern)) {
        const raw = match[1];
        const tokens = Number(raw.replace(/[,_ ]/g, ""));
        if (!Number.isFinite(tokens)) continue;
        // Below this nothing is a context window, and rejections are full of
        // small numbers -- status codes, retry counts, field indices.
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
 * found: "the provider said nothing about a limit" and "this script could not
 * find where it said it" must not look the same in the output.
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
