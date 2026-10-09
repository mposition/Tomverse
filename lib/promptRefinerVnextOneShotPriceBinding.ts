import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import {
  PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT,
  PROMPT_REFINER_VNEXT_PRICE_PIN,
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import type { PromptRefinerRunnableStageId } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v4";

// The approval writer must store this exact digest. It binds the approved
// registry price to the frozen numeric contract, not to caller-provided facts.
export const PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST = createHash("sha256")
  .update(canonicalBenchmarkJson({
    numericSpecSha256: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.numericSpecSha256,
    pricePin: PROMPT_REFINER_VNEXT_PRICE_PIN,
    maxInputTokens: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.maxInputTokens,
    maxOutputTokens: PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT.maxOutputTokens,
    perRequestCostMicroUsd: PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
    slotCount: PROMPT_REFINER_VNEXT_SLOT_COUNT,
    costCeilingMicroUsd: PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  }), "utf8")
  .digest("hex");

type ApprovedPriceRow = {
  id: string;
  status: string;
  pricePinDigest: string;
  perRequestCostMicroUsd: bigint;
  slotCount: number;
  costCeilingMicroUsd: bigint;
};

/** Recheck the locked approval and current registry price in the app transaction. */
export async function assertPromptRefinerVnextOneShotPriceForAdmission(
  tx: Prisma.TransactionClient,
  stageId: PromptRefinerRunnableStageId = STAGE_ID,
): Promise<void> {
  const rows = await tx.$queryRaw<ApprovedPriceRow[]>`
    SELECT "id", "status", "pricePinDigest", "perRequestCostMicroUsd",
      "slotCount", "costCeilingMicroUsd"
    FROM "PromptRefinerVnextOneShotStage"
    WHERE "id" = ${stageId}
    FOR NO KEY UPDATE NOWAIT
  `;
  const stage = rows.length === 1 ? rows[0] : null;
  if (!stage || stage.id !== stageId) {
    throw new Error("vnext_one_shot_approved_stage_unavailable");
  }
  if (stage.status !== "staged" && stage.status !== "run_approved") {
    throw new Error("vnext_one_shot_approved_stage_inactive");
  }
  if (stage.pricePinDigest !== PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST ||
      stage.perRequestCostMicroUsd !== BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) ||
      stage.slotCount !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
      stage.costCeilingMicroUsd !== BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD)) {
    throw new Error("vnext_one_shot_approved_price_mismatch");
  }

  const price = await readPromptRefinerVnextOneShotPrice(tx);
  if (!price.pricePinMatchesRegistry || price.problems.length !== 0) {
    throw new Error("vnext_one_shot_registry_price_mismatch");
  }
}
