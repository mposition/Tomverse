import { z } from "zod";

/** A collection result is display data, not a verified source or send grant. */
export const AMUX_V4_COLLECTION_PREVIEW_READ_CODE_LATCH = false;
export const AMUX_V4_COLLECTION_PREVIEW_READ_ENV = "TOMVERSE_AMUX_V4_COLLECTION_PREVIEW_READ";
export const collectionPreviewReadPermitted = (value: string | undefined) =>
  AMUX_V4_COLLECTION_PREVIEW_READ_CODE_LATCH && value === "enabled";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.object({
  sourceIndex: z.literal(0), repositoryId: z.number().int().positive().safe(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  refName: z.string().regex(/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]{1,500}$/),
  refObjectSha: sha, refCommitSha: sha, commitSha: sha,
  path: z.string().regex(/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/).max(256),
  blobSha: sha, fileSha256: digest,
  startByte: z.number().int().nonnegative().safe(),
  endByte: z.number().int().positive().safe(),
  excerptText: z.string().min(1).max(8_192),
}).strict();

const stored = z.object({
  schemaVersion: z.literal(1), previewId: z.uuid(),
  templateVersion: z.string().min(1).max(100),
  prompt: z.string().min(1).max(32_000),
  model: z.object({ provider: z.enum(["openai", "anthropic"]),
    modelId: z.string().min(1).max(200),
    reasoningEffort: z.string().min(1).max(100) }).strict(),
  selectedSourceIndices: z.tuple([z.literal(0)]),
  unselectedSourceCount: z.literal(0),
  provenance: z.literal("collector_attested"), source,
}).strict();

export type AmuxStoredCollectionPreview = z.infer<typeof stored>;

export function parseStoredAmuxCollectionPreview(plain: Buffer,
  binding: { previewId: string; provider: string; modelId: string;
    reasoningEffort: string; promptVersion: string }): AmuxStoredCollectionPreview | null {
  if (plain.length > 32_000 || !plain.equals(Buffer.from(plain.toString("utf8"), "utf8"))) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(plain.toString("utf8")); } catch { return null; }
  const result = stored.safeParse(parsed);
  if (!result.success || result.data.previewId !== binding.previewId ||
      result.data.templateVersion !== binding.promptVersion ||
      result.data.model.provider !== binding.provider ||
      result.data.model.modelId !== binding.modelId ||
      result.data.model.reasoningEffort !== binding.reasoningEffort ||
      result.data.source.endByte <= result.data.source.startByte ||
      Buffer.byteLength(result.data.source.excerptText, "utf8") !==
        result.data.source.endByte - result.data.source.startByte) return null;
  return result.data;
}
