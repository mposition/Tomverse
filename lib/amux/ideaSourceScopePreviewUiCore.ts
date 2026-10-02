type ScopePreviewReply = { status: number; body: unknown };

export type ScopePreviewDecision =
  | { kind: "checked"; canonicalScopeJson: string;
      scopeDigest: string; scopeDigestKeyId: string }
  | { kind: "error"; code: string };

const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const keyedDigest = /^[a-f0-9]{64}$/;
const keyId = /^[A-Za-z0-9_-]{1,64}$/;
const exactKeys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).sort().join("\0") === expected.sort().join("\0");

const oneSourceFile = (raw: string): boolean => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const scope = value as Record<string, unknown>;
    if (scope.version !== 1 || !Array.isArray(scope.sources) || scope.sources.length !== 1) return false;
    const candidate = scope.sources[0];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const file = candidate as Record<string, unknown>;
    if (typeof file.repository !== "string" || !file.repository ||
        typeof file.path !== "string" || !file.path) return false;
    if (file.kind === "repository_file") {
      return exactKeys(file, ["kind", "repository", "commitSha", "path"]) &&
        typeof file.commitSha === "string" && sha.test(file.commitSha);
    }
    if (file.kind === "pull_request_file") {
      return exactKeys(file, ["kind", "repository", "number", "baseSha", "headSha", "side", "path"]) &&
        Number.isSafeInteger(file.number) && (file.number as number) > 0 &&
        typeof file.baseSha === "string" && sha.test(file.baseSha) &&
        typeof file.headSha === "string" && sha.test(file.headSha) &&
        (file.side === "base" || file.side === "head");
    }
    return false;
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
      typeof body.canonicalScopeJson === "string" && oneSourceFile(body.canonicalScopeJson) &&
      typeof body.scopeDigest === "string" && keyedDigest.test(body.scopeDigest) &&
      typeof body.scopeDigestKeyId === "string" && keyId.test(body.scopeDigestKeyId)) {
    return { kind: "checked", canonicalScopeJson: body.canonicalScopeJson,
      scopeDigest: body.scopeDigest, scopeDigestKeyId: body.scopeDigestKeyId };
  }
  return { kind: "error", code: typeof body?.error === "string" ? body.error : "preview_unavailable" };
}
