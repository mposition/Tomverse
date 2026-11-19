import {
    perplexitySplitHintsFit,
    perplexitySplitQuestions,
    type PerplexitySplitHints,
} from "@/lib/externalImportAdapters/perplexity";

/**
 * Asks the import route how to split a Perplexity export where the file
 * cannot tell (lib/perplexitySplitHints.ts). Runs in the import worker.
 *
 * Sends only the excerpts `perplexitySplitQuestions` picks, never the file.
 * Any refusal, timeout or answer that does not fit the questions yields
 * undefined, and the adapter keeps the file's own split: the hints can make
 * the split better, never make the import fail.
 */
export const PERPLEXITY_SPLIT_ROUTE = "/api/imports/external/perplexity-split";
const TIMEOUT_MS = 25_000;

export async function fetchPerplexitySplitHints(
    text: string,
    fetchImpl: typeof fetch = fetch
): Promise<PerplexitySplitHints | undefined> {
    const questions = perplexitySplitQuestions(text);
    if (!questions) return undefined;
    try {
        const response = await fetchImpl(PERPLEXITY_SPLIT_ROUTE, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(questions),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) return undefined;
        const body = (await response.json()) as { hints?: unknown };
        return perplexitySplitHintsFit(questions, body?.hints) ? body.hints : undefined;
    } catch {
        return undefined;
    }
}
