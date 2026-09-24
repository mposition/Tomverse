import "server-only";

import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import {
  adminSoleApproverErrorResponse,
  generalSoleApprovalAvailability,
  refuseSoleApprover,
  runAsSoleAdministrator,
  type AdminApprovalContext,
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

export async function runWithAdminApproval<T>(
  input: ApprovalInput,
  operation: (context: AdminApprovalContext) => Promise<T>
): Promise<T> {
  await assertRecentAdminAuthentication(input.session);

  // docs/policy/admin-sole-approver.md. An eligible administrator executes
  // the action. A second eligible administrator does not queue a review.
  // Bound actions (retention dry run, campaign copy) are refused here so this
  // path cannot skip the confirmation those routes already require.
  const soleApproval = generalSoleApprovalAvailability(
    input.action,
    input.session
  );
  if (!soleApproval.allowed) refuseSoleApprover(soleApproval.reason);
  return runAsSoleAdministrator(input, operation);
}

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
