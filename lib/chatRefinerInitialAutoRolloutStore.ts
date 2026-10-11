import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import {
  CHAT_REFINER_INITIAL_AUTO_POLICY_COMMIT,
  CHAT_REFINER_INITIAL_AUTO_POLICY_SHA256,
} from "@/lib/chatRefinerInitialAutoRelease";
import { inspectChatRefinerInitialAutoRelease } from
  "@/lib/chatRefinerInitialAutoReleaseStore";
import { prisma } from "@/lib/prisma";
import { PROMPT_REFINER_FLAG_KEY } from "@/lib/promptRefinerAccess";

export const CHAT_REFINER_INITIAL_AUTO_ROLLOUT_ENABLED_ACTION =
  "prompt_refiner.product_initial_auto_rollout_enabled" as const;
export const CHAT_REFINER_INITIAL_AUTO_ROLLOUT_DISABLED_ACTION =
  "prompt_refiner.product_initial_auto_rollout_disabled" as const;

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function setChatRefinerInitialAutoRollout(input: {
  session: Session;
  request: Request;
  enabled: boolean;
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
}, runtime: Record<string, string | undefined> = process.env) {
  const runtimeCommitSha = runtime.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "";
  const runtimeDeploymentId = runtime.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase() ?? "";
  if (!input.session.user?.id || !SHA.test(runtimeCommitSha) ||
      !UUID.test(runtimeDeploymentId) || input.runtimeCommitSha !== runtimeCommitSha ||
      input.runtimeDeploymentId !== runtimeDeploymentId) {
    throw new Error("chat_refiner_initial_auto_rollout_context_invalid");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const authority = input.enabled
      ? await inspectChatRefinerInitialAutoRelease(tx, runtime)
      : null;
    if (input.enabled && authority?.state !== "active") {
      throw new Error("chat_refiner_initial_auto_rollout_authority_invalid");
    }
    const existing = await tx.appSetting.findUnique({
      where: { key: PROMPT_REFINER_FLAG_KEY }, select: { value: true },
    });
    const before = existing?.value ?? null;
    const after = input.enabled ? "true" : "false";
    await tx.appSetting.upsert({
      where: { key: PROMPT_REFINER_FLAG_KEY },
      create: { key: PROMPT_REFINER_FLAG_KEY, value: after },
      update: { value: after },
    });
    const auditLogId = await writeAdminAuditLog({ tx, session: input.session,
      request: input.request,
      action: input.enabled
        ? CHAT_REFINER_INITIAL_AUTO_ROLLOUT_ENABLED_ACTION
        : CHAT_REFINER_INITIAL_AUTO_ROLLOUT_DISABLED_ACTION,
      targetType: "AppSetting", targetId: PROMPT_REFINER_FLAG_KEY,
      summary: input.enabled
        ? "Enabled the exact-deployment Prompt Refiner initial Auto rollout."
        : "Disabled the Prompt Refiner initial Auto rollout.",
      metadata: {
        version: "prompt-refiner-product-initial-auto-rollout-v1",
        policyCommit: CHAT_REFINER_INITIAL_AUTO_POLICY_COMMIT,
        policySha256: CHAT_REFINER_INITIAL_AUTO_POLICY_SHA256,
        before, after, runtimeCommitSha, runtimeDeploymentId,
        routerActivationAuditLogId: authority?.state === "active"
          ? authority.routerActivationAuditLogId : null,
        productActivationAuditLogId: authority?.state === "active"
          ? authority.productActivationAuditLogId : null,
      },
    });
    const readback = await tx.appSetting.findUnique({
      where: { key: PROMPT_REFINER_FLAG_KEY }, select: { value: true },
    });
    if (readback?.value !== after) {
      throw new Error("chat_refiner_initial_auto_rollout_readback_invalid");
    }
    return Object.freeze({ enabled: input.enabled, changed: before !== after,
      auditLogId, runtimeCommitSha, runtimeDeploymentId });
  }, { maxWait: 5_000, timeout: 30_000 });
}
