type ScopePreviewReply = { status: number; body: unknown };

export type ScopePreviewDecision =
  | { kind: "checked"; canonicalScopeJson: string }
  | { kind: "error"; code: string };

const oneRepositoryFile = (raw: string): boolean => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const scope = value as Record<string, unknown>;
    if (scope.version !== 1 || !Array.isArray(scope.sources) || scope.sources.length !== 1) return false;
    const file = scope.sources[0];
    return !!file && typeof file === "object" && !Array.isArray(file) &&
      file.kind === "repository_file" && typeof file.repository === "string" &&
      typeof file.commitSha === "string" && typeof file.path === "string";
  } catch {
    return false;
  }
};

/** A malformed or partial reply cannot be presented as a checked source. */
export function classifySourceScopePreview(
  reply: ScopePreviewReply,
  ideaId: string,
): ScopePreviewDecision {
  const body = reply.body && typeof reply.body === "object" && !Array.isArray(reply.body)
    ? reply.body as Record<string, unknown> : null;
  if (reply.status === 200 && body?.ideaId === ideaId && body.fileCount === 1 &&
      body.collectionVerified === false && body.transferAuthorized === false &&
      typeof body.canonicalScopeJson === "string" && oneRepositoryFile(body.canonicalScopeJson)) {
    return { kind: "checked", canonicalScopeJson: body.canonicalScopeJson };
  }
  return { kind: "error", code: typeof body?.error === "string" ? body.error : "preview_unavailable" };
}
