/** Cohere's SDK does not yet expose strict_tools. Keep it scoped to Research's report phase. */
export function createCohereResearchFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return (url, init) => {
    if (typeof init?.body !== "string") return fetchImpl(url, init);
    let body: unknown;
    try { body = JSON.parse(init.body); } catch { return fetchImpl(url, init); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return fetchImpl(url, init);
    const request = body as Record<string, unknown>;
    const reportPhase = Array.isArray(request.tools) && request.tools.some((tool) =>
      tool?.type === "function" && tool.function?.name === "submit_research_report");
    if (!reportPhase) return fetchImpl(url, init);
    if (request.response_format !== undefined) {
      throw new Error("COHERE_RESEARCH_RESPONSE_FORMAT_WITH_TOOLS");
    }
    return fetchImpl(url, { ...init, body: JSON.stringify({ ...request, strict_tools: true }) });
  };
}
