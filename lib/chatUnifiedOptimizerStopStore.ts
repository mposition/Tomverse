import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";

export const CHAT_UNIFIED_OPTIMIZER_STOP_KEY =
  "chat.unified_optimizer.stop_latch.v1" as const;
export const CHAT_UNIFIED_OPTIMIZER_STOP_ACTION =
  "chat.unified_optimizer.stop_latched" as const;

/** An absent latch is open; a malformed value or an unavailable read fails closed. */
export async function readChatUnifiedOptimizerStop(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({
    where: { key: CHAT_UNIFIED_OPTIMIZER_STOP_KEY },
    select: { value: true },
  });
  if (!row) return false;
  if (row.value !== "true") throw new Error("optimizer_stop_latch_invalid");
  return true;
}

/** Owner-only caller. This operation only latches stop; it cannot clear it. */
export async function latchChatUnifiedOptimizerStop(input: Readonly<{
  session: Session;
  request: Request;
}>): Promise<Readonly<{ stopped: true; changed: boolean }>> {
  if (!input.session.user?.id) throw new Error("optimizer_stop_actor_missing");
  return prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    const existing = await tx.appSetting.findUnique({
      where: { key: CHAT_UNIFIED_OPTIMIZER_STOP_KEY },
      select: { value: true },
    });
    if (existing?.value === "true") {
      return Object.freeze({ stopped: true as const, changed: false });
    }
    await tx.appSetting.upsert({
      where: { key: CHAT_UNIFIED_OPTIMIZER_STOP_KEY },
      create: { key: CHAT_UNIFIED_OPTIMIZER_STOP_KEY, value: "true" },
      update: { value: "true" },
    });
    await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: CHAT_UNIFIED_OPTIMIZER_STOP_ACTION,
      targetType: "AppSetting", targetId: CHAT_UNIFIED_OPTIMIZER_STOP_KEY,
      summary: "Latched the Chat unified optimizer stop control.",
      metadata: { version: "chat-unified-optimizer-stop-v1",
        previousValue: existing?.value ?? null, stopped: true },
    });
    const readback = await tx.appSetting.findUnique({
      where: { key: CHAT_UNIFIED_OPTIMIZER_STOP_KEY },
      select: { value: true },
    });
    if (readback?.value !== "true") {
      throw new Error("optimizer_stop_readback_invalid");
    }
    return Object.freeze({ stopped: true as const, changed: true });
  }, { maxWait: 5_000, timeout: 30_000 });
}
