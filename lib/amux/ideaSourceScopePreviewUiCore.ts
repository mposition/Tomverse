type ScopePreviewReply = { status: number; body: unknown };
type RequestedRepositoryFile = { repository: string; commitSha: string; path: string };

export type ScopePreviewDecision =
  | { kind: "checked"; canonicalScopeJson: string }
  | { kind: "error"; code: string };

const exactKeys = (value: Record<string, unknown>, names: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const expected = [...names].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
};

const oneRepositoryFile = (raw: string, requested: RequestedRepositoryFile): boolean => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const scope = value as Record<string, unknown>;
    if (!exactKeys(scope, ["version", "sources"]) || scope.version !== 1 ||
        !Array.isArray(scope.sources) || scope.sources.length !== 1 ||
        JSON.stringify(scope) !== raw) return false;
    const file = scope.sources[0];
    if (!file || typeof file !== "object" || Array.isArray(file)) return false;
    const source = file as Record<string, unknown>;
    return exactKeys(source, ["kind", "repository", "commitSha", "path"]) &&
      source.kind === "repository_file" &&
      typeof source.repository === "string" &&
      /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,100}$/.test(source.repository) &&
      source.repository.split("/").every((part) => part !== "." && part !== "..") &&
      source.repository.toLowerCase() === requested.repository.toLowerCase() &&
      typeof source.commitSha === "string" &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commitSha) &&
      source.commitSha === requested.commitSha &&
      typeof source.path === "string" &&
      /^[A-Za-z0-9._/-]{1,256}$/.test(source.path) &&
      source.path.split("/").every((part) =>
        part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git") &&
      source.path === requested.path;
  } catch {
    return false;
  }
};

/** A malformed or partial reply cannot be presented as a checked source. */
export function classifySourceScopePreview(
  reply: ScopePreviewReply,
  ideaId: string,
  requested: RequestedRepositoryFile,
): ScopePreviewDecision {
  const body = reply.body && typeof reply.body === "object" && !Array.isArray(reply.body)
    ? reply.body as Record<string, unknown> : null;
  if (reply.status === 200 && body?.ideaId === ideaId && body.fileCount === 1 &&
      body.collectionVerified === false && body.transferAuthorized === false &&
      typeof body.canonicalScopeJson === "string" &&
      oneRepositoryFile(body.canonicalScopeJson, requested)) {
    return { kind: "checked", canonicalScopeJson: body.canonicalScopeJson };
  }
  return { kind: "error", code: typeof body?.error === "string" ? body.error : "preview_unavailable" };
}
