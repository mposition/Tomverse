import "server-only";

import type { Prisma } from "@prisma/client";

import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";

/** Keep the stage's approved price live at run, shadow and paid admission. */
export async function assertPromptRefinerVnextOneShotCurrentPrice(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const price = await readPromptRefinerVnextOneShotPrice(tx);
  if (!price.pricePinMatchesRegistry || price.problems.length !== 0) {
    throw new Error("vnext_one_shot_price_mismatch");
  }
}
