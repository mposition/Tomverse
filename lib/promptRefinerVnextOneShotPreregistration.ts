import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";
import { readExactCheckoutFile } from "@/lib/promptRefinerStageAdmission";
import {
  previewPromptRefinerVnextOneShotCandidateSourcePin,
  verifyPromptRefinerVnextOneShotCandidateSourceAtRoot,
} from
  "@/lib/promptRefinerVnextOneShotCandidateSourceReadback";
import { promptRefinerVnextOneShotAuditReceiptIsValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import {
  PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT,
  PROMPT_REFINER_VNEXT_PRICE_PIN,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v1";
const ACTION = "prompt_refiner.vnext_one_shot.preregistered";
const TARGET_TYPE = "PromptRefinerVnextOneShotStage";
const SUMMARY = "Preregistered the bounded Prompt Refiner vNext one-shot candidate.";
const HEX_64 = /^[0-9a-f]{64}$/;
const POLICY_SHA256 =
  "dacdaab3360b7d848ea622bf83cc6a49c519c8a2f50ed1bc2d8b34a9a5b5ef7b";
const POLICY_PATH = "docs/policy/prompt-refiner-quality-evaluation-vnext-one-shot-v2.md";

export type PromptRefinerVnextOneShotPreregistrationPins = Readonly<{
  sourceCommitSha: string;
  sourceManifestDigest: string;
  runnerDigest: string;
  pricePinDigest: string;
}>;

const metadataFor = (pins: PromptRefinerVnextOneShotPreregistrationPins,
  accessorUserId: string) => ({
  version: "prompt-refiner-vnext-one-shot-preregistration-v1",
  policyVersion: 2,
  policySha256: POLICY_SHA256,
  numericSpecSha256: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.numericSpecSha256,
  sourceCommitSha: pins.sourceCommitSha,
  sourceManifestDigest: pins.sourceManifestDigest,
  runnerDigest: pins.runnerDigest,
  pricePinDigest: pins.pricePinDigest,
  provider: PROMPT_REFINER_VNEXT_PRICE_PIN.provider,
  modelId: PROMPT_REFINER_VNEXT_PRICE_PIN.modelId,
  maxInputTokens: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.maxInputTokens,
  maxOutputTokens: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.maxOutputTokens,
  timeoutMs: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.timeoutMs,
  retryCount: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.retryCount,
  slotCount: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.slotCount,
  koCount: 40,
  enCount: 40,
  perRequestCeilingMicroUsd:
    PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.perRequestCeilingMicroUsd,
  runCeilingMicroUsd: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.runCeilingMicroUsd,
  accessorUserId,
  rawRetentionDaysAfterDisposition: 30,
  rawRetentionDaysAfterSeal: 60,
});

const assertPolicyRunnerAndPricePins = async (
  expected: PromptRefinerVnextOneShotPreregistrationPins,
): Promise<void> => {
  let policyBytes: Uint8Array;
  try {
    policyBytes = await readExactCheckoutFile(process.cwd(), POLICY_PATH,
      { maxBytes: 64 * 1024 });
  } catch {
    throw new Error("vnext_one_shot_preregistration_policy_unavailable");
  }
  if (createHash("sha256").update(policyBytes).digest("hex") !== POLICY_SHA256) {
    throw new Error("vnext_one_shot_preregistration_policy_mismatch");
  }
  const runnerDigest = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  if (!HEX_64.test(runnerDigest ?? "")) {
    throw new Error("vnext_one_shot_preregistration_runner_unavailable");
  }
  if (runnerDigest !== expected.runnerDigest ||
      expected.pricePinDigest !== PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST) {
    throw new Error("vnext_one_shot_preregistration_pin_mismatch");
  }
};

/** Caller fields are equality pins; the server re-reads candidate and runner. */
export async function preparePromptRefinerVnextOneShotPreregistration(
  expected: PromptRefinerVnextOneShotPreregistrationPins,
): Promise<PromptRefinerVnextOneShotPreregistrationPins> {
  await assertPolicyRunnerAndPricePins(expected);
  const source = await previewPromptRefinerVnextOneShotCandidateSourcePin();
  if (source.sourceCommitSha !== expected.sourceCommitSha ||
      source.sourceManifestDigest !== expected.sourceManifestDigest) {
    throw new Error("vnext_one_shot_preregistration_source_mismatch");
  }
  return Object.freeze({
    sourceCommitSha: source.sourceCommitSha,
    sourceManifestDigest: source.sourceManifestDigest,
    runnerDigest: expected.runnerDigest,
    pricePinDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
  });
}

/** One append-only, content-free owner approval before any holdout authoring. */
export async function recordPromptRefinerVnextOneShotPreregistration(input: {
  session: Session;
  request: Request;
  pins: PromptRefinerVnextOneShotPreregistrationPins;
}): Promise<Readonly<{ auditLogId: string; dispatchAuthorized: false }>> {
  const accessorUserId = input.session.user?.id;
  if (!accessorUserId || adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_preregistration_context_invalid");
  }
  const pins = await preparePromptRefinerVnextOneShotPreregistration(input.pins);
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const existing = await tx.adminAuditLog.findMany({
      where: { action: ACTION, targetType: TARGET_TYPE, targetId: STAGE_ID },
      select: { id: true }, take: 1,
    });
    if (existing.length !== 0) {
      throw new Error("vnext_one_shot_preregistration_already_recorded");
    }
    if ((await readPromptRefinerVnextOneShotStage(tx)).stagePresent) {
      throw new Error("vnext_one_shot_preregistration_stage_exists");
    }
    const price = await readPromptRefinerVnextOneShotPrice(tx);
    if (!price.pricePinMatchesRegistry || price.problems.length !== 0) {
      throw new Error("vnext_one_shot_preregistration_price_mismatch");
    }
    const auditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: ACTION, targetType: TARGET_TYPE, targetId: STAGE_ID,
      summary: SUMMARY, metadata: metadataFor(pins, accessorUserId),
    });
    return Object.freeze({ auditLogId, dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}

/** Content-free recovery after a lost POST response; never grants admission. */
export async function readPromptRefinerVnextOneShotPreregistration(
  accessorUserId: string,
): Promise<Readonly<{
  preregistrationRecorded: boolean;
  preregistrationAuditLogId: string | null;
  currentPinsMatch: boolean;
  dispatchAuthorized: false;
}>> {
  if (!accessorUserId || adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_preregistration_unavailable");
  }
  const receipt = await prisma.$transaction(async (tx) => {
    const entries = await tx.adminAuditLog.findMany({
      where: { action: ACTION, targetType: TARGET_TYPE, targetId: STAGE_ID },
      take: 2,
    });
    if (entries.length === 0) return null;
    const entry = entries[0];
    const metadata = entry.metadata;
    if (entries.length !== 1 || entry.actorUserId !== accessorUserId ||
        entry.summary !== SUMMARY || !metadata || typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, entry)) {
      throw new Error("vnext_one_shot_preregistration_record_unverifiable");
    }
    const stored = metadata as Record<string, unknown>;
    const pins = {
      sourceCommitSha: stored.sourceCommitSha,
      sourceManifestDigest: stored.sourceManifestDigest,
      runnerDigest: stored.runnerDigest,
      pricePinDigest: stored.pricePinDigest,
    };
    if (typeof pins.sourceCommitSha !== "string" ||
        typeof pins.sourceManifestDigest !== "string" ||
        typeof pins.runnerDigest !== "string" ||
        typeof pins.pricePinDigest !== "string") {
      throw new Error("vnext_one_shot_preregistration_record_unverifiable");
    }
    const pinned = pins as PromptRefinerVnextOneShotPreregistrationPins;
    const metadataMatches = canonicalBenchmarkJson(metadata) ===
      canonicalBenchmarkJson(metadataFor(pinned, accessorUserId));
    const price = metadataMatches ? await readPromptRefinerVnextOneShotPrice(tx) : null;
    return { auditLogId: entry.id, pinned, metadataMatches,
      priceMatches: price !== null && price.pricePinMatchesRegistry &&
        price.problems.length === 0 };
  }, { maxWait: 5_000, timeout: 15_000 });
  if (receipt === null) {
    return Object.freeze({ preregistrationRecorded: false,
      preregistrationAuditLogId: null, currentPinsMatch: false,
      dispatchAuthorized: false as const });
  }
  const recorded = (currentPinsMatch: boolean) => Object.freeze({
    preregistrationRecorded: true,
    preregistrationAuditLogId: receipt.auditLogId,
    currentPinsMatch,
    dispatchAuthorized: false as const,
  });
  if (!receipt.metadataMatches || !receipt.priceMatches) return recorded(false);
  try {
    await assertPolicyRunnerAndPricePins(receipt.pinned);
  } catch (error) {
    if (error instanceof Error && (
      error.message === "vnext_one_shot_preregistration_policy_mismatch" ||
      error.message === "vnext_one_shot_preregistration_pin_mismatch")) {
      return recorded(false);
    }
    throw error;
  }
  try {
    await verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(process.cwd(),
      process.env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase(), receipt.pinned);
  } catch (error) {
    if (error instanceof Error && (
      error.message === "vnext_one_shot_candidate_manifest_drift" ||
      error.message === "vnext_one_shot_candidate_file_drift")) {
      return recorded(false);
    }
    throw new Error("vnext_one_shot_preregistration_source_unavailable");
  }
  return recorded(true);
}

/** A stage must match the one signed preregistration, not request assertions. */
export async function assertPromptRefinerVnextOneShotPreregistrationForStage(
  tx: Prisma.TransactionClient,
  pins: PromptRefinerVnextOneShotPreregistrationPins,
  accessorUserId: string,
): Promise<void> {
  const entries = await tx.adminAuditLog.findMany({
    where: { action: ACTION, targetType: TARGET_TYPE, targetId: STAGE_ID },
    take: 2,
  });
  if (entries.length !== 1 || entries[0].actorUserId !== accessorUserId ||
      entries[0].summary !== SUMMARY ||
      canonicalBenchmarkJson(entries[0].metadata ?? null) !==
        canonicalBenchmarkJson(metadataFor(pins, accessorUserId)) ||
      !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, entries[0])) {
    throw new Error("vnext_one_shot_preregistration_unavailable");
  }
}
