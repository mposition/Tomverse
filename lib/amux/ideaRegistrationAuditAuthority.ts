import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import type { AmuxIdeaUnitConfirmationSnapshot } from
  "./ideaUnitConfirmationCore.ts";
import { isAmuxV19UnitRegistrationAuthority } from
  "./ideaSystemRegistrationCore.ts";

export type AmuxRegistrationAuditAuthority =
  | { session: Session; request: Request }
  | { systemActor: typeof AMUX_V4_IDEA_SYSTEM_ACTOR; actorUserId: string };

export const isAmuxSystemRegistrationAuthority = (
  authority: AmuxRegistrationAuditAuthority,
): authority is Extract<AmuxRegistrationAuditAuthority,
  { systemActor: typeof AMUX_V4_IDEA_SYSTEM_ACTOR }> =>
  "systemActor" in authority &&
  authority.systemActor === AMUX_V4_IDEA_SYSTEM_ACTOR;

export function amuxRegistrationAuthorityActor(
  authority: AmuxRegistrationAuditAuthority,
): string {
  if (isAmuxSystemRegistrationAuthority(authority)) {
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(authority.actorUserId)) {
      throw new Error("AMUX system registration data owner unavailable");
    }
    return authority.actorUserId;
  }
  const id = authority.session.user?.id;
  if (!id || !isAdminSession(authority.session) ||
      getAdminRole(authority.session) !== "owner") {
    throw new Error("AMUX owner registration authority mismatch");
  }
  return id;
}

export function amuxRegistrationDataOwner(
  authority: AmuxRegistrationAuditAuthority,
  snapshot?: Pick<AmuxIdeaUnitConfirmationSnapshot,
    "actorUserId" | "registrationAuthority">,
): string {
  if (isAmuxSystemRegistrationAuthority(authority)) {
    if (!snapshot ||
        snapshot.actorUserId !== authority.actorUserId ||
        !isAmuxV19UnitRegistrationAuthority(
          snapshot.registrationAuthority)) {
      throw new Error("AMUX system registration authority mismatch");
    }
    return authority.actorUserId;
  }
  const id = amuxRegistrationAuthorityActor(authority);
  if (snapshot?.registrationAuthority !== undefined ||
      (snapshot && snapshot.actorUserId !== id)) {
    throw new Error("AMUX owner registration authority mismatch");
  }
  return id;
}

export async function writeAmuxRegistrationAudit(input: {
  tx: Prisma.TransactionClient;
  authority: AmuxRegistrationAuditAuthority;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  metadata: Prisma.InputJsonObject;
}): Promise<string> {
  if (isAmuxSystemRegistrationAuthority(input.authority)) {
    return writeSystemAuditLog({ tx: input.tx,
      systemActor: input.authority.systemActor,
      action: input.action, targetType: input.targetType,
      targetId: input.targetId, summary: input.summary,
      metadata: input.metadata });
  }
  return writeAdminAuditLog({ tx: input.tx,
    session: input.authority.session, request: input.authority.request,
    action: input.action, targetType: input.targetType,
    targetId: input.targetId, summary: input.summary,
    metadata: input.metadata });
}

export const amuxRegistrationAuthorityKind = (
  authority: AmuxRegistrationAuditAuthority,
): "owner" | "system" => isAmuxSystemRegistrationAuthority(authority) ?
    "system" : "owner";
