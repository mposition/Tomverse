// Raw internal USD must not reach a user-facing response.
//
// `publicChatErrorDetails` enforces that by stripping keys that begin with
// `internal`, which makes the *spelling of the key* the whole mechanism. A
// field carrying provider spend under any other name is not stripped, is not
// flagged, and ships in the response body -- and nothing noticed, because the
// stripper is doing exactly what it was written to do.
//
// That is how `CREDIT_COST_ALLOWANCE_INSUFFICIENT` came to send
// `requiredCostMicroUsd` and `availableCostMicroUsd` to the browser from two
// throw sites, eight lines from a rejection whose comment says raw internal USD
// is "deliberately" kept out of end-user responses.
//
// So this reads every `new ChatAccessError(...)` and requires that any
// micro-USD field in its details bag is spelled the way the stripper can see.
//
// Pure: the caller supplies the sources, the scan is testable without a repo.

/** Balanced-paren extraction of each `new ChatAccessError(` argument list. */
export function chatAccessErrorArguments(source) {
    const bodies = [];
    const marker = "new ChatAccessError(";
    let from = 0;
    for (;;) {
        const start = source.indexOf(marker, from);
        if (start === -1) return bodies;
        let index = start + marker.length;
        let depth = 1;
        while (depth > 0 && index < source.length) {
            const char = source[index];
            const next = source[index + 1];
            // Comments first. An apostrophe in prose -- "the caller's event" --
            // is not a string delimiter, and treating it as one runs the scan
            // past the closing paren and into unrelated code. That produced a
            // false positive against a details bag whose fields were correctly
            // prefixed, which is a worse failure than missing one: a check
            // nobody trusts gets silenced.
            if (char === "/" && next === "/") {
                while (index < source.length && source[index] !== "\n") index += 1;
                continue;
            }
            if (char === "/" && next === "*") {
                const end = source.indexOf("*/", index + 2);
                index = end === -1 ? source.length : end + 2;
                continue;
            }
            if (char === '"' || char === "'" || char === "`") {
                const quote = char;
                index += 1;
                while (index < source.length && source[index] !== quote) {
                    index += source[index] === "\\" ? 2 : 1;
                }
            } else if (char === "(") depth += 1;
            else if (char === ")") depth -= 1;
            index += 1;
        }
        bodies.push({
            body: source.slice(start + marker.length, index - 1),
            line: source.slice(0, start).split("\n").length,
        });
        from = index;
    }
}

const COST_FIELD = /(\w*(?:MicroUsd|MicroUSD))\s*:/g;

/**
 * Fields that are a *user's* money rather than Tomverse's cost basis.
 *
 * Credits are the entitlement the user holds and are shown to them on purpose;
 * micro-USD is what Tomverse pays a provider. Only the second is internal, so
 * only the second is what this looks for -- an allowlist here would invite
 * exactly the "this one is fine" reasoning that produced the leak.
 */
export function auditErrorDetailCostFields(files) {
    const failures = [];
    for (const { path, source } of files) {
        for (const { body, line } of chatAccessErrorArguments(source)) {
            for (const [, field] of body.matchAll(COST_FIELD)) {
                if (field.startsWith("internal")) continue;
                failures.push(
                    `${path}:${line} sends \`${field}\` in a ChatAccessError ` +
                        `details bag. Raw internal USD must be prefixed ` +
                        `\`internal\` so publicChatErrorDetails strips it.`
                );
            }
        }
    }
    return { failures };
}
