import "server-only";

import type { AdminAuditLog, Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { inspectChatRefinerInitialAutoRelease } from
  "@/lib/chatRefinerInitialAutoReleaseStore";
import {
  GUEST_CHAT_SMART_ADAPTIVE_ACTION,
  GUEST_CHAT_SMART_ADAPTIVE_SUMMARY,
  exactGuestChatSmartAdaptiveMetadata,
  guestChatSmartAdaptiveActivationMetadata,
  guestChatSmartAdaptiveActivationPairDigest,
  guestChatSmartAdaptiveConfigDigest,
  guestChatSmartAdaptiveRuntimeBinding,
  type GuestChatSmartAdaptiveRuntimeBinding,
} from "@/lib/guestChatSmartAdaptiveRelease";
import { prisma } from "@/lib/prisma";
import { readPromptRefinerProductAutoGuard } from
  "@/lib/promptRefinerProductOperationalGuard";
import { promptRefinerVnextOneShotAuditReceiptIsValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";

type Tx = Prisma.TransactionClient;

export type GuestChatSmartAdaptiveReleaseInspection = Readonly<
  | { state: "absent" | "invalid"; reason: string }
  | {
      state: "active";
      binding: GuestChatSmartAdaptiveRuntimeBinding;
      activationAuditLogId: string;
      activationPairDigest: string;
      baseRouterActivationAuditLogId: string;
      baseProductActivationAuditLogId: string;
      actorUserId: string;
      approvedAt: string;
    }
>;

const closed = (state: "absent" | "invalid", reason: string) =>
  Object.freeze({ state, reason }) as GuestChatSmartAdaptiveReleaseInspection;

const exactActivation = (row: AdminAuditLog,
  binding: GuestChatSmartAdaptiveRuntimeBinding,
  base: Extract<Awaited<ReturnType<typeof inspectChatRefinerInitialAutoRelease>>,
    { state: "active" }>) => {
  const metadata = row.metadata && typeof row.metadata === "object" &&
    !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown> : null;
  const activationCommit = metadata?.runtimeCommitSha;
  const activationDeployment = metadata?.runtimeDeploymentId;
  const activationFingerprint = metadata?.releaseFingerprint;
  if (typeof activationCommit !== "string" ||
      !/^[0-9a-f]{40}$/.test(activationCommit) ||
      typeof activationDeployment !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        activationDeployment) ||
      typeof activationFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(activationFingerprint)) return false;
  const activationBinding = { ...binding,
    runtimeCommitSha: activationCommit,
    runtimeDeploymentId: activationDeployment,
    releaseFingerprint: activationFingerprint,
    configDigest: guestChatSmartAdaptiveConfigDigest({
      releaseFingerprint: activationFingerprint,
      baseRouterConfigDigest: binding.baseRouterConfigDigest,
    }) };
  return row.action === GUEST_CHAT_SMART_ADAPTIVE_ACTION &&
  row.summary === GUEST_CHAT_SMART_ADAPTIVE_SUMMARY &&
  row.targetType === "GuestChatReleaseFingerprint" &&
  row.targetId === activationBinding.configDigest &&
  Boolean(row.actorUserId) && Boolean(row.entryHash) &&
  exactGuestChatSmartAdaptiveMetadata(row.metadata,
    guestChatSmartAdaptiveActivationMetadata({ binding: activationBinding,
      baseRouterActivationAuditLogId: base.routerActivationAuditLogId,
      baseProductActivationAuditLogId: base.productActivationAuditLogId }));
};

/** Fresh readback. Unknown runtime or database state never becomes authority. */
export async function inspectGuestChatSmartAdaptiveRelease(
  tx: Tx,
  runtime: Record<string, string | undefined> = process.env,
): Promise<GuestChatSmartAdaptiveReleaseInspection> {
  let binding: GuestChatSmartAdaptiveRuntimeBinding;
  try {
    binding = guestChatSmartAdaptiveRuntimeBinding(runtime);
  } catch {
    return closed("invalid", "runtime_controls_invalid");
  }
  const base = await inspectChatRefinerInitialAutoRelease(tx, runtime);
  if (base.state !== "active") {
    return closed("invalid", "base_release_inactive");
  }
  const guard = await readPromptRefinerProductAutoGuard(tx);
  if (!guard.active) return closed("invalid", "product_auto_guard_inactive");
  const latest = await tx.adminAuditLog.findMany({
    where: { action: GUEST_CHAT_SMART_ADAPTIVE_ACTION,
      targetType: "GuestChatReleaseFingerprint",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1,
  });
  if (latest.length === 0) return closed("absent", "activation_absent");
  const rows = await tx.adminAuditLog.findMany({
    where: { action: GUEST_CHAT_SMART_ADAPTIVE_ACTION,
      targetType: "GuestChatReleaseFingerprint", targetId: latest[0].targetId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 2,
  });
  if (rows.length !== 1 || rows[0].id !== latest[0].id ||
      !exactActivation(rows[0], binding, base)) {
    return closed("invalid", "activation_mismatch");
  }
  const row = rows[0];
  const keys = adminAuditIntegrityKeys(runtime);
  if (keys.length === 0 ||
      !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, row, keys)) {
    return closed("invalid", "activation_audit_invalid");
  }
  return Object.freeze({ state: "active", binding,
    activationAuditLogId: row.id,
    activationPairDigest: guestChatSmartAdaptiveActivationPairDigest({
      activationAuditLogId: row.id,
      activationEntryHash: row.entryHash!,
      metadata: row.metadata,
    }),
    baseRouterActivationAuditLogId: base.routerActivationAuditLogId,
    baseProductActivationAuditLogId: base.productActivationAuditLogId,
    actorUserId: row.actorUserId!, approvedAt: row.createdAt.toISOString() });
}

export async function activateGuestChatSmartAdaptiveRelease(input: {
  session: Session;
  request: Request;
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
}, runtime: Record<string, string | undefined> = process.env) {
  if (!input.session.user?.id || adminAuditIntegrityKeys(runtime).length === 0) {
    throw new Error("guest_chat_smart_adaptive_activation_context_invalid");
  }
  const binding = guestChatSmartAdaptiveRuntimeBinding(runtime);
  if (input.runtimeCommitSha !== binding.runtimeCommitSha ||
      input.runtimeDeploymentId !== binding.runtimeDeploymentId) {
    throw new Error("guest_chat_smart_adaptive_activation_runtime_mismatch");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const base = await inspectChatRefinerInitialAutoRelease(tx, runtime);
    if (base.state !== "active") {
      throw new Error("guest_chat_smart_adaptive_base_release_inactive");
    }
    const prior = await tx.adminAuditLog.findMany({ where: {
      action: GUEST_CHAT_SMART_ADAPTIVE_ACTION,
      targetType: "GuestChatReleaseFingerprint",
      targetId: binding.configDigest,
    }, select: { id: true }, take: 1 });
    if (prior.length !== 0) {
      throw new Error("guest_chat_smart_adaptive_activation_duplicate");
    }
    const activationAuditLogId = await writeAdminAuditLog({ tx,
      session: input.session, request: input.request,
      action: GUEST_CHAT_SMART_ADAPTIVE_ACTION,
      targetType: "GuestChatReleaseFingerprint",
      targetId: binding.configDigest,
      summary: GUEST_CHAT_SMART_ADAPTIVE_SUMMARY,
      metadata: guestChatSmartAdaptiveActivationMetadata({ binding,
        baseRouterActivationAuditLogId: base.routerActivationAuditLogId,
        baseProductActivationAuditLogId: base.productActivationAuditLogId }),
    });
    const readback = await inspectGuestChatSmartAdaptiveRelease(tx, runtime);
    if (readback.state !== "active" ||
        readback.activationAuditLogId !== activationAuditLogId) {
      throw new Error("guest_chat_smart_adaptive_activation_readback_invalid");
    }
    return Object.freeze({ releaseKind: "guest_chat_smart_adaptive_v2" as const,
      activationAuditLogId,
      activationPairDigest: readback.activationPairDigest,
      runtimeCommitSha: binding.runtimeCommitSha,
      runtimeDeploymentId: binding.runtimeDeploymentId,
      rolloutChanged: false as const });
  }, { maxWait: 5_000, timeout: 30_000 });
}

export async function readGuestChatSmartAdaptiveRelease(
  runtime: Record<string, string | undefined> = process.env,
) {
  try {
    guestChatSmartAdaptiveRuntimeBinding(runtime);
  } catch {
    return null;
  }
  return prisma.$transaction(async (tx) => {
    const release = await inspectGuestChatSmartAdaptiveRelease(tx, runtime);
    return release.state === "active" ? release : null;
  }, { maxWait: 2_000, timeout: 10_000 });
}
