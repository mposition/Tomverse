import { z } from "zod";

import { amuxAnalysisInputTextSafe } from "./ideaAnalysisChunkCore.ts";
import { buildAmuxIdeaAnalysisPrompt } from "./ideaAnalysisPromptCore.ts";
import { scanAmuxV4Input } from "./localIntakeCore.ts";

/** An authenticated collector attests provenance; this route does not treat
 * worker-supplied hashes or a prompt as owner approval or a model-send grant. */
export const AMUX_V4_COLLECTION_RESULT_CODE_LATCH = false;
export const AMUX_V4_COLLECTION_RESULT_ENV = "TOMVERSE_AMUX_V4_COLLECTION_RESULT_WRITE";
export const AMUX_V4_COLLECTION_RESULT_MAX_BYTES = 16_384;
export const collectionResultEnabled = (value: string | undefined) =>
  AMUX_V4_COLLECTION_RESULT_CODE_LATCH && value === "enabled";

const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({
  schemaVersion: z.literal(1),
  collectionRequestId: z.uuid(), requestId: z.uuid(), previewId: z.uuid(),
  requestDigest: digest, leaseId: z.uuid(), leaseGeneration: z.literal(1),
}).strict();
const source = z.object({
  sourceIndex: z.literal(0),
  repositoryId: z.number().int().positive().safe(),
  refName: z.string().regex(/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]{1,500}$/),
  refObjectSha: sha, refCommitSha: sha, commitSha: sha,
  path: z.string().regex(/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/).max(256),
  blobSha: sha, fileSha256: digest,
  startByte: z.number().int().nonnegative().safe(),
  endByte: z.number().int().positive().safe(),
  excerptText: z.string().min(1).max(8_192),
}).strict();
export const collectionResultRequestSchema = z.discriminatedUnion("outcome", [
  identity.extend({ outcome: z.literal("preview_candidate"), source }).strict(),
  identity.extend({ outcome: z.literal("hold"), reason: z.enum([
    "collector_timeout", "collector_unavailable", "source_unverified",
    "source_selection_invalid", "input_rejected", "source_too_large",
  ]) }).strict(),
]);
export type AmuxV4CollectionResultRequest = z.infer<typeof collectionResultRequestSchema>;

export type AmuxCollectionVerifiedSource = {
  kind: "repository_file"; repository: string; commitSha: string; path: string;
};

export function buildAmuxCollectionResult(input: {
  request: Extract<AmuxV4CollectionResultRequest, { outcome: "preview_candidate" }>;
  idea: string; source: AmuxCollectionVerifiedSource;
  model: { provider: "openai" | "anthropic"; modelId: string; reasoningEffort: string };
}): { ok: true; result: string; promptVersion: string } | { ok: false } {
  const { request, idea, source: approved } = input;
  const candidate = request.source;
  const excerpt = candidate.excerptText;
  if (approved.kind !== "repository_file" ||
      candidate.commitSha !== approved.commitSha || candidate.path !== approved.path ||
      candidate.refCommitSha.length !== candidate.commitSha.length ||
      candidate.refObjectSha.length !== candidate.commitSha.length ||
      candidate.blobSha.length !== candidate.commitSha.length ||
      candidate.endByte <= candidate.startByte ||
      Buffer.byteLength(excerpt, "utf8") !== candidate.endByte - candidate.startByte ||
      Buffer.byteLength(idea, "utf8") + Buffer.byteLength(excerpt, "utf8") > 8_192 ||
      Buffer.from(excerpt, "utf8").toString("utf8") !== excerpt ||
      !scanAmuxV4Input(idea).ok || !scanAmuxV4Input(excerpt).ok ||
      !amuxAnalysisInputTextSafe(idea) || !amuxAnalysisInputTextSafe(excerpt) ||
      !scanAmuxV4Input(`${candidate.refName}\n${candidate.path}`).ok ||
      !amuxAnalysisInputTextSafe(`${candidate.refName}\n${candidate.path}`) ||
      !scanAmuxV4Input(idea + excerpt).ok) return { ok: false };
  // Reconstruct this exact first-chunk prompt in the app; supplied prompt and
  // collector digest are deliberately absent from the wire contract.
  const prompt = buildAmuxIdeaAnalysisPrompt({ previewId: request.previewId,
    chunkIndex: 0, revisionChunkIndex: 0, continuation: null,
    sourceTexts: [
      { refId: "operator_idea", kind: "operator_idea", text: idea },
      { refId: "github_excerpt_1", kind: "github_excerpt", text: excerpt },
    ], permittedTargetRefs: [] });
  if (prompt.status !== "prompt_candidate") return { ok: false };
  const result = JSON.stringify({ schemaVersion: 1, previewId: request.previewId,
    templateVersion: prompt.version, prompt: prompt.prompt,
    model: input.model, selectedSourceIndices: [0], unselectedSourceCount: 0,
    // The source is a collector attestation; not independent GitHub proof.
    provenance: "collector_attested", source: { ...candidate,
      repository: approved.repository } });
  return Buffer.byteLength(result, "utf8") <= 32_000
    ? { ok: true, result, promptVersion: prompt.version } : { ok: false };
}
