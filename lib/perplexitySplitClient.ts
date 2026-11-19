import {
    perplexitySplitHintsFit,
    type PerplexitySplitHints,
    type PerplexitySplitQuestions,
} from "@/lib/externalImportAdapters/perplexity";

/**
 * Asks the import route how to split a Perplexity export where the file
 * cannot tell (lib/perplexitySplitHints.ts).
 *
 * The import worker does not call the network itself: it posts the questions
 * to the page that started it, and the page asks with its own credentials --
 * a same-origin fetch on the web, the native transport in the iOS app, whose
 * worker origin is not the Tomverse server. Both go through this function.
 *
 * Any refusal, timeout or answer that does not fit the questions yields null,
 * and the adapter keeps the file's own split: the hints can make the split
 * better, never make the import fail.
 */
export const PERPLEXITY_SPLIT_ROUTE = "/api/imports/external/perplexity-split";
export const PERPLEXITY_SPLIT_TIMEOUT_MS = 25_000;

/** Sends the questions and resolves to the response body, or throws. */
export type PerplexitySplitSend = (questions: PerplexitySplitQuestions) => Promise<unknown>;

export async function askPerplexitySplitHints(
    questions: PerplexitySplitQuestions,
    send: PerplexitySplitSend
): Promise<PerplexitySplitHints | null> {
    try {
        const body = (await send(questions)) as { hints?: unknown } | null;
        return perplexitySplitHintsFit(questions, body?.hints) ? body!.hints as PerplexitySplitHints : null;
    } catch {
        return null;
    }
}

/** The web page's sender: same-origin, session cookie, bounded wait. */
export const sameOriginPerplexitySplitSend =
    (fetchImpl: typeof fetch = fetch): PerplexitySplitSend =>
    async (questions) => {
        const response = await fetchImpl(PERPLEXITY_SPLIT_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(questions),
            signal: AbortSignal.timeout(PERPLEXITY_SPLIT_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`perplexity split ${response.status}`);
        return response.json();
    };
