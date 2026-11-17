import "server-only";

import type { Session } from "next-auth";

import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { amuxV4ApprovedCliCostProfileMatches } from "./ideaAnalysisApprovedCostProfile.ts";
import { AmuxIdeaAnalysisReservationError,
  commitAmuxIdeaAnalysisBudgetReservation } from "./ideaAnalysisBudgetReservationService.ts";
import type { AmuxContentKeys } from "./ideaCrypto.ts";
import { loadAmuxContentKeyRing } from "./ideaKeyStore.ts";
import { AMUX_IDEA_EXECUTION_APPROVAL_TRANSACTION } from "./ideaRequestTimeoutsCore.ts";
import type { IdeaTransferConfirmationRequest } from "./ideaTransferConfirmationCore.ts";
import { IdeaTransferConfirmationError,
  commitIdeaTransferConfirmation } from "./ideaTransferConfirmationService.ts";

/** The analysis reservation route's own switch (the monthly budget write); the composite honours it too. */
export const AMUX_V4_ANALYSIS_BUDGET_RESERVE_ENV = "TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE";

export class IdeaExecutionApprovalError extends Error {
  constructor(readonly code: "not_found" | "disabled" | "price_profile_unapproved" |
    "integrity_unavailable" | "outcome_unknown") {
    super(code);
    this.name = "IdeaExecutionApprovalError";
  }
}

export type IdeaExecutionApprovalRequest = {
  confirmation: IdeaTransferConfirmationRequest;
  holdId: string;
  priceVersionId: string;
};

export function ideaExecutionApprovalPermitted(env: Readonly<Record<string, string | undefined>>) {
  return env[AMUX_V4_ANALYSIS_BUDGET_RESERVE_ENV] === "enabled";
}

/**
 * The owner's one execution approval (amux-intake.md v18 item 1): confirming
 * the exact transfer preview and reserving its analysis budget are one
 * decision and one transaction. Either both are recorded, with both audit
 * entries, or neither is. Each writer keeps every check it has on its own
 * route; this only removes the second click between them. It calls no model:
 * the local agent still claims the reservation separately.
 */
export async function approveIdeaExecution(session: Session, request: Request,
  input: IdeaExecutionApprovalRequest, browserNonce: string) {
  const actorUserId = session.user?.id;
  if (!actorUserId || !isAdminSession(session) || getAdminRole(session) !== "owner") {
    throw new IdeaExecutionApprovalError("not_found");
  }
  if (!ideaExecutionApprovalPermitted(process.env)) throw new IdeaExecutionApprovalError("disabled");
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new IdeaExecutionApprovalError("integrity_unavailable");
  }
  const { confirmation } = input;
  const [owned, price] = await Promise.all([
    prisma.amuxIdeaSubmission.findFirst({
      where: { id: confirmation.ideaId, actorUserId }, select: { id: true },
    }),
    prisma.amuxIdeaAnalysisPriceVersion.findUnique({ where: { id: input.priceVersionId } }),
  ]);
  if (!owned) throw new IdeaExecutionApprovalError("not_found");
  if (!price || !amuxV4ApprovedCliCostProfileMatches(price)) {
    throw new IdeaExecutionApprovalError("price_profile_unapproved");
  }
  let keys: AmuxContentKeys;
  try {
    keys = await loadAmuxContentKeyRing([{ ideaId: confirmation.ideaId,
      purpose: "transfer_payload", subjectId: confirmation.previewId }]);
  } catch { throw new IdeaExecutionApprovalError("integrity_unavailable"); }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const confirmed = await commitIdeaTransferConfirmation(tx,
        { session, request, choice: confirmation, browserNonce, keys });
      const reserved = await commitAmuxIdeaAnalysisBudgetReservation(tx, {
        session, request, keys,
        holdId: input.holdId, previewId: confirmation.previewId,
        priceVersionId: input.priceVersionId,
        // The same exact, S0-reviewed one-turn profile the reservation route admits.
        runner: { tokenCapsEnforceable: true, billableToolsDisabled: true },
      });
      callbackReturned = true;
      return {
        previewId: confirmed.previewId, ideaId: confirmed.ideaId,
        confirmExpiresAt: confirmed.confirmExpiresAt,
        confirmationAuditId: confirmed.auditId,
        holdId: reserved.holdId, reservedMicroUsd: reserved.reservedMicroUsd,
        reservationAuditId: reserved.auditId,
      };
    }, { ...AMUX_IDEA_EXECUTION_APPROVAL_TRANSACTION });
  } catch (error) {
    // A refusal raised inside the callback rolled the whole decision back.
    // Anything after the callback returned is a commit whose outcome is unknown.
    if (!callbackReturned && (error instanceof IdeaTransferConfirmationError ||
        error instanceof AmuxIdeaAnalysisReservationError)) throw error;
    throw new IdeaExecutionApprovalError("outcome_unknown");
  }
}
