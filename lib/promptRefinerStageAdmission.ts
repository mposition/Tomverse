import "server-only";

import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Session } from "next-auth";
import { Prisma, type ModelRegistryEntry } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  adminAuditEntryHashVariants,
  adminAuditIntegrityKeys,
} from "@/lib/adminAuditIntegrityCore";
import { getModelPricingProfile } from "@/lib/modelPricing";
import { registryRowToModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";
import {
  PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
  PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
  PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
  PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
  PROMPT_REFINER_EXECUTION_MODEL_PIN,
  promptRefinerExecutionContractProblems,
} from "@/lib/promptRefinerExecutionContract";
import {
  PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
  PROMPT_REFINER_RESERVATION_STAGE_ID,
} from "@/lib/promptRefinerReservationCore";
import {
  PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
  PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
  PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256,
  PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST,
  PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
  PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
  PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
  proposePromptRefinerShadowStage,
} from "@/lib/promptRefinerShadowAdmissionCore";
import {
  PROMPT_REFINER_RUNTIME_SOURCE_PATHS,
  PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES,
  PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
  PROMPT_REFINER_STAGE_ADMISSION_VERSION,
  PROMPT_REFINER_STAGE_APPROVAL_TTL_MS,
  PROMPT_REFINER_STAGE_CONFIRMATION,
  PROMPT_REFINER_STAGE_ENVIRONMENT,
  PROMPT_REFINER_STAGE_REASON,
  buildPromptRefinerStagePreviewBinding,
  buildPromptRefinerRuntimeSourceManifest,
  buildPromptRefinerStageAdmissionFacts,
  prefixedPromptRefinerDigest,
  promptRefinerExecutionManifest,
  promptRefinerStageAdmissionProblems,
  promptRefinerStagePreviewBindingDigest,
  type PromptRefinerStageAdmissionFacts,
} from "@/lib/promptRefinerStageAdmissionCore";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

const EVIDENCE_ROOT = "docs/ops/prompt-refiner-shadow/evidence";
const CORPUS_PATH = "docs/ops/prompt-refiner-shadow/corpus-v1.json";
const PROMPT_REFINER_STAGE_AUDIT_ACTION = "prompt_refiner.shadow_stage.activated";
const PROMPT_REFINER_STAGE_AUDIT_TARGET = "PromptRefinerReservationStage";
const PROMPT_REFINER_STAGE_AUDIT_SUMMARY =
  "Approved the bounded Prompt Refiner staging shadow stage.";

export class PromptRefinerStageAdmissionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const refuse = (status: number, code: string, message: string): never => {
  throw new PromptRefinerStageAdmissionError(status, code, message);
};

const serverRuntimeIdentity = (): {
  environment: typeof PROMPT_REFINER_STAGE_ENVIRONMENT;
  commitSha: string;
  deploymentId: string;
} => {
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME?.trim();
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase();
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim();
  if (environment !== PROMPT_REFINER_STAGE_ENVIRONMENT) {
    refuse(409, "PROMPT_REFINER_STAGE_NOT_STAGING", "The stage can only be approved on staging.");
  }
  if (!commitSha || !deploymentId) {
    refuse(503, "PROMPT_REFINER_STAGE_RUNTIME_IDENTITY_UNAVAILABLE", "Runtime deployment identity is unavailable.");
  }
  return {
    environment: PROMPT_REFINER_STAGE_ENVIRONMENT,
    commitSha: commitSha!,
    deploymentId: deploymentId!,
  };
};

type SourceReadHooks = {
  afterInitialSnapshot?: () => void | Promise<void>;
  beforePostSnapshot?: () => void | Promise<void>;
};

const sameFileSnapshot = (
  left: BigIntStats,
  right: BigIntStats
) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const assertNoSymlinkComponents = async (rootReal: string, path: string) => {
  let cursor = rootReal;
  for (const part of path.split("/")) {
    cursor = resolve(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) {
      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_NOT_REGULAR", "Runtime source crosses a symbolic link.");
    }
  }
};

/** Opens the named path once and hashes only a stable regular-file snapshot. */
export const readExactCheckoutFile = async (
  root: string,
  path: string,
  options: { maxBytes?: number; hooks?: SourceReadHooks } = {}
): Promise<Uint8Array> => {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, ...path.split("/"));
  if (candidate !== rootReal && !candidate.startsWith(`${rootReal}${sep}`)) {
    refuse(503, "PROMPT_REFINER_STAGE_SOURCE_BOUNDARY", "Runtime source boundary validation failed.");
  }
  const maxBytes = options.maxBytes ?? PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES;
  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const initial = await handle.stat({ bigint: true });
    await assertNoSymlinkComponents(rootReal, path);
    const namedInitial = await lstat(candidate, { bigint: true });
    if (
      !initial.isFile() ||
      !namedInitial.isFile() ||
      namedInitial.isSymbolicLink() ||
      !sameFileSnapshot(initial, namedInitial)
    ) {
      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_NOT_REGULAR", "Runtime source is not a stable regular file.");
    }
    const candidateReal = await realpath(candidate);
    if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${sep}`)) {
      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_BOUNDARY", "Runtime source boundary validation failed.");
    }
    if (initial.size <= BigInt(0) || initial.size > BigInt(maxBytes)) {
      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_SIZE", "Runtime source size is outside the contract.");
    }
    await options.hooks?.afterInitialSnapshot?.();
    const size = Number(initial.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = await handle.read(bytes, offset, size - offset, offset);
      if (read.bytesRead === 0) {
        refuse(503, "PROMPT_REFINER_STAGE_SOURCE_CHANGED", "Runtime source changed while it was read.");
      }
      offset += read.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_CHANGED", "Runtime source changed while it was read.");
    }
    await options.hooks?.beforePostSnapshot?.();
    const post = await handle.stat({ bigint: true });
    const namedPost = await lstat(candidate, { bigint: true });
    if (
      namedPost.isSymbolicLink() ||
      !namedPost.isFile() ||
      !sameFileSnapshot(initial, post) ||
      !sameFileSnapshot(post, namedPost)
    ) {
      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_CHANGED", "Runtime source changed while it was read.");
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch (error) {
    if (error instanceof PromptRefinerStageAdmissionError) throw error;
    refuse(503, "PROMPT_REFINER_STAGE_SOURCE_UNAVAILABLE", "Runtime source could not be read safely.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  throw new Error("prompt_refiner_stage_source_reader_unreachable");
};

const validateHistoricalEvidence = async (root: string) => {
  const [manifestBytes, reportBytes, journalBytes, witnessBytes, corpusBytes] = await Promise.all([
    readExactCheckoutFile(root, `${EVIDENCE_ROOT}/admission-readiness-v1.manifest.json`),
    readExactCheckoutFile(root, `${EVIDENCE_ROOT}/admission-readiness-v1.report.json`),
    readExactCheckoutFile(root, `${EVIDENCE_ROOT}/admission-readiness-v1.journal.jsonl`),
    readExactCheckoutFile(root, `${EVIDENCE_ROOT}/admission-readiness-v1.journal.jsonl.witness.jsonl`),
    readExactCheckoutFile(root, CORPUS_PATH),
  ]);
  const proposal = proposePromptRefinerShadowStage({
    manifestBytes,
    reportBytes,
    journalBytes,
    witnessBytes,
    corpusBytes,
  });
  if (
    proposal.executionAdmitted !== false ||
    proposal.currentCheckoutValidated !== false ||
    proposal.runtimeSourceRevalidationRequired !== true
  ) {
    refuse(503, "PROMPT_REFINER_STAGE_PROPOSAL_BOUNDARY", "Historical proposal boundary validation failed.");
  }
};

/** Reads the fixed runtime closure without allocating past the aggregate cap. */
export const readPromptRefinerRuntimeSourceFiles = async (
  root: string
): Promise<ReadonlyMap<string, Uint8Array>> => {
  const files = new Map<string, Uint8Array>();
  let totalSizeBytes = 0;
  for (const path of PROMPT_REFINER_RUNTIME_SOURCE_PATHS) {
    const remaining = PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES - totalSizeBytes;
    if (remaining <= 0) {
      refuse(503, "PROMPT_REFINER_STAGE_SOURCE_SIZE", "Runtime source total size is outside the contract.");
    }
    const bytes = await readExactCheckoutFile(root, path, {
      maxBytes: Math.min(PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES, remaining),
    });
    totalSizeBytes += bytes.byteLength;
    files.set(path, bytes);
  }
  return files;
};

/** Reads only server-owned deployment identity and exact checked-in bytes. */
export const loadPromptRefinerStageAdmissionFacts = async (): Promise<PromptRefinerStageAdmissionFacts> => {
  const runtime = serverRuntimeIdentity();
  const root = process.cwd();
  await validateHistoricalEvidence(root);
  const files = await readPromptRefinerRuntimeSourceFiles(root);
  const source = buildPromptRefinerRuntimeSourceManifest({
    commitSha: runtime.commitSha,
    files,
  });
  const facts = buildPromptRefinerStageAdmissionFacts({
    runtimeCommitSha: runtime.commitSha,
    runtimeDeploymentId: runtime.deploymentId,
    runtimeEnvironment: runtime.environment,
    runtimeSourceManifest: source.manifest,
    runtimeSourceIdentityDigest: source.sourceIdentityDigest,
    runtimeSourceManifestDigest: source.manifestDigest,
  });
  if (promptRefinerStageAdmissionProblems(facts).length > 0) {
    refuse(409, "PROMPT_REFINER_STAGE_RUNTIME_DRIFT", "Runtime source or execution contract drifted.");
  }
  if (promptRefinerExecutionContractProblems().length > 0) {
    refuse(409, "PROMPT_REFINER_STAGE_EXECUTION_DRIFT", "Runtime execution contract drifted.");
  }
  return facts;
};

type StoredStage = {
  id: string;
  contractVersion: string;
  contractDigest: string;
  status: string;
  perRequestCostMicroUsd: bigint;
  maxReservations: number;
  costCeilingMicroUsd: bigint;
  reservationCount: number;
  allocatedCostMicroUsd: bigint;
  admissionVersion: string;
  proposalVersion: string;
  proposalDigest: string;
  evidenceBundleDigest: string;
  evidenceManifestSha256: string;
  historicalSourceRef: string;
  historicalSourceIdentityDigest: string;
  corpusDigest: string;
  runtimeCommitSha: string;
  runtimeSourceIdentityDigest: string;
  runtimeSourceManifest: unknown;
  runtimeSourceManifestDigest: string;
  runtimeEnvironment: string;
  runtimeDeploymentId: string;
  executionManifest: unknown;
  executionManifestDigest: string;
  approvedBy: string;
  approvedAt: Date;
  approvalExpiresAt: Date;
  authorizationAuditLogId: string;
};

const promptRefinerStageAuditMetadata = (stage: StoredStage) => ({
  admissionVersion: stage.admissionVersion,
  proposalDigest: stage.proposalDigest,
  evidenceBundleDigest: stage.evidenceBundleDigest,
  runtimeSourceManifestDigest: stage.runtimeSourceManifestDigest,
  executionManifestDigest: stage.executionManifestDigest,
  environment: stage.runtimeEnvironment,
  deploymentId: stage.runtimeDeploymentId,
  commitSha: stage.runtimeCommitSha,
  perRequestCostMicroUsd: Number(stage.perRequestCostMicroUsd),
  maxReservations: stage.maxReservations,
  costCeilingMicroUsd: Number(stage.costCeilingMicroUsd),
  approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
  approvedAt: stage.approvedAt.toISOString(),
  approvalExpiresAt: stage.approvalExpiresAt.toISOString(),
  reason: PROMPT_REFINER_STAGE_REASON,
});

type StageAuthorizationAudit = {
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  previousHash: string | null;
  entryHash: string | null;
  createdAt: Date;
};

/** Verifies the exact immutable stage binding and the linked row's own HMAC. */
export const promptRefinerStageAuthorizationAuditEntryIsValid = (
  stage: StoredStage,
  linked: StageAuthorizationAudit,
  keys: readonly string[]
): boolean => {
  if (
    keys.length === 0 ||
    !linked.entryHash ||
    linked.actorUserId !== stage.approvedBy ||
    linked.action !== PROMPT_REFINER_STAGE_AUDIT_ACTION ||
    linked.targetType !== PROMPT_REFINER_STAGE_AUDIT_TARGET ||
    linked.targetId !== stage.id ||
    linked.summary !== PROMPT_REFINER_STAGE_AUDIT_SUMMARY ||
    canonicalBenchmarkJson(linked.metadata ?? null) !==
      canonicalBenchmarkJson(promptRefinerStageAuditMetadata(stage))
  ) {
    return false;
  }

  const hashInput = {
    previousHash: linked.previousHash,
    actorUserId: linked.actorUserId,
    actorEmail: linked.actorEmail,
    action: linked.action,
    targetType: linked.targetType,
    targetId: linked.targetId,
    summary: linked.summary,
    metadata: linked.metadata ?? null,
    ipAddress: linked.ipAddress,
    userAgent: linked.userAgent,
    createdAt: linked.createdAt.toISOString(),
  };
  return keys.some((key) => {
    const variants = adminAuditEntryHashVariants(hashInput, key);
    return ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.some(
      (order) => variants[order] === linked.entryHash
    );
  });
};

/**
 * Verifies the stage-linked authorization as a real HMAC audit attestation.
 *
 * The migration deliberately validates only public structure: PostgreSQL does
 * not own the HMAC key. Therefore an app-role direct insert can create rows
 * that are structurally exact but cannot authorize reserve or consume. This
 * check verifies the linked row's signed payload and exact immutable stage
 * metadata. Its `previousHash` is itself covered by that HMAC; when non-null,
 * the referenced predecessor must also exist. It does not scan or lock the
 * global chain, so an unrelated audit write cannot contend with every reserve.
 */
export const promptRefinerStageAuthorizationIsValid = async (
  tx: Prisma.TransactionClient,
  stage: StoredStage
): Promise<boolean> => {
  const keys = adminAuditIntegrityKeys(process.env);
  if (keys.length === 0 || !stage.authorizationAuditLogId) return false;

  const linked = await tx.adminAuditLog.findUnique({
    where: { id: stage.authorizationAuditLogId },
  });
  if (!linked || !promptRefinerStageAuthorizationAuditEntryIsValid(stage, linked, keys)) {
    return false;
  }
  if (!linked.previousHash) return true;
  const predecessor = await tx.adminAuditLog.findUnique({
    where: { entryHash: linked.previousHash },
    select: { entryHash: true },
  });
  return predecessor?.entryHash === linked.previousHash;
};

export const promptRefinerStoredStageMatchesRuntime = (
  stage: StoredStage,
  facts: PromptRefinerStageAdmissionFacts,
  now: Date,
  options: { requireApproved?: boolean } = {}
): boolean =>
  stage.id === PROMPT_REFINER_RESERVATION_STAGE_ID &&
  stage.contractVersion === PROMPT_REFINER_EXECUTION_CONTRACT_VERSION &&
  stage.contractDigest === PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST &&
  (options.requireApproved === false ? ["approved", "closed"].includes(stage.status) : stage.status === "approved") &&
  stage.perRequestCostMicroUsd === BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD) &&
  stage.maxReservations === PROMPT_REFINER_SHADOW_MAX_DISPATCHES &&
  stage.costCeilingMicroUsd === BigInt(PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD) &&
  stage.admissionVersion === facts.admissionVersion &&
  stage.proposalVersion === facts.proposalVersion &&
  stage.proposalDigest === facts.proposalDigest &&
  stage.evidenceBundleDigest === facts.evidenceBundleDigest &&
  stage.evidenceManifestSha256 === facts.evidenceManifestSha256 &&
  stage.historicalSourceRef === facts.historicalSourceRef &&
  stage.historicalSourceIdentityDigest === facts.historicalSourceIdentityDigest &&
  stage.corpusDigest === facts.corpusDigest &&
  stage.runtimeCommitSha === facts.runtimeCommitSha &&
  stage.runtimeSourceIdentityDigest === facts.runtimeSourceIdentityDigest &&
  canonicalBenchmarkJson(stage.runtimeSourceManifest) === canonicalBenchmarkJson(facts.runtimeSourceManifest) &&
  stage.runtimeSourceManifestDigest === facts.runtimeSourceManifestDigest &&
  stage.runtimeEnvironment === facts.runtimeEnvironment &&
  stage.runtimeDeploymentId === facts.runtimeDeploymentId &&
  canonicalBenchmarkJson(stage.executionManifest) === canonicalBenchmarkJson(facts.executionManifest) &&
  stage.executionManifestDigest === facts.executionManifestDigest &&
  stage.approvalExpiresAt.getTime() - stage.approvedAt.getTime() === PROMPT_REFINER_STAGE_APPROVAL_TTL_MS &&
  stage.approvedAt.getTime() <= now.getTime() &&
  stage.approvalExpiresAt.getTime() > now.getTime() &&
  stage.authorizationAuditLogId.length > 0;

const lockAndValidateRegistry = async (tx: Prisma.TransactionClient) => {
  await tx.$executeRawUnsafe('LOCK TABLE "ModelRegistryEntry" IN SHARE MODE');
  const row = await tx.modelRegistryEntry.findUnique({
    where: { id: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId },
  });
  if (!row) refuse(409, "PROMPT_REFINER_STAGE_MODEL_MISSING", "Pinned model registry row is missing.");
  let model;
  try {
    model = registryRowToModel(row as ModelRegistryEntry);
  } catch {
    refuse(409, "PROMPT_REFINER_STAGE_MODEL_INVALID", "Pinned model registry row is invalid.");
  }
  const pricing = getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
  if (promptRefinerExecutionContractProblems({ model, pricing }).length > 0) {
    refuse(409, "PROMPT_REFINER_STAGE_EXECUTION_DRIFT", "Pinned model or pricing contract drifted.");
  }
};

const dbClock = async (tx: Prisma.TransactionClient): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!rows[0]) throw new Error("prompt_refiner_stage_db_clock_unavailable");
  return rows[0].now;
};

export const promptRefinerStagePreview = async () => {
  const facts = await loadPromptRefinerStageAdmissionFacts();
  const existing = await prisma.promptRefinerReservationStage.findUnique({
    where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
  });
  const previewBindingDigest = promptRefinerStagePreviewBindingDigest(
    buildPromptRefinerStagePreviewBinding(facts)
  );
  return {
    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
    status: existing ? "already_exists" : "ready_for_explicit_cost_approval",
    proposalDigest: facts.proposalDigest,
    runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
    executionManifestDigest: facts.executionManifestDigest,
    environment: facts.runtimeEnvironment,
    deploymentId: facts.runtimeDeploymentId,
    commitSha: facts.runtimeCommitSha,
    perRequestCostMicroUsd: PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
    costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
    approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
    previewBindingDigest,
    confirmation: PROMPT_REFINER_STAGE_CONFIRMATION,
    executionAdmitted: false as const,
    productAdapterReady: false as const,
  };
};

export const createPromptRefinerReservationStage = async (input: {
  session: Session;
  request: Request;
  expected: {
    proposalDigest: string;
    runtimeSourceManifestDigest: string;
    executionManifestDigest: string;
    previewBindingDigest: string;
  };
}) => {
  if (!input.session.user?.id) refuse(403, "PROMPT_REFINER_STAGE_ACTOR_REQUIRED", "Administrator identity is required.");
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    refuse(503, "PROMPT_REFINER_STAGE_AUDIT_KEY_REQUIRED", "Audit integrity signing is not configured.");
  }
  const facts = await loadPromptRefinerStageAdmissionFacts();
  const currentPreviewBindingDigest = promptRefinerStagePreviewBindingDigest(
    buildPromptRefinerStagePreviewBinding(facts)
  );
  if (
    input.expected.proposalDigest !== facts.proposalDigest ||
    input.expected.runtimeSourceManifestDigest !== facts.runtimeSourceManifestDigest ||
    input.expected.executionManifestDigest !== facts.executionManifestDigest ||
    input.expected.previewBindingDigest !== currentPreviewBindingDigest
  ) {
    refuse(409, "PROMPT_REFINER_STAGE_PREVIEW_STALE", "Approval preview no longer matches this deployment.");
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('prompt-refiner-shadow-stage-v1'))`;
    await lockAndValidateRegistry(tx);
    const now = await dbClock(tx);
    const existing = await tx.promptRefinerReservationStage.findUnique({
      where: { id: PROMPT_REFINER_RESERVATION_STAGE_ID },
    });
    if (existing) {
      if (
        existing.approvedBy === input.session.user!.id &&
        (await promptRefinerStageAuthorizationIsValid(tx, existing)) &&
        promptRefinerStoredStageMatchesRuntime(existing as StoredStage, facts, now)
      ) {
        return { created: false, replayed: true, stage: existing };
      }
      refuse(409, "PROMPT_REFINER_STAGE_ALREADY_EXISTS_MISMATCH", "A different immutable stage already exists.");
    }

    const auditId = await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: PROMPT_REFINER_STAGE_AUDIT_ACTION,
      targetType: PROMPT_REFINER_STAGE_AUDIT_TARGET,
      targetId: PROMPT_REFINER_RESERVATION_STAGE_ID,
      summary: PROMPT_REFINER_STAGE_AUDIT_SUMMARY,
      metadata: {
        admissionVersion: facts.admissionVersion,
        proposalDigest: facts.proposalDigest,
        evidenceBundleDigest: facts.evidenceBundleDigest,
        runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
        executionManifestDigest: facts.executionManifestDigest,
        environment: facts.runtimeEnvironment,
        deploymentId: facts.runtimeDeploymentId,
        commitSha: facts.runtimeCommitSha,
        perRequestCostMicroUsd: PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
        maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
        costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
        approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
        approvedAt: now.toISOString(),
        approvalExpiresAt: new Date(now.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS).toISOString(),
        reason: PROMPT_REFINER_STAGE_REASON,
      },
      tx,
    });
    const stage = await tx.promptRefinerReservationStage.create({
      data: {
        id: PROMPT_REFINER_RESERVATION_STAGE_ID,
        contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
        contractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
        status: "approved",
        perRequestCostMicroUsd: BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD),
        maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
        costCeilingMicroUsd: BigInt(PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD),
        reservationCount: 0,
        allocatedCostMicroUsd: BigInt(0),
        admissionVersion: facts.admissionVersion,
        proposalVersion: facts.proposalVersion,
        proposalDigest: facts.proposalDigest,
        evidenceBundleDigest: facts.evidenceBundleDigest,
        evidenceManifestSha256: facts.evidenceManifestSha256,
        historicalSourceRef: facts.historicalSourceRef,
        historicalSourceIdentityDigest: facts.historicalSourceIdentityDigest,
        corpusDigest: facts.corpusDigest,
        runtimeCommitSha: facts.runtimeCommitSha,
        runtimeSourceIdentityDigest: facts.runtimeSourceIdentityDigest,
        runtimeSourceManifest: facts.runtimeSourceManifest as unknown as Prisma.InputJsonValue,
        runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
        runtimeEnvironment: facts.runtimeEnvironment,
        runtimeDeploymentId: facts.runtimeDeploymentId,
        executionManifest: facts.executionManifest as unknown as Prisma.InputJsonValue,
        executionManifestDigest: facts.executionManifestDigest,
        approvedBy: input.session.user!.id,
        approvedAt: now,
        approvalExpiresAt: new Date(now.getTime() + PROMPT_REFINER_STAGE_APPROVAL_TTL_MS),
        authorizationAuditLogId: auditId,
        createdAt: now,
      },
    });
    if (!(await promptRefinerStageAuthorizationIsValid(tx, stage))) {
      refuse(
        503,
        "PROMPT_REFINER_STAGE_AUTHORIZATION_INVALID",
        "The durable stage authorization could not be verified."
      );
    }
    return { created: true, replayed: false, stage };
  });
};

export const promptRefinerStageAdmissionErrorResponse = (error: unknown) => {
  if (!(error instanceof PromptRefinerStageAdmissionError)) return null;
  return Response.json({ error: error.message, code: error.code }, { status: error.status });
};

export const PROMPT_REFINER_STAGE_FIXED_BINDINGS = Object.freeze({
  admissionVersion: PROMPT_REFINER_STAGE_ADMISSION_VERSION,
  proposalVersion: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
  proposalDigest: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
  evidenceBundleDigest: PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
  evidenceManifestSha256: PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256,
  historicalSourceRef: PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
  historicalSourceIdentityDigest: PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST,
  corpusDigest: PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
  executionManifestDigest: prefixedPromptRefinerDigest(
    promptRefinerExecutionManifest()
  ),
});
