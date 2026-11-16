/** Opaque client attempt ownership. No question or reference content is retained. */
export type ReviewHandoffAttempt = { assistantMessageId: string; idempotencyKey: string };

export function reviewHandoffAttemptFor(
  previous: ReviewHandoffAttempt | undefined,
  assistantMessageId: string,
  createKey: () => string,
): ReviewHandoffAttempt {
  return previous?.assistantMessageId === assistantMessageId
    ? previous
    : { assistantMessageId, idempotencyKey: createKey() };
}

export type ReviewHandoffPreview = {
  status: "available" | "unavailable";
  sourceMode: "recorded" | "legacy";
  nativeTurnCount: number;
  nativeOmittedCount: number;
  sourceTurnCount: number;
  sourceOmittedCount: number;
  attachmentsSupported: false;
};

export function parseReviewHandoffPreview(value: unknown): ReviewHandoffPreview | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if ((row.sourceMode !== "recorded" && row.sourceMode !== "legacy") || row.attachmentsSupported !== false) return null;
  if (row.status !== undefined && row.status !== "available" && row.status !== "unavailable") return null;
  for (const key of ["nativeTurnCount", "nativeOmittedCount", "sourceTurnCount", "sourceOmittedCount"]) {
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0) return null;
  }
  return {
    status: row.status === "unavailable" ? "unavailable" : "available",
    sourceMode: row.sourceMode, nativeTurnCount: row.nativeTurnCount as number,
    nativeOmittedCount: row.nativeOmittedCount as number, sourceTurnCount: row.sourceTurnCount as number,
    sourceOmittedCount: row.sourceOmittedCount as number, attachmentsSupported: false,
  };
}

export const reviewHandoffDraftEndpoint = (conversationId: string) =>
  `/api/conversations/${encodeURIComponent(conversationId)}/continuation/review-handoff/draft`;

/** Revalidate references before a single-model send consumes its editable draft. */
export async function reviewHandoffReferencesAvailable(conversationId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(`/api/conversations/${encodeURIComponent(conversationId)}/continuation?offset=end&limit=1`, { cache: "no-store" });
    const body = await response.json().catch(() => null);
    return response.ok && body?.reviewHandoff?.status === "available" &&
      parseReviewHandoffPreview(body.reviewHandoff)?.status === "available";
  } catch {
    return false;
  }
}
