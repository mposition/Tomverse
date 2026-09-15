import "server-only";

import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  approvalPayloadHash,
  approvalTtlMinutes,
  canonicalizeApprovalPayload,
  executionLeaseExpiresAt,
} from "@/lib/adminApprovalCore";
import { prisma } from "@/lib/prisma";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import {
  adminSoleApproverErrorResponse,
  generalSoleApprovalAvailability,
  lockApprovalScope,
  runAsSoleAdministrator,
} from "@/lib/adminSoleApproverExecution";

type ApprovalInput = {
  session: Session;
  action: string;
  targetType: string;
  targetId?: string | null;
  payload: Record<string, unknown>;
  reason: string;
  request?: Request;
};

export class AdminApprovalRequiredError extends Error {
  approvalId: string;
  approvalStatus: string;
  /**
   * Why the sole-administrator path did not open, when it could have. Absent
   * for actions that have their own bound path, whose route reports it.
   */
  soleApproverUnavailable?: string;

  constructor(
    approvalId: string,
    approvalStatus: string,
    soleApproverUnavailable?: string
  ) {
    super(
      approvalStatus === "pending"
        ? `Approval ${approvalId} is pending review by another authorized administrator.`
        : `Approval ${approvalId} must be approved by another authorized administrator before retrying.`
    );
    this.name = "AdminApprovalRequiredError";
    this.approvalId = approvalId;
    this.approvalStatus = approvalStatus;
    this.soleApproverUnavailable = soleApproverUnavailable;
  }
}

const claimApproval = async (input: ApprovalInput) => {
  const actorId = input.session.user?.id;
  if (!actorId) throw new Error("An authenticated administrator is required.");
  const payload = canonicalizeApprovalPayload(input.payload) as Prisma.InputJsonValue;
  const payloadHash = approvalPayloadHash(payload);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() +
      approvalTtlMinutes(process.env.ADMIN_APPROVAL_TTL_MINUTES) * 60_000
  );

  return prisma.$transaction(async (tx) => {
    // Shared with the sole executors, so a sole execution cannot close or skip
    // a row while this claim is moving it to `executing`.
    await lockApprovalScope(tx, {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      requesterId: actorId,
    });
    await tx.adminActionApproval.updateMany({
      where: {
        status: { in: ["pending", "approved"] },
        expiresAt: { lte: now },
      },
      data: { status: "expired" },
    });
    const existing = await tx.adminActionApproval.findFirst({
      where: {
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId || null,
        payloadHash,
        requestedById: actorId,
        status: { in: ["pending", "approved"] },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!existing) {
      const created = await tx.adminActionApproval.create({
        data: {
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId || null,
          reason: input.reason,
          payload,
          payloadHash,
          requestedById: actorId,
          requestedByEmail: input.session.user?.email || null,
          expiresAt,
        },
      });
      return { approval: created, claimed: false, created: true };
    }

    if (existing.status !== "approved") {
      return { approval: existing, claimed: false, created: false };
    }
    const claimed = await tx.adminActionApproval.updateMany({
      where: {
        id: existing.id,
        status: "approved",
        expiresAt: { gt: now },
      },
      data: {
        status: "executing",
        consumedById: actorId,
        consumedByEmail: input.session.user?.email || null,
        // While a row is executing, expiresAt is its execution lease, not the
        // approval's deadline. The sole closure treats an unexpired executing
        // row as the same change in flight; a claim made a second before the
        // approval lapsed must not read as stale while its operation runs.
        expiresAt: executionLeaseExpiresAt(existing.expiresAt, now),
      },
    });
    return {
      approval: existing,
      claimed: claimed.count === 1,
      created: false,
    };
  });
};

export async function runWithAdminApproval<T>(
  input: ApprovalInput,
  operation: () => Promise<T>
): Promise<T> {
  await assertRecentAdminAuthentication(input.session);

  // docs/policy/admin-sole-approver.md. With exactly one administrator able to
  // approve this action, `requestedById !== reviewerId` cannot be satisfied and
  // the request would wait for a reviewer who does not exist. That
  // administrator executes it alone, audited. Recomputed from configuration on
  // every call, so a second eligible administrator restores the two-person
  // path below with nothing to migrate.
  const soleApproval = generalSoleApprovalAvailability(
    input.action,
    input.session
  );
  if (soleApproval.allowed) {
    return runAsSoleAdministrator(input, operation);
  }

  const claim = await claimApproval(input);
  if (!claim.claimed) {
    if (claim.created) {
      await writeAdminAuditLog({
        session: input.session,
        request: input.request,
        action: "admin_approval.requested",
        targetType: "AdminActionApproval",
        targetId: claim.approval.id,
        summary: `Requested approval for ${input.action}.`,
        metadata: {
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId || null,
          expiresAt: claim.approval.expiresAt.toISOString(),
        },
      });
    }
    throw new AdminApprovalRequiredError(
      claim.approval.id,
      claim.approval.status,
      soleApproval.allowed || soleApproval.reason === "action_has_bound_path"
        ? undefined
        : soleApproval.reason
    );
  }

  // A durable audit intent must exist before the high-risk operation starts.
  // If the audit store is unavailable, the operation is not allowed to run.
  try {
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: "admin_approval.execution_started",
      targetType: input.targetType,
      targetId: input.targetId || null,
      summary: `Started approved operation ${input.action}.`,
      metadata: {
        approvalId: claim.approval.id,
        action: input.action,
      },
    });
  } catch (error) {
    await prisma.adminActionApproval
      .updateMany({
        where: { id: claim.approval.id, status: "executing" },
        data: {
          status: "approved",
          consumedById: null,
          consumedByEmail: null,
          // Back to the approval's own deadline: the lease was for the run
          // that did not happen, and must not extend what was approved.
          expiresAt: claim.approval.expiresAt,
        },
      })
      .catch(() => undefined);
    throw error;
  }

  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await prisma.adminActionApproval
      .updateMany({
        where: { id: claim.approval.id, status: "executing" },
        data: {
          status: "approved",
          consumedById: null,
          consumedByEmail: null,
          // Back to the approval's own deadline: the lease was for the run
          // that did not happen, and must not extend what was approved.
          expiresAt: claim.approval.expiresAt,
        },
      })
      .catch(() => undefined);
    throw error;
  }

  const consumed = await prisma.adminActionApproval.updateMany({
    where: { id: claim.approval.id, status: "executing" },
    data: { status: "consumed", consumedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw new Error("Approved operation could not be marked as consumed.");
  }
  await writeAdminAuditLog({
    session: input.session,
    request: input.request,
    action: "admin_approval.consumed",
    targetType: "AdminActionApproval",
    targetId: claim.approval.id,
    summary: `Consumed approval for ${input.action}.`,
    metadata: {
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId || null,
    },
  });
  return result;
}

/**
 * `extra` is merged into the approval-required body only.
 *
 * It exists for the one case where "an approval is required" is a true but
 * useless answer: an action that has a single-administrator path which did not
 * open. The caller knows why and nothing else does.
 */
export const adminApprovalErrorResponse = (
  error: unknown,
  extra?: Record<string, unknown>
) =>
  isAdminReauthenticationError(error)
    ? NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Sign in again.",
          code: "ADMIN_REAUTHENTICATION_REQUIRED",
        },
        { status: 428 }
      )
    : error instanceof AdminApprovalRequiredError
    ? NextResponse.json(
        {
          error: error.message,
          code: "ADMIN_APPROVAL_REQUIRED",
          approvalId: error.approvalId,
          approvalStatus: error.approvalStatus,
          ...(error.soleApproverUnavailable
            ? { soleApproverUnavailable: error.soleApproverUnavailable }
            : {}),
          ...(extra || {}),
        },
        { status: 409 }
      )
    : // The general sole path runs inside `runWithAdminApproval`, so its
      // refusals reach every route through this one handler rather than
      // falling through to a 500 in routes that never heard of that path.
      adminSoleApproverErrorResponse(error);
