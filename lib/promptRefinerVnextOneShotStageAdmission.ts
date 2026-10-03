import "server-only";

import { previewPromptRefinerVnextOneShotCandidateSourcePin } from
  "@/lib/promptRefinerVnextOneShotCandidateSourceReadback";
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

const STAGE_ID = "prompt-refiner-vnext-one-shot-v1";
const SHA256 = /^[0-9a-f]{64}$/;

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
): Promise<PromptRefinerVnextOneShotAuditBinding> {
  // The separate owner-runner supplies these content-free custody pins through
  // server configuration. A request cannot introduce a new root or runner.
  const pinnedRoot = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  const pinnedRunner = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  if (!SHA256.test(pinnedRoot ?? "") || !SHA256.test(pinnedRunner ?? "") ||
      pinnedRoot !== expected.manifestRoot || pinnedRunner !== expected.runnerDigest) {
    throw new Error("vnext_one_shot_stage_custody_pin_mismatch");
  }
  const source = await previewPromptRefinerVnextOneShotCandidateSourcePin();
  const deployment = await observePromptRefinerVnextOneShotDeployment();
  if (!deployment.runtimeAndRailwayAgree ||
      !deployment.activeDeploymentConfirmed ||
      !deployment.deploymentId || !deployment.commitSha ||
      source.sourceCommitSha !== deployment.commitSha ||
      expected.sourceCommitSha !== source.sourceCommitSha ||
      expected.sourceManifestDigest !== source.sourceManifestDigest ||
      expected.runtimeDeploymentId !== deployment.deploymentId ||
      expected.runtimeCommitSha !== deployment.commitSha ||
      expected.pricePinDigest !== PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST) {
    throw new Error("vnext_one_shot_stage_observation_mismatch");
  }
  return Object.freeze({
    id: STAGE_ID,
    sourceCommitSha: source.sourceCommitSha,
    sourceManifestDigest: source.sourceManifestDigest,
    runnerDigest: expected.runnerDigest,
    manifestRoot: expected.manifestRoot,
    runtimeDeploymentId: deployment.deploymentId,
    runtimeCommitSha: deployment.commitSha,
    pricePinDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
    perRequestCostMicroUsd: BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD),
    slotCount: PROMPT_REFINER_VNEXT_SLOT_COUNT,
    costCeilingMicroUsd: BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD),
  });
}
