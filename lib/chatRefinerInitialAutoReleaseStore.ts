import "server-only";

import type { AdminAuditLog, Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { chatRefinerInitialAutoEvidenceRefsSchema,
  type ChatRefinerInitialAutoEvidenceRefs } from
  "@/lib/chatRefinerInitialAutoReleaseApiContract";
import {
  CHAT_REFINER_INITIAL_AUTO_PRODUCT_ACTION,
  CHAT_REFINER_INITIAL_AUTO_PRODUCT_SUMMARY,
  CHAT_REFINER_INITIAL_AUTO_ROUTER_ACTION,
  CHAT_REFINER_INITIAL_AUTO_ROUTER_SUMMARY,
  chatRefinerInitialAutoProductMetadata,
  chatRefinerInitialAutoRouterMetadata,
  chatRefinerInitialAutoRuntimeBinding,
  exactChatRefinerInitialAutoMetadata,
  type ChatRefinerInitialAutoRuntimeBinding,
} from "@/lib/chatRefinerInitialAutoRelease";
import {
  mintChatRefinerInitialAutoRouterAuthority,
  type ChatRefinerInitialAutoRouterAuthority,
} from "@/lib/chatRefinerInitialAutoRouterAuthority";
import { prisma } from "@/lib/prisma";
import { initializePromptRefinerProductAutoGuard } from
  "@/lib/promptRefinerProductOperationalGuard";
import { promptRefinerVnextOneShotAuditReceiptIsValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";

type Tx = Prisma.TransactionClient;

const LEGACY_PRODUCT_ACTIVATION_ACTION =
  "prompt_refiner.product_release_activated" as const;

export type ChatRefinerInitialAutoReleaseInspection = Readonly<
  | { state: "absent" | "invalid"; reason: string }
  | {
      state: "active";
      binding: ChatRefinerInitialAutoRuntimeBinding;
      routerActivationAuditLogId: string;
      productActivationAuditLogId: string;
      actorUserId: string;
      approvedAt: string;
    }
>;

const closed = (state: "absent" | "invalid", reason: string) =>
  Object.freeze({ state, reason }) as ChatRefinerInitialAutoReleaseInspection;

const rowsByAction = (rows: readonly AdminAuditLog[], action: string) =>
  rows.filter((row) => row.action === action);

/**
 * Verifies the exact owner pair, current price row and serving configuration.
 * This function never records a stop or changes rollout state.
 */
export async function inspectChatRefinerInitialAutoRelease(
  tx: Tx,
  runtime: Record<string, string | undefined>,
): Promise<ChatRefinerInitialAutoReleaseInspection> {
  let binding: ChatRefinerInitialAutoRuntimeBinding;
  try {
    binding = chatRefinerInitialAutoRuntimeBinding(runtime);
  } catch {
    return closed("invalid", "runtime_controls_invalid");
  }
  const rows = await tx.adminAuditLog.findMany({
    where: {
      action: { in: [
        CHAT_REFINER_INITIAL_AUTO_ROUTER_ACTION,
        CHAT_REFINER_INITIAL_AUTO_PRODUCT_ACTION,
      ] },
      targetType: "ChatReleaseAuthority",
      targetId: binding.releaseAuthorityDigest,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 3,
  });
  if (rows.length === 0) return closed("absent", "activation_pair_absent");
  const routerRows = rowsByAction(rows, CHAT_REFINER_INITIAL_AUTO_ROUTER_ACTION);
  const productRows = rowsByAction(rows, CHAT_REFINER_INITIAL_AUTO_PRODUCT_ACTION);
  if (routerRows.length !== 1 || productRows.length !== 1) {
    return closed("invalid", "activation_pair_ambiguous");
  }
  const router = routerRows[0];
  const product = productRows[0];
  const routerMetadata = router.metadata && typeof router.metadata === "object" &&
    !Array.isArray(router.metadata)
    ? router.metadata as Record<string, unknown> : null;
  const evidence = chatRefinerInitialAutoEvidenceRefsSchema.safeParse(
    routerMetadata?.evidenceRefs);
  if (!evidence.success) {
    return closed("invalid", "activation_pair_mismatch");
  }
  // The original serving identity is immutable audit provenance. Continued
  // authority compares the stable release fingerprint and effective controls,
  // while the current deployment is still validated before each use.
  const activationCommit = routerMetadata?.runtimeCommitSha;
  const activationDeployment = routerMetadata?.runtimeDeploymentId;
  if (typeof activationCommit !== "string" ||
      !/^[0-9a-f]{40}$/.test(activationCommit) ||
      typeof activationDeployment !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        activationDeployment)) {
    return closed("invalid", "activation_pair_mismatch");
  }
  const activationBinding = { ...binding,
    runtimeCommitSha: activationCommit,
    runtimeDeploymentId: activationDeployment };
  if (!router.actorUserId || router.actorUserId !== product.actorUserId ||
      router.summary !== CHAT_REFINER_INITIAL_AUTO_ROUTER_SUMMARY ||
      product.summary !== CHAT_REFINER_INITIAL_AUTO_PRODUCT_SUMMARY ||
      !router.entryHash || product.previousHash !== router.entryHash ||
      product.createdAt.getTime() <= router.createdAt.getTime() ||
      !exactChatRefinerInitialAutoMetadata(
        router.metadata, chatRefinerInitialAutoRouterMetadata(
          activationBinding, evidence.data)) ||
      !exactChatRefinerInitialAutoMetadata(product.metadata,
        chatRefinerInitialAutoProductMetadata(
          activationBinding, router.id, evidence.data))) {
    return closed("invalid", "activation_pair_mismatch");
  }
  const keys = adminAuditIntegrityKeys(runtime);
  if (keys.length === 0 ||
      !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, router, keys) ||
      !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, product, keys)) {
    return closed("invalid", "activation_pair_audit_invalid");
  }
  const price = await readPromptRefinerVnextOneShotPrice(tx);
  if (!price.pricePinMatchesRegistry || price.problems.length !== 0) {
    return closed("invalid", "price_pin_invalid");
  }
  return Object.freeze({ state: "active", binding,
    routerActivationAuditLogId: router.id,
    productActivationAuditLogId: product.id,
    actorUserId: router.actorUserId,
    approvedAt: product.createdAt.toISOString() });
}

export async function activateChatRefinerInitialAutoRelease(input: {
  session: Session;
  request: Request;
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
  evidenceRefs: ChatRefinerInitialAutoEvidenceRefs;
}, runtime: Record<string, string | undefined> = process.env) {
  if (!input.session.user?.id || adminAuditIntegrityKeys(runtime).length === 0) {
    throw new Error("chat_refiner_initial_auto_activation_context_invalid");
  }
  const evidence = chatRefinerInitialAutoEvidenceRefsSchema.safeParse(
    input.evidenceRefs);
  if (!evidence.success) {
    throw new Error("chat_refiner_initial_auto_activation_evidence_invalid");
  }
  const evidenceRefs = Object.freeze({ ...evidence.data });
  const binding = chatRefinerInitialAutoRuntimeBinding(runtime);
  if (input.runtimeCommitSha !== binding.runtimeCommitSha ||
      input.runtimeDeploymentId !== binding.runtimeDeploymentId) {
    throw new Error("chat_refiner_initial_auto_activation_runtime_mismatch");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const price = await readPromptRefinerVnextOneShotPrice(tx);
    if (!price.pricePinMatchesRegistry || price.problems.length !== 0) {
      throw new Error("chat_refiner_initial_auto_activation_price_invalid");
    }
    const prior = await tx.adminAuditLog.findMany({ where: {
      action: { in: [CHAT_REFINER_INITIAL_AUTO_ROUTER_ACTION,
        CHAT_REFINER_INITIAL_AUTO_PRODUCT_ACTION] },
      targetType: "ChatReleaseAuthority",
      targetId: binding.releaseAuthorityDigest,
    }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1 });
    if (prior.length !== 0) {
      throw new Error("chat_refiner_initial_auto_activation_duplicate");
    }
    const legacy = await tx.adminAuditLog.findMany({ where: {
      action: LEGACY_PRODUCT_ACTIVATION_ACTION,
      targetType: "RailwayDeployment",
      targetId: binding.runtimeDeploymentId,
    }, select: { id: true }, take: 1 });
    if (legacy.length !== 0) {
      throw new Error("chat_refiner_initial_auto_legacy_activation_present");
    }
    const routerActivationAuditLogId = await writeAdminAuditLog({ tx,
      session: input.session, request: input.request,
      action: CHAT_REFINER_INITIAL_AUTO_ROUTER_ACTION,
      targetType: "ChatReleaseAuthority", targetId: binding.releaseAuthorityDigest,
      summary: CHAT_REFINER_INITIAL_AUTO_ROUTER_SUMMARY,
      metadata: chatRefinerInitialAutoRouterMetadata(binding, evidenceRefs),
    });
    const productActivationAuditLogId = await writeAdminAuditLog({ tx,
      session: input.session, request: input.request,
      action: CHAT_REFINER_INITIAL_AUTO_PRODUCT_ACTION,
      targetType: "ChatReleaseAuthority", targetId: binding.releaseAuthorityDigest,
      summary: CHAT_REFINER_INITIAL_AUTO_PRODUCT_SUMMARY,
      metadata: chatRefinerInitialAutoProductMetadata(
        binding, routerActivationAuditLogId, evidenceRefs),
    });
    await initializePromptRefinerProductAutoGuard(tx, productActivationAuditLogId);
    const readback = await inspectChatRefinerInitialAutoRelease(tx, runtime);
    if (readback.state !== "active" ||
        readback.routerActivationAuditLogId !== routerActivationAuditLogId ||
        readback.productActivationAuditLogId !== productActivationAuditLogId) {
      throw new Error("chat_refiner_initial_auto_activation_readback_invalid");
    }
    return Object.freeze({ releaseKind: "initial_auto_v2" as const,
      routerActivationAuditLogId, productActivationAuditLogId,
      runtimeCommitSha: binding.runtimeCommitSha,
      runtimeDeploymentId: binding.runtimeDeploymentId,
      rolloutChanged: false as const });
  }, { maxWait: 5_000, timeout: 30_000 });
}

/** Fresh, uncached authority. Database uncertainty rejects rather than closing as absence. */
export async function readChatRefinerInitialAutoRouterAuthority(
  runtime: Record<string, string | undefined> = process.env,
): Promise<ChatRefinerInitialAutoRouterAuthority | null> {
  try {
    chatRefinerInitialAutoRuntimeBinding(runtime);
  } catch {
    return null;
  }
  return prisma.$transaction(async (tx) => {
    const release = await inspectChatRefinerInitialAutoRelease(tx, runtime);
    if (release.state !== "active") return null;
    return mintChatRefinerInitialAutoRouterAuthority({
      routerActivationAuditLogId: release.routerActivationAuditLogId,
      runtimeCommitSha: release.binding.runtimeCommitSha,
      runtimeDeploymentId: release.binding.runtimeDeploymentId,
    });
  }, { maxWait: 2_000, timeout: 10_000 });
}
