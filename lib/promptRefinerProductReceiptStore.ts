import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
  promptRefinerDispositionReceiptSchema,
  promptRefinerExecutionReceiptSchema,
  type PromptRefinerDispositionReceipt,
  type PromptRefinerExecutionReceipt,
} from "@/lib/promptRefinerReceiptCore";

const options = { maxWait: 2_000, timeout: 5_000 };
type Tx = Prisma.TransactionClient;

const count = (value: number | null) => value === null ? null : BigInt(value);

/** Insert one closed, content-free execution fact in the caller transaction. */
export async function writePromptRefinerProductExecutionReceipt(
  tx: Tx,
  value: unknown,
  mode: "explicit" | "auto",
): Promise<PromptRefinerExecutionReceipt> {
  const receipt = promptRefinerExecutionReceiptSchema.parse(value);
  await tx.$executeRaw`
    INSERT INTO "PromptRefinerProductExecutionReceipt" (
      "id", "receiptVersion", "requestId", "suggestionId", "refinerVersion",
      "provider", "modelId", "adapterVersion", "outcome", "failureLayer",
      "failureCode", "requestedAt", "dispatchedAt", "completedAt",
      "preparationLatencyMs", "inputTokens", "cachedInputTokens", "outputTokens",
      "reasoningTokens", "actualCostMicroUsd", "retryCount"
    ) VALUES (
      ${receipt.receiptId}, ${receipt.receiptVersion}, ${receipt.requestId},
      ${receipt.suggestionId}, ${receipt.refinerVersion}, ${receipt.provider},
      ${receipt.modelId}, ${receipt.adapterVersion}, ${receipt.outcome},
      ${receipt.failureLayer}, ${receipt.failureCode},
      ${new Date(receipt.requestedAt)},
      ${receipt.dispatchedAt ? new Date(receipt.dispatchedAt) : null},
      ${new Date(receipt.completedAt)}, ${receipt.preparationLatencyMs},
      ${count(receipt.inputTokens)}, ${count(receipt.cachedInputTokens)},
      ${count(receipt.outputTokens)}, ${count(receipt.reasoningTokens)},
      ${count(receipt.actualCostMicroUsd)}, ${receipt.retryCount}
    )
  `;
  await tx.$executeRaw`
    INSERT INTO "PromptRefinerProductExecutionContext" (
      "executionReceiptId", "mode"
    ) VALUES (${receipt.receiptId}, ${mode})
  `;
  await writeSystemAuditLog({
    tx,
    systemActor: "prompt-refiner-product-execution",
    action: "prompt_refiner.product_execution_recorded",
    targetType: "PromptRefinerProductExecutionReceipt",
    targetId: receipt.receiptId,
    summary: "Recorded one content-free Prompt Refiner product execution.",
    metadata: {
      outcome: receipt.outcome,
      failureLayer: receipt.failureLayer,
      failureCode: receipt.failureCode,
      refinerVersion: receipt.refinerVersion,
      retryCount: receipt.retryCount,
    },
  });
  return receipt;
}

/** Insert one closed disposition fact and verify its execution binding in DB. */
export async function writePromptRefinerProductDispositionReceipt(
  tx: Tx,
  value: unknown,
): Promise<PromptRefinerDispositionReceipt> {
  const receipt = promptRefinerDispositionReceiptSchema.parse(value);
  await tx.$executeRaw`
    INSERT INTO "PromptRefinerProductDispositionReceipt" (
      "id", "receiptVersion", "executionReceiptId", "requestId",
      "suggestionId", "outcome", "staleReason", "observedAt"
    ) VALUES (
      ${receipt.dispositionId}, ${receipt.receiptVersion},
      ${receipt.executionReceiptId}, ${receipt.requestId},
      ${receipt.suggestionId}, ${receipt.outcome}, ${receipt.staleReason},
      ${new Date(receipt.observedAt)}
    )
  `;
  await writeSystemAuditLog({
    tx,
    systemActor: "prompt-refiner-product-execution",
    action: "prompt_refiner.product_disposition_recorded",
    targetType: "PromptRefinerProductDispositionReceipt",
    targetId: receipt.dispositionId,
    summary: "Recorded one content-free Prompt Refiner product disposition.",
    metadata: { outcome: receipt.outcome, staleReason: receipt.staleReason },
  });
  return receipt;
}

export async function recordPromptRefinerProductExecutionReceipt(
  value: unknown,
  mode: "explicit" | "auto",
  attemptState: "terminal" | "unknown" = "terminal",
) {
  const receipt = promptRefinerExecutionReceiptSchema.parse(value);
  return prisma.$transaction(async (tx) => {
    const changed = await tx.$executeRaw`
      UPDATE "PromptRefinerProductAttempt" SET "state" = ${attemptState}
      WHERE "id" = ${receipt.requestId} AND "state" = 'preparing'
    `;
    if (changed !== 1) {
      throw new Error("prompt_refiner_product_attempt_transition_invalid");
    }
    await writeSystemAuditLog({ tx,
      systemActor: "prompt-refiner-product-execution",
      action: "prompt_refiner.product_attempt_transitioned",
      targetType: "PromptRefinerProductAttempt", targetId: receipt.requestId,
      summary: "Transitioned one Prompt Refiner product attempt.",
      metadata: { mode, state: attemptState } });
    return writePromptRefinerProductExecutionReceipt(tx, receipt, mode);
  }, options);
}

export async function recordPromptRefinerProductDispositionReceipt(value: unknown) {
  return prisma.$transaction((tx) =>
    writePromptRefinerProductDispositionReceipt(tx, value), options);
}

