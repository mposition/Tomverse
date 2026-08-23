import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { approvalPayloadHash } from "@/lib/adminApprovalCore";
import { getConfiguredAdminAccess } from "@/lib/adminAuth";
import { roleHasPermission, type AdminRole } from "@/lib/adminAuthCore";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
    checkDryRunBinding,
    decideSoleApproverEligibility,
    DRY_RUN_BINDING_MAX_AGE_MS,
    type SoleApproverAction,
} from "@/lib/adminSoleApproverCore";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";

/**
 * Executes a two-person action for an organisation that has one administrator.
 *
 * The reasoning, the six conditions and the choice to scope this to a named
 * action rather than a global switch are in `lib/adminSoleApproverCore.ts`.
 * This module supplies that pure decision with facts -- who is configured, and
 * what the latest retention dry run was -- and does the auditing.
 *
 * Refusal is never a fall-through. A caller that asked for this path and was
 * refused is told which condition failed, because "approval required" would
 * describe a path they cannot use.
 */

export class AdminSoleApproverRefusedError extends Error {
    reason: string;

    constructor(reason: string, message: string) {
        super(message);
        this.name = "AdminSoleApproverRefusedError";
        this.reason = reason;
    }
}

const REFUSAL_MESSAGES: Record<string, string> = {
    action_not_eligible:
        "This action always requires a second administrator's approval.",
    no_eligible_approver:
        "No active administrator holds the permission this action requires.",
    multiple_eligible_approvers:
        "More than one administrator can approve, so this action needs the usual second approval.",
    requester_is_not_the_sole_approver:
        "Only the single eligible administrator may execute this action alone.",
    preview_missing: "Run a dry run before executing.",
    preview_not_a_dry_run: "The most recent retention run was not a dry run.",
    preview_superseded:
        "A newer retention run exists. Run a dry run again and execute from its result.",
    preview_digest_mismatch:
        "The dry run result does not match the one being confirmed. Run a dry run again.",
    preview_expired: "The dry run is too old. Run it again and execute from its result.",
    preview_belongs_to_another_administrator:
        "The dry run was created by a different administrator.",
};

const refuse = (reason: string): never => {
    throw new AdminSoleApproverRefusedError(
        reason,
        REFUSAL_MESSAGES[reason] || "This action requires a second approval."
    );
};

/**
 * Identities that could approve this action today.
 *
 * Recomputed per call, which is condition 6: a second administrator being
 * configured closes this path on the next request with nothing to migrate and
 * no flag anybody has to remember to clear.
 */
export const eligibleApproverIdentities = (permission: "ops:write") =>
    getConfiguredAdminAccess()
        .filter(
            (row) =>
                row.accessEnabled &&
                !row.expired &&
                row.role !== "not-authorized" &&
                roleHasPermission(row.role as AdminRole, permission)
        )
        .map((row) => row.identity);

/** Whether the sole-approver path is open, without attempting it. */
export const soleApproverIsAvailable = (
    action: SoleApproverAction,
    session: Session
) =>
    decideSoleApproverEligibility({
        action,
        eligibleApproverIdentities: eligibleApproverIdentities("ops:write"),
        requesterIdentity: session.user?.email,
    }).allowed;

export async function runAsSoleApprover<T>(
    input: {
        session: Session;
        request?: Request;
        action: SoleApproverAction;
        targetType: string;
        targetId?: string | null;
        submittedRunId: string;
        submittedDigest: string;
    },
    operation: () => Promise<T>
): Promise<T> {
    const actorId = input.session.user?.id;
    if (!actorId) throw new Error("An authenticated administrator is required.");
    await assertRecentAdminAuthentication(input.session);

    const eligibility = decideSoleApproverEligibility({
        action: input.action,
        eligibleApproverIdentities: eligibleApproverIdentities("ops:write"),
        requesterIdentity: input.session.user?.email,
    });
    if (!eligibility.allowed) refuse(eligibility.reason);

    // The latest run of any mode, so a preview that something has already
    // superseded is detectable. Fetching the submitted id instead would
    // happily confirm stale numbers.
    const latestRun = await prisma.adminRetentionRun.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            mode: true,
            result: true,
            createdAt: true,
            createdById: true,
        },
    });
    const binding = checkDryRunBinding({
        submittedRunId: input.submittedRunId,
        submittedDigest: input.submittedDigest,
        latestRun: latestRun
            ? {
                  id: latestRun.id,
                  mode: latestRun.mode,
                  digest: approvalPayloadHash(latestRun.result),
                  createdAt: latestRun.createdAt,
                  createdById: latestRun.createdById,
              }
            : null,
        requesterId: actorId,
        now: new Date(),
    });
    if (!binding.bound) refuse(binding.reason);

    // Condition 5, first half. A durable record of the intent exists before
    // anything is deleted, for the same reason `runWithAdminApproval` writes
    // one: if the audit store is unavailable, the operation does not run.
    await writeAdminAuditLog({
        session: input.session,
        request: input.request,
        action: "admin_sole_approver.execution_started",
        targetType: input.targetType,
        targetId: input.targetId || null,
        summary: `Started ${input.action} as the sole eligible administrator.`,
        metadata: {
            action: input.action,
            // Named so the record says why one approver was enough, rather
            // than leaving a reader to work it out from configuration that
            // may have changed since.
            eligibleApproverCount: 1,
            dryRunId: input.submittedRunId,
            dryRunDigest: input.submittedDigest,
            dryRunMaxAgeMs: DRY_RUN_BINDING_MAX_AGE_MS,
        },
    });

    let result: T;
    try {
        result = await operation();
    } catch (error) {
        await writeAdminAuditLog({
            session: input.session,
            request: input.request,
            action: "admin_sole_approver.execution_failed",
            targetType: input.targetType,
            targetId: input.targetId || null,
            summary: `Failed ${input.action} as the sole eligible administrator.`,
            metadata: {
                action: input.action,
                dryRunId: input.submittedRunId,
                error:
                    error instanceof Error
                        ? `${error.name}: ${error.message}`.slice(0, 1_000)
                        : String(error).slice(0, 1_000),
            },
        }).catch(() => undefined);
        throw error;
    }

    // Condition 5, second half. The result is what the operation returned --
    // counts, in this action's case -- so the record says what was deleted
    // rather than only that something was.
    //
    // Round-tripped through JSON rather than cast: the audit column is JSON,
    // and a generic operation could return something that is not, which would
    // fail at write time instead of here.
    const auditableResult = JSON.parse(
        JSON.stringify(result ?? null)
    ) as Prisma.InputJsonValue;
    await writeAdminAuditLog({
        session: input.session,
        request: input.request,
        action: "admin_sole_approver.executed",
        targetType: input.targetType,
        targetId: input.targetId || null,
        summary: `Executed ${input.action} as the sole eligible administrator.`,
        metadata: {
            action: input.action,
            dryRunId: input.submittedRunId,
            result: auditableResult,
        },
    });
    return result;
}

export const adminSoleApproverErrorResponse = (error: unknown) =>
    error instanceof AdminSoleApproverRefusedError
        ? NextResponse.json(
              {
                  error: error.message,
                  code: "ADMIN_SOLE_APPROVER_REFUSED",
                  reason: error.reason,
              },
              { status: 409 }
          )
        : null;
