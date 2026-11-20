import { RERANK_MODEL } from "./scoutMemoryExperiment";

// This endpoint accepts only the internally generated candidate list.
export async function rankSyntheticDocuments(
  key: string,
  query: string,
  documents: string[],
) {
  if (!key.trim()) throw Error("cohere_key_missing");
  const response = await fetch("https://api.cohere.com/v2/rerank", {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: RERANK_MODEL,
      query,
      documents,
      top_n: Math.min(3, documents.length),
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("cohere_http_" + response.status);
  }
  const data = await response.json();
  const indices: number[] = Array.isArray(data.results)
    ? data.results.map((r: { index?: unknown } | null) => r?.index)
    : [];
  if (
    indices.length !== Math.min(3, documents.length) ||
    new Set(indices).size !== indices.length ||
    indices.some((i) => !Number.isInteger(i) || i < 0 || i >= documents.length)
  )
    throw Error("cohere_invalid_ranking");
  const billed = data.meta?.billed_units?.input_tokens;
  return {
    indices,
    billedTokens:
      typeof billed === "number" && Number.isSafeInteger(billed) && billed >= 0
        ? billed
        : null,
  };
}
// Cohere Rerank 5 Fast public API list price, USD per million input tokens.
// https://cohere.com/blog/rerank-5 (checked 2026-11-12).
export function rankMicroUsd(tokens: number | null) {
  return tokens === null ? null : tokens * 0.02;
}
