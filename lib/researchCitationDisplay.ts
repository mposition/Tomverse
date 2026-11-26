/**
 * The sources a separate list under an answer should still show.
 *
 * A Research Preview report already ends with its own numbered source list
 * inside the answer body. The body is what sharing, TXT export and follow-up
 * Chat read, so the sources stay there and the list under the answer drops
 * only the URLs that the body already lists. A source that another tool added
 * to the same turn is not in the body, so the list still shows it. An answer
 * with no Research metadata keeps every citation.
 *
 * Shared by the web, desktop and mobile renderers so the three cannot drift.
 */
export function citationsOutsideResearchBody<T extends { url: string }>(
  citations: readonly T[] | null | undefined,
  research: { sources?: readonly { url: string }[] } | null | undefined,
): T[] {
  const list = citations ?? [];
  const inBody = new Set((research?.sources ?? []).map((source) => source.url));
  return inBody.size ? list.filter((citation) => !inBody.has(citation.url)) : [...list];
}
