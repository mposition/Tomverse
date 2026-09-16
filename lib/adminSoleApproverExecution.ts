import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import {
    approvalPayloadHash,
    approvalPermissionForAction,
    canonicalizeApprovalPayload,
} from "@/lib/adminApprovalCore";
import { getConfiguredAdminAccess, hasAdminPermission } from "@/lib/adminAuth";
import {
    roleHasPermission,
    type AdminPermission,
    type AdminRole,
} from "@/lib/adminAuthCore";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
    checkCampaignCopyBinding,
    checkDryRunBinding,
    decideGeneralSoleApproval,
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
    copy_digest_missing:
        "Confirm the copy you read: the approval has to name what it is approving.",
    copy_digest_mismatch:
        "The copy has changed since it was read. Read it again and approve from what it says now.",
    copy_unreadable:
        "This campaign's copy could not be rendered, so there is nothing to confirm against.",
    approval_executing:
        "An approved request for this change is being carried out right now.",
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
 *
 * `ADMIN_USER_IDS` rows are counted whatever role they show. An administrator
 * admitted by user id takes their role from their *session email* appearing
 * in an `ADMIN_<ROLE>_EMAILS` list (`getAdminRole()`), and configuration alone
 * cannot say which email a user id signs in with -- so the row reads as
 * `readonly` while the person behind it may well be an owner. Leaving them out
 * would count one administrator where there are two and open this path.
 * Counting them fails closed instead: the only cost is that an organisation
 * which admits its sole administrator by id as well as by email must say so
 * with the requester's own id, which is collapsed onto the requester below.
 */
export const eligibleApproverIdentities = (
    permission: AdminPermission,
    session?: Session
) => {
    const requesterId = session?.user?.id?.trim().toLowerCase();
    const requesterEmail = session?.user?.email?.trim().toLowerCase();
    return getConfiguredAdminAccess()
        .filter((row) => row.accessEnabled && !row.expired)
        .flatMap((row) => {
            if (row.identityType === "userId") {
                const id = row.identity.trim().toLowerCase();
                // The requester's own id is the requester, not a second
                // person; without an email to collapse onto it stays distinct
                // and the path stays shut.
                if (
                    requesterId &&
                    requesterEmail &&
                    id === requesterId &&
                    hasAdminPermission(session, permission)
                ) {
                    return [requesterEmail];
                }
                return [`user-id:${id}`];
            }
            return row.role !== "not-authorized" &&
                roleHasPermission(row.role as AdminRole, permission)
                ? [row.identity]
                : [];
        });
};

/**
 * Whether the sole-approver path is open, and when it is not, why.
 *
 * The reason is returned rather than discarded because the caller reports it:
 * a fallback the operator cannot account for is the defect this closed.
 */
export const soleApproverAvailability = (
    action: SoleApproverAction,
    session: Session
) =>
    decideSoleApproverEligibility({
        action,
        eligibleApproverIdentities: eligibleApproverIdentities("ops:write", session),
        requesterIdentity: session.user?.email,
    });

/** Whether the sole-approver path is open, without attempting it. */
export const soleApproverIsAvailable = (
    action: SoleApproverAction,
    session: Session
) => soleApproverAvailability(action, session).allowed;

/**
 * Whether any other two-person action may run on this administrator's word
 * alone (docs/policy/admin-sole-approver.md).
 *
 * Counted against the permission the action itself requires, the same one the
 * approvals route checks before a reviewer may review it. An organisation with
 * one owner and one billing administrator has two people who can approve a
 * refund, so a refund stays two-person there even though only one of them can
 * approve a retention run.
 */
export const generalSoleApprovalAvailability = (
    action: string,
    session: Session
) =>
    decideGeneralSoleApproval({
        action,
        eligibleApproverIdentities: eligibleApproverIdentities(
            approvalPermissionForAction(action),
            session
        ),
        requesterIdentity: session.user?.email,
    });

/**
 * Closes the two-person requests a sole execution is about to carry out, and
 * writes `admin_sole_approver.execution_started` in the same transaction.
 *
 * A request still open for this action and target -- pending or already
 * approved -- would otherwise stay claimable after the sole execution, and the
 * same change could run a second time once a second administrator is back.
 * It is expired rather than consumed: nothing was executed under it, and the
 * audit row names it in `supersededApprovalIds`.
 *
 * One conditional update does it, so there is no window between reading and
 * closing: a reviewer whose approval commits first has their row closed here
 * too, and one who comes second finds the row no longer pending and is told
 * it changed. The intent record commits with the closure or neither does.
 *
 * `payloadHash` narrows the match to the exact request on the general path.
 * The bound paths omit it -- their approval payload is not what they execute
 * (the cleanup retry and the campaign copy are both re-read), so any open
 * request for the same action and target by this administrator is the one
 * being carried out.
 */
/**
 * A transaction-scoped lock on one requester's requests for one action and
 * target. `claimApproval()` and the sole executors take it before reading, so
 * an ordinary claim and a sole execution of the same change cannot interleave.
 * Deliberately coarser than the payload hash: the bound paths do not match on
 * it, and the lock only ever serialises one administrator against themselves.
 */
export const lockApprovalScope = async (
    tx: Prisma.TransactionClient,
    scope: {
        action: string;
        targetType: string;
        targetId?: string | null;
        requesterId: string;
    }
) => {
    // JSON, not a joined string, so no field can contain the separator.
    const key = JSON.stringify([
        "tomverse-admin-approval-scope",
        scope.action,
        scope.targetType,
        scope.targetId || "",
        scope.requesterId,
    ]);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
};

const supersedeOpenRequestsAndRecordStart = async (input: {
    session: Session;
    request?: Request;
    action: string;
    targetType: string;
    targetId?: string | null;
    payloadHash?: string;
    metadata: Record<string, Prisma.InputJsonValue | null | undefined>;
}) => {
    const actorId = input.session.user?.id;
    if (!actorId) throw new Error("An authenticated administrator is required.");
    return prisma.$transaction(async (tx) => {
        // Serialised with `claimApproval()` for the same scope: without it an
        // ordinary claim could move a row to `executing` between this read and
        // this update, and both executions would run.
        await lockApprovalScope(tx, {
            action: input.action,
            targetType: input.targetType,
            targetId: input.targetId,
            requesterId: actorId,
        });
        const now = new Date();
        const scope = {
            action: input.action,
            targetType: input.targetType,
            targetId: input.targetId || null,
            requestedById: actorId,
            ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
        };
        // An approval already being carried out is the same change in flight.
        // Running it again alone would be the duplicate this closure prevents.
        const inFlight = await tx.adminActionApproval.count({
            where: { ...scope, status: "executing", expiresAt: { gt: now } },
        });
        if (inFlight > 0) refuse("approval_executing");
        // The ids recorded are the rows this update actually closed, not the
        // rows an earlier read saw: a reviewer rejecting in between is not
        // something this execution superseded.
        const closed = await tx.adminActionApproval.updateManyAndReturn({
            where: { ...scope, status: { in: ["pending", "approved"] } },
            data: { status: "expired", expiresAt: now },
            select: { id: true },
        });
        const supersededApprovalIds = closed.map((row) => row.id);
        const metadata = { ...input.metadata, supersededApprovalIds };
        await writeAdminAuditLog({
            session: input.session,
            request: input.request,
            action: "admin_sole_approver.execution_started",
            targetType: input.targetType,
            targetId: input.targetId || null,
            summary: `Started ${input.action} as the sole eligible administrator.`,
            metadata,
            tx,
        });
        return metadata;
    });
};

/**
 * Runs a two-person action for the sole eligible administrator, with the audit
 * record standing where the second reviewer would.
 *
 * Called only by `runWithAdminApproval`, after it has checked re-authentication
 * and `generalSoleApprovalAvailability`. Like `runAsSoleApprover`, nothing is
 * written to the approval table: no second person granted anything, and a row
 * would read as though somebody had.
 *
 * The record names the action, target, reason and the hash of the exact
 * payload, so a later reader can tell what was decided and match it against
 * the route's own audit entry (`user.plan_adjusted`, `user.deleted`, ...) which
 * carries the before/after detail. The payload itself is not copied: that
 * detail already lives in the route's entry, and a second copy would repeat
 * whatever personal data it holds.
 */
export async function runAsSoleAdministrator<T>(
    input: {
        session: Session;
        request?: Request;
        action: string;
        targetType: string;
        targetId?: string | null;
        payload: Record<string, unknown>;
        reason: string;
    },
    operation: () => Promise<T>
): Promise<T> {
    const payloadHash = approvalPayloadHash(
        canonicalizeApprovalPayload(input.payload)
    );
    // A durable record of the intent exists before the operation starts. If the
    // audit store is unavailable the operation does not run -- the record is
    // the only control on this path, so it cannot be best-effort.
    const metadata = await supersedeOpenRequestsAndRecordStart({
        session: input.session,
        request: input.request,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        payloadHash,
        metadata: {
            action: input.action,
            rule: "general_sole_administrator",
            eligibleApproverCount: 1,
            confirmed: "request_payload",
            payloadHash,
            reason: input.reason.slice(0, 500),
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
                ...metadata,
                error:
                    error instanceof Error
                        ? `${error.name}: ${error.message}`.slice(0, 1_000)
                        : String(error).slice(0, 1_000),
            },
        }).catch(() => undefined);
        throw error;
    }

    await writeAdminAuditLog({
        session: input.session,
        request: input.request,
        action: "admin_sole_approver.executed",
        targetType: input.targetType,
        targetId: input.targetId || null,
        summary: `Executed ${input.action} as the sole eligible administrator.`,
        metadata,
    });
    return result;
}

/**
 * What the sole approver echoed back, and what it is checked against.
 *
 * The proof differs per action because the thing being confirmed differs. The
 * retention path proves *you were shown this preview and nothing has
 * superseded it*; the campaign path proves *you read this copy and it has not
 * changed*. Both close the same hole -- one administrator confirming something
 * other than what they saw -- and neither substitutes for the other, so this
 * is a union rather than a shared "digest" field that would quietly accept the
 * wrong kind.
 */
export type SoleApproverConfirmation =
    | {
          kind: "retention_dry_run";
          submittedRunId: string;
          submittedDigest: string;
      }
    | {
          kind: "campaign_copy";
          /** What the campaign's copy hashes to right now (`campaignDigest()`). */
          currentDigest: string | null;
          submittedDigest: string;
      };

/** What the audit record says was confirmed, without repeating the union. */
const confirmationMetadata = (confirmation: SoleApproverConfirmation) =>
    confirmation.kind === "retention_dry_run"
        ? {
              confirmed: confirmation.kind,
              dryRunId: confirmation.submittedRunId,
              dryRunDigest: confirmation.submittedDigest,
              dryRunMaxAgeMs: DRY_RUN_BINDING_MAX_AGE_MS,
          }
        : {
              confirmed: confirmation.kind,
              // The digest, never the copy: the record says which words were
              // approved without becoming a second copy of them.
              copyDigest: confirmation.submittedDigest,
          };

export async function runAsSoleApprover<T>(
    input: {
        session: Session;
        request?: Request;
        action: SoleApproverAction;
        targetType: string;
        targetId?: string | null;
        confirmation: SoleApproverConfirmation;
    },
    operation: () => Promise<T>
): Promise<T> {
    const actorId = input.session.user?.id;
    if (!actorId) throw new Error("An authenticated administrator is required.");
    await assertRecentAdminAuthentication(input.session);

    const eligibility = decideSoleApproverEligibility({
        action: input.action,
        eligibleApproverIdentities: eligibleApproverIdentities("ops:write", input.session),
        requesterIdentity: input.session.user?.email,
    });
    if (!eligibility.allowed) refuse(eligibility.reason);

    if (input.confirmation.kind === "retention_dry_run") {
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
            submittedRunId: input.confirmation.submittedRunId,
            submittedDigest: input.confirmation.submittedDigest,
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
    } else {
        // The caller reads the current digest, for the same reason the branch
        // above reads the latest run here rather than trusting the request:
        // a confirmation checked against something the requester supplied
        // confirms nothing.
        const binding = checkCampaignCopyBinding({
            submittedDigest: input.confirmation.submittedDigest,
            currentDigest: input.confirmation.currentDigest,
        });
        if (!binding.bound) refuse(binding.reason);
    }

    // Condition 5, first half. A durable record of the intent exists before
    // anything is deleted, for the same reason `runWithAdminApproval` writes
    // one: if the audit store is unavailable, the operation does not run.
    // Open two-person requests for this action and target are closed in the
    // same transaction, so none stays claimable beside this execution.
    await supersedeOpenRequestsAndRecordStart({
        session: input.session,
        request: input.request,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: {
            action: input.action,
            // Named so the record says why one approver was enough, rather
            // than leaving a reader to work it out from configuration that
            // may have changed since.
            eligibleApproverCount: 1,
            ...confirmationMetadata(input.confirmation),
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
                ...confirmationMetadata(input.confirmation),
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
            ...confirmationMetadata(input.confirmation),
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
