import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES,
  promptRefinerVnextOneShotApprovalAuditMetadata,
  type PromptRefinerVnextOneShotAuditBinding,
} from "@/lib/promptRefinerVnextOneShotAuditReadback";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const DEPLOYMENT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const APPROVABLE_STAGE_IDS = new Set([
  "prompt-refiner-vnext-one-shot-v3",
  "prompt-refiner-vnext-one-shot-v4",
  "prompt-refiner-vnext-one-shot-v5",
]);

function assertExactBinding(binding: PromptRefinerVnextOneShotAuditBinding): void {
  if (!binding || !APPROVABLE_STAGE_IDS.has(binding.id) ||
      !HEX_40.test(binding.sourceCommitSha) ||
      !HEX_64.test(binding.sourceManifestDigest) ||
      !HEX_64.test(binding.runnerDigest) ||
      !HEX_64.test(binding.manifestRoot) ||
      !DEPLOYMENT_ID.test(binding.runtimeDeploymentId) ||
      !HEX_40.test(binding.runtimeCommitSha) ||
      !HEX_64.test(binding.pricePinDigest) ||
      binding.perRequestCostMicroUsd !==
        BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) ||
      binding.slotCount !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
      binding.costCeilingMicroUsd !==
        BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD)) {
    throw new Error("vnext_one_shot_stage_audit_binding_invalid");
  }
}

/**
 * A06 only: append the human stage approval through the existing hash-chain
 * writer, never in a separate transaction. The future stage/80-slot writer
 * must use this audit ID and insert its rows in this same short transaction.
 * It must pass server-reobserved pins, not caller assertions. This helper does
 * not check owner reauthentication or authorize a stage, run, or dispatch.
 */
export async function writePromptRefinerVnextOneShotStageApprovalAudit(input: {
  tx: Prisma.TransactionClient;
  session: Session;
  request: Request;
  binding: PromptRefinerVnextOneShotAuditBinding;
}): Promise<{ auditLogId: string; approvedBy: string }> {
  if (!input?.tx || !input.session?.user?.id || !input.request) {
    throw new Error("vnext_one_shot_stage_audit_context_invalid");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_stage_audit_key_unavailable");
  }
  assertExactBinding(input.binding);
  // The chain lock comes before future stage/registry/slot row locks.
  await takeAuditChainLock(input.tx);
  const auditLogId = await writeAdminAuditLog({
    tx: input.tx,
    session: input.session,
    request: input.request,
    action: "prompt_refiner.vnext_one_shot.stage_approved",
    targetType: "PromptRefinerVnextOneShotStage",
    targetId: input.binding.id,
    summary: PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES.stage,
    metadata: promptRefinerVnextOneShotApprovalAuditMetadata(input.binding, "stage"),
  });
  return { auditLogId, approvedBy: input.session.user.id };
}
