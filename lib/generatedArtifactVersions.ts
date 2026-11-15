import { parseChatStreamArtifact, type ChatStreamArtifact } from "@/lib/generatedArtifactCore";

export type GeneratedArtifactVersion = ChatStreamArtifact & {
  parentArtifactId: string | null;
  lineageId: string;
  createdAt: string;
};

export type GeneratedArtifactVersions = {
  artifacts: GeneratedArtifactVersion[];
  nextCursor: string | null;
};

const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** Public metadata only; canonical content and storage locations never enter the view. */
export function parseGeneratedArtifactVersions(value: unknown): GeneratedArtifactVersions | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 50 ||
      (input.nextCursor !== null && !isId(input.nextCursor))) return null;
  const artifacts: GeneratedArtifactVersion[] = [];
  const seen = new Set<string>();
  for (const entry of input.artifacts) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    const artifact = parseChatStreamArtifact(row);
    if (!artifact || artifact.status !== "ready" || !isId(artifact.id) || seen.has(artifact.id) ||
        !isId(row.lineageId) || (row.parentArtifactId !== null && !isId(row.parentArtifactId)) ||
        row.parentArtifactId === artifact.id || typeof row.createdAt !== "string" ||
        row.createdAt.length > 40 || !Number.isFinite(Date.parse(row.createdAt))) return null;
    if (artifacts.length && artifacts[0].lineageId !== row.lineageId) return null;
    seen.add(artifact.id);
    artifacts.push({ ...artifact, parentArtifactId: row.parentArtifactId as string | null,
      lineageId: row.lineageId, createdAt: row.createdAt });
  }
  return { artifacts, nextCursor: input.nextCursor as string | null };
}

/** Keep branches as supplied by the server; names and ordering never imply ancestry. */
export function mergeGeneratedArtifactVersions(
  current: GeneratedArtifactVersion[], incoming: GeneratedArtifactVersion[]
): GeneratedArtifactVersion[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return Array.from(byId.values());
}

export const artifactVersionsPath = (artifactId: string, cursor?: string | null) =>
  `/api/artifacts/${encodeURIComponent(artifactId)}/versions` +
  (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
