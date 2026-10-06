import "server-only";

import { verifyPromptRefinerVnextOneShotCandidateSourceAtRoot } from
  "@/lib/promptRefinerVnextOneShotCandidateSourceReadback";
import { prisma } from "@/lib/prisma";
import { PROMPT_REFINER_VNEXT_PAID_GUARD_CAPABILITY } from
  "@/lib/promptRefinerVnextOneShotSlotConsumption";
import { promptRefinerVnextOneShotShadowPublicKeyDigest } from
  "@/lib/promptRefinerVnextOneShotShadowProof";
import { observePromptRefinerVnextOneShotDeployment } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotDeploymentReadback";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import type { PromptRefinerVnextOneShotAuditBinding } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v4";
const PREVIOUS_STAGE_ID = "prompt-refiner-vnext-one-shot-v3";
const V5_STAGE_ID = "prompt-refiner-vnext-one-shot-v5";
const V5_PREVIOUS_STAGE_ID = "prompt-refiner-vnext-one-shot-v4";
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export type PromptRefinerVnextOneShotStageRequestPins = Readonly<{
  sourceCommitSha: string;
  sourceManifestDigest: string;
  runnerDigest: string;
  manifestRoot: string;
  runtimeDeploymentId: string;
  runtimeCommitSha: string;
  pricePinDigest: string;
}>;

/**
 * The owner supplies the holdout root and runner digest from separate custody.
 * Source and deployment are read again from the app checkout and Railway;
 * the stage writer checks the registry price under its transaction lock.
 * Request fields for those facts are equality pins only.
 * Full runner/root custody and final dispatch admission remain separate gates.
 */
export async function preparePromptRefinerVnextOneShotStageBinding(
  expected: PromptRefinerVnextOneShotStageRequestPins,
  successor: "v4" | "v5" = "v4",
): Promise<PromptRefinerVnextOneShotAuditBinding & Readonly<{
  sourceCommitPreregistrationVerified: false;
  dispatchAuthorized: false;
}>> {
  // The separate owner-runner supplies these content-free custody pins through
  // server configuration. A request cannot introduce a new root or runner.
  const pinnedRoot = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  const pinnedRunner = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  if (!SHA256.test(pinnedRoot ?? "") || !SHA256.test(pinnedRunner ?? "") ||
      pinnedRoot !== expected.manifestRoot || pinnedRunner !== expected.runnerDigest) {
    throw new Error("vnext_one_shot_stage_custody_pin_mismatch");
  }
  const shadowPublicKey =
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_B64 ?? "";
  const shadowPublicKeyDigest =
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST ?? "";
  const runnerToken = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN ?? "";
  let signerPinValid = false;
  try {
    signerPinValid = SHA256.test(shadowPublicKeyDigest) &&
      promptRefinerVnextOneShotShadowPublicKeyDigest(shadowPublicKey) ===
        shadowPublicKeyDigest;
  } catch {
    signerPinValid = false;
  }
  if (PROMPT_REFINER_VNEXT_PAID_GUARD_CAPABILITY !== "v4-paid-terminal-guard-v1" ||
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED !== "1" ||
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED !== "1" ||
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_WRITE_ENABLED !== "1" ||
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PAID_APPROVAL_WRITE_ENABLED !== "1" ||
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUN_WRITE_ENABLED !== "1" ||
      !signerPinValid || runnerToken.length < 32 || runnerToken.length > 256 ||
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PROVIDER_API_KEY) {
    throw new Error("vnext_one_shot_recovery_capability_unavailable");
  }
  const deployment = await observePromptRefinerVnextOneShotDeployment();
  const previousId = successor === "v5" ? V5_PREVIOUS_STAGE_ID : PREVIOUS_STAGE_ID;
  const previous = await prisma.promptRefinerVnextOneShotStage.findUnique({
    where: { id: previousId },
    select: { sourceCommitSha: true, sourceManifestDigest: true },
  });
  if (!previous || !deployment.commitSha) {
    throw new Error("vnext_one_shot_recovery_source_unavailable");
  }
  const source = await verifyPromptRefinerVnextOneShotCandidateSourceAtRoot(
    process.cwd(), deployment.commitSha, previous,
  );
  if (!deployment.runtimeAndRailwayAgree ||
      !deployment.activeDeploymentConfirmed ||
      !deployment.deploymentId || !deployment.commitSha ||
      source.sourceCommitSha !== previous.sourceCommitSha ||
      !COMMIT.test(expected.sourceCommitSha) ||
      expected.sourceCommitSha !== previous.sourceCommitSha ||
      expected.sourceManifestDigest !== source.sourceManifestDigest ||
      expected.runtimeDeploymentId !== deployment.deploymentId ||
      expected.runtimeCommitSha !== deployment.commitSha ||
      expected.pricePinDigest !== PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST) {
    throw new Error("vnext_one_shot_stage_observation_mismatch");
  }
  return Object.freeze({
    id: successor === "v5" ? V5_STAGE_ID : STAGE_ID,
    // The transaction-level signed preregistration must confirm this source
    // commit; current checkout bytes are independently rehashed above.
    sourceCommitSha: expected.sourceCommitSha,
    sourceManifestDigest: source.sourceManifestDigest,
    runnerDigest: expected.runnerDigest,
    manifestRoot: expected.manifestRoot,
    runtimeDeploymentId: deployment.deploymentId,
    runtimeCommitSha: deployment.commitSha,
    pricePinDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
    perRequestCostMicroUsd: BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD),
    slotCount: PROMPT_REFINER_VNEXT_SLOT_COUNT,
    costCeilingMicroUsd: BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD),
    sourceCommitPreregistrationVerified: false,
    dispatchAuthorized: false,
  });
}
