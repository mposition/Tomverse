import "server-only";

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Prisma } from "@prisma/client";

import { readExactCheckoutFile } from "@/lib/promptRefinerStageAdmission";
import {
  PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES,
  PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
} from "@/lib/promptRefinerStageAdmissionCore";
import { parseBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import type { PromptRefinerRunnableStageId } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v4";
const MANIFEST_PATH =
  "docs/ops/prompt-refiner-quality-evaluation-vnext-one-shot-candidate-source.json";
const MANIFEST_VERSION = "prompt-refiner-vnext-one-shot-candidate-source-v1";
const SOURCE_PATHS = Object.freeze([
  "docs/ops/prompt-refiner-quality-evaluation-vnext-candidate-development.md",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-execution-contract-approval.md",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-numeric-approval.md",
  "docs/ops/prompt-refiner-quality-evaluation-vnext-numeric-spec-draft.md",
  "docs/policy/prompt-refiner-quality-evaluation-vnext-draft.md",
  "lib/promptRefinerQualityEvaluationVnextAggregate.ts",
  "lib/promptRefinerQualityEvaluationVnextAllocation.ts",
  "lib/promptRefinerQualityEvaluationVnextCandidate.ts",
  "lib/promptRefinerQualityEvaluationVnextCore.ts",
  "lib/promptRefinerQualityEvaluationVnextDevelopment.ts",
  "lib/promptRefinerQualityEvaluationVnextExecutionContract.ts",
  "lib/providerUsageCost.ts",
  "lib/routerDevelopmentBenchmark.ts",
  "tests/promptRefinerQualityEvaluationVnextCandidate.test.mjs",
  "tests/promptRefinerQualityEvaluationVnextDevelopment.test.mjs",
] as const);
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const refuse = (code: string): never => { throw new Error(code); };

type Pin = Readonly<{ sourceCommitSha: string; sourceManifestDigest: string }>;

/**
 * Re-reads the stage-pinned candidate files from the deployed app checkout.
 * This is only the candidate source slice: runner, deployment, price, audit,
 * and reservation must be checked independently before any dispatch.
 */
export async function verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(
  rootPath: string,
  runtimeCommitSha: string | undefined,
  pin: Pin
): Promise<Readonly<{
  candidateSourceVerified: true;
  sourceCommitSha: string;
  sourceManifestDigest: string;
  verifiedFileCount: number;
  dispatchAuthorized: false;
}>> {
  // The candidate commit is fixed at preregistration. A later app deployment
  // may have another commit, but its candidate manifest and every file must
  // still have the exact pinned bytes. Deployment identity is checked apart.
  if (!FULL_COMMIT.test(pin.sourceCommitSha) ||
      !FULL_COMMIT.test(runtimeCommitSha ?? "")) {
    return refuse("vnext_one_shot_candidate_commit_mismatch");
  }
  if (!SHA256.test(pin.sourceManifestDigest) ||
      typeof rootPath !== "string" || !rootPath.trim()) {
    return refuse("vnext_one_shot_candidate_pin_invalid");
  }
  const root = resolve(rootPath);
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await readExactCheckoutFile(root, MANIFEST_PATH, { maxBytes: 64 * 1024 });
  } catch {
    return refuse("vnext_one_shot_candidate_source_unavailable");
  }
  if (digest(manifestBytes) !== pin.sourceManifestDigest) {
    return refuse("vnext_one_shot_candidate_manifest_drift");
  }
  let parsed: unknown;
  try {
    parsed = parseBenchmarkJson(Buffer.from(manifestBytes).toString("utf8"));
  } catch {
    return refuse("vnext_one_shot_candidate_manifest_invalid");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse("vnext_one_shot_candidate_manifest_invalid");
  }
  const manifest = parsed as Record<string, unknown>;
  if (Object.keys(manifest).sort().join(",") !== "files,scope,version" ||
      manifest.version !== MANIFEST_VERSION ||
      manifest.scope !== "candidate_source_only" ||
      manifest.files === null || typeof manifest.files !== "object" ||
      Array.isArray(manifest.files)) {
    return refuse("vnext_one_shot_candidate_manifest_invalid");
  }
  const files = manifest.files as Record<string, unknown>;
  if (Object.keys(files).length !== SOURCE_PATHS.length ||
      SOURCE_PATHS.some((path) => typeof files[path] !== "string" ||
        !SHA256.test(files[path] as string)) ||
      Object.keys(files).some((path) => !SOURCE_PATHS.includes(path as typeof SOURCE_PATHS[number]))) {
    return refuse("vnext_one_shot_candidate_manifest_invalid");
  }
  let remainingBytes = PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES - manifestBytes.byteLength;
  for (const path of SOURCE_PATHS) {
    if (remainingBytes <= 0) return refuse("vnext_one_shot_candidate_source_size");
    let bytes: Uint8Array;
    try {
      bytes = await readExactCheckoutFile(root, path, {
        maxBytes: Math.min(PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES, remainingBytes),
      });
    } catch {
      return refuse("vnext_one_shot_candidate_source_unavailable");
    }
    if (digest(bytes) !== files[path]) return refuse("vnext_one_shot_candidate_file_drift");
    remainingBytes -= bytes.byteLength;
  }
  return Object.freeze({
    candidateSourceVerified: true,
    sourceCommitSha: pin.sourceCommitSha,
    sourceManifestDigest: pin.sourceManifestDigest,
    verifiedFileCount: SOURCE_PATHS.length,
    dispatchAuthorized: false,
  });
}

/** Server-owned preview pin for the later stage writer; not an approval. */
export async function previewPromptRefinerVnextOneShotCandidateSourcePin() {
  const sourceCommitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase();
  if (!FULL_COMMIT.test(sourceCommitSha ?? "")) {
    return refuse("vnext_one_shot_candidate_commit_mismatch");
  }
  const root = process.cwd();
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = await readExactCheckoutFile(root, MANIFEST_PATH, { maxBytes: 64 * 1024 });
  } catch {
    return refuse("vnext_one_shot_candidate_source_unavailable");
  }
  const pin = Object.freeze({
    sourceCommitSha: sourceCommitSha!,
    sourceManifestDigest: digest(manifestBytes),
  });
  await verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(root, sourceCommitSha, pin);
  return Object.freeze({ ...pin, dispatchAuthorized: false as const });
}

/** The pin comes from the immutable stage row, never from a request field. */
export async function readPromptRefinerVnextOneShotCandidateSource(
  tx: Prisma.TransactionClient,
  stageId: PromptRefinerRunnableStageId = STAGE_ID,
) {
  const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: stageId },
    select: { sourceCommitSha: true, sourceManifestDigest: true },
  });
  if (!stage) return refuse("vnext_one_shot_candidate_stage_absent");
  return verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(
    process.cwd(), process.env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase(), stage
  );
}
