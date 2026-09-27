import "server-only";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  AMUX_INCIDENT_SETTING_KEY,
  parseAmuxIncidentSetting,
  serializeAmuxIncidentState,
  type AmuxIncidentReading,
  type AmuxIncidentStateName,
} from "@/lib/amux/incidentCore";
import type { AdminApprovalContext } from "@/lib/adminSoleApproverExecution";
import { prisma } from "@/lib/prisma";

export class AmuxIncidentChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmuxIncidentChangedError";
  }
}

/**
 * Serializes admission with incident declarations and clears.
 *
 * Every path that can claim or start new provider work takes this
 * transaction-scoped lock before reading the AppSetting row. Durable
 * deliveries created by an already-admitted start may drain; heartbeat,
 * settlement and recovery deliberately continue too.
 */
export async function lockAmuxAdmissionAndReadIncident(
  tx: Prisma.TransactionClient,
  now = new Date(),
): Promise<AmuxIncidentReading> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tomverse-amux-admission'))`;
  const row = await tx.appSetting.findUnique({
    where: { key: AMUX_INCIDENT_SETTING_KEY },
    select: { value: true },
  });
  return parseAmuxIncidentSetting(row?.value, now);
}

export async function getAmuxIncidentSnapshot() {
  const [row, transitions] = await Promise.all([
    prisma.appSetting.findUnique({
      where: { key: AMUX_INCIDENT_SETTING_KEY },
      select: { value: true, updatedAt: true },
    }),
    prisma.amuxIncidentTransition.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    }),
  ]);
  return {
    ...parseAmuxIncidentSetting(row?.value),
    setting_updated_at: row?.updatedAt.toISOString() ?? null,
    transitions,
  };
}

type ChangeInput = {
  session: Session;
  request?: Request;
  toState: AmuxIncidentStateName;
  reason: string;
  ticket: string;
  expectedTransitionId?: string | null;
  approval?: AdminApprovalContext;
};

const changeAmuxIncidentState = async (input: ChangeInput) => {
  if (!input.session.user?.id)
    throw new Error("An authenticated administrator is required.");

  return prisma.$transaction(async (tx) => {
    const current = await lockAmuxAdmissionAndReadIncident(tx);
    if (
      input.expectedTransitionId !== undefined &&
      current.state.transition_id !== input.expectedTransitionId
    ) {
      throw new AmuxIncidentChangedError(
        "AMUX incident state changed after this action was prepared.",
      );
    }

    if (input.toState === "normal" && current.state.state !== "frozen") {
      throw new AmuxIncidentChangedError(
        "AMUX incident mode is already normal.",
      );
    }

    if (
      input.toState === "frozen" &&
      current.valid &&
      current.state.state === "frozen" &&
      current.state.reason === input.reason &&
      current.state.ticket === input.ticket
    ) {
      return { reading: current, transition: null, idempotent: true as const };
    }

    const changeAuditLogId = await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action:
        input.toState === "frozen"
          ? "amux.incident.declared"
          : "amux.incident.cleared",
      targetType: "AppSetting",
      targetId: AMUX_INCIDENT_SETTING_KEY,
      summary:
        input.toState === "frozen"
          ? `Declared AMUX incident freeze: ${input.ticket}.`
          : `Cleared AMUX incident freeze: ${input.ticket}.`,
      metadata: {
        from_state: current.state.state,
        to_state: input.toState,
        previous_transition_id: current.state.transition_id,
        reason: input.reason,
        ticket: input.ticket,
        approval_id: input.approval?.approvalId ?? null,
        authorization_audit_log_id:
          input.approval?.authorizationAuditLogId ?? null,
      },
      tx,
    });

    const transition = await tx.amuxIncidentTransition.create({
      data: {
        fromState: current.state.state,
        toState: input.toState,
        reason: input.reason,
        ticket: input.ticket,
        approvalId: input.approval?.approvalId ?? null,
        authorizationAuditLogId:
          input.approval?.authorizationAuditLogId ?? null,
        changeAuditLogId,
      },
    });

    const next = {
      version: 1 as const,
      state: input.toState,
      transition_id: transition.id,
      changed_at: transition.createdAt.toISOString(),
      reason: input.reason,
      ticket: input.ticket,
    };
    await tx.appSetting.upsert({
      where: { key: AMUX_INCIDENT_SETTING_KEY },
      create: {
        key: AMUX_INCIDENT_SETTING_KEY,
        value: serializeAmuxIncidentState(next),
      },
      update: { value: serializeAmuxIncidentState(next) },
    });

    return {
      reading: parseAmuxIncidentSetting(serializeAmuxIncidentState(next)),
      transition,
      idempotent: false as const,
    };
  });
};

export const declareAmuxIncident = (input: {
  session: Session;
  request?: Request;
  reason: string;
  ticket: string;
}) =>
  changeAmuxIncidentState({
    ...input,
    toState: "frozen",
  });

export const clearAmuxIncident = (input: {
  session: Session;
  request?: Request;
  reason: string;
  ticket: string;
  expectedTransitionId: string | null;
  approval: AdminApprovalContext;
}) =>
  changeAmuxIncidentState({
    ...input,
    toState: "normal",
  });
