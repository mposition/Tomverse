type ScopePreviewReply = { status: number; body: unknown };

export type ScopePreviewDecision =
  | { kind: "checked"; canonicalScopeJson: string }
  | { kind: "error"; code: string };

/** A malformed or partial reply cannot be presented as a checked source. */
export function classifySourceScopePreview(
  reply: ScopePreviewReply,
  ideaId: string,
): ScopePreviewDecision {
  const body = reply.body && typeof reply.body === "object" && !Array.isArray(reply.body)
    ? reply.body as Record<string, unknown> : null;
  if (reply.status === 200 && body?.ideaId === ideaId && body.fileCount === 1 &&
      body.collectionVerified === false && body.transferAuthorized === false &&
      typeof body.canonicalScopeJson === "string" && body.canonicalScopeJson.length > 0) {
    return { kind: "checked", canonicalScopeJson: body.canonicalScopeJson };
  }
  return { kind: "error", code: typeof body?.error === "string" ? body.error : "preview_unavailable" };
}
