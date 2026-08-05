// One walk over a Perplexity HTTP response body, shared by everything that
// needs to read it. The body is captured once (lib/perplexityUsageCapture.ts)
// and carries two independent things -- the billing usage block and the
// citation metadata the user sees -- so re-splitting and re-parsing the same
// megabyte of SSE per consumer would be pure waste. Callers pass a visitor
// and get every JSON payload the body contains, in order.

/**
 * Visits every JSON payload in a Perplexity response body.
 *
 * A non-streaming response is one JSON object. A streaming response is
 * Server-Sent Events, where each `data:` line is its own JSON object and the
 * interesting fields (usage, citations, search_results, finish_reason)
 * usually arrive on the last one. Malformed or partial `data:` payloads are
 * skipped rather than throwing -- a truncated capture must never cost a
 * caller the events that did arrive intact.
 */
export const forEachPerplexityResponsePayload = (
  responseBody: string,
  visit: (payload: unknown) => void
): void => {
  const trimmed = responseBody.trim();
  if (!trimmed) return;

  try {
    visit(JSON.parse(trimmed));
    return;
  } catch {
    // Streaming responses are Server-Sent Events rather than one JSON object.
  }

  for (const line of responseBody.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      visit(JSON.parse(data));
    } catch {
      // Ignore incomplete/non-JSON SSE fields and keep reading the rest.
    }
  }
};
