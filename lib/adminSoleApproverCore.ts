/**
 * When one administrator may execute a two-person action alone.
 *
 * `canReviewAdminApproval()` requires `requestedById !== reviewerId`, which is
 * the right rule and has one consequence nobody chose: an organisation with a
 * single administrator cannot run `retention.cleanup.execute` at all. The
 * `f3974ef` and `4380bc1` staging rounds both recorded it. It matters because
 * that action is the operational recovery path for a sweep that has fallen
 * behind -- and the automatic schedule performs the same deletions on its own
 * every fifteen minutes, so this opens no deletion the system does not already
 * do unattended.
 *
 * That is the whole argument, and it is why the exception is scoped to the
 * action rather than granted globally. A general self-approval switch would
 * also cover `user.delete` and the refund actions, where no schedule performs
 * the equivalent and the second reviewer is the only control there is.
 *
 * Six conditions, decided 2026-08-23:
 *
 *   1. exactly one active eligible administrator
 *   2. the request is bound to the digest of the latest dry run
 *   3. a short expiry, and the execution re-confirms
 *   4. no arbitrary cutoff, no widening of scope
 *   5. request, execution and result are audited
 *   6. a second administrator restores the two-person path automatically
 *
 * (6) is why eligibility is a parameter rather than state: it is recomputed
 * from configuration on every request, so adding an administrator closes this
 * path on the next call with nothing to migrate and nothing to remember to
 * turn off. A stored "sole administrator mode" flag would have to be noticed
 * and cleared by someone.
 *
 * (4) is enforced by the operation, not here: `cleanupExpiredData()` takes no
 * arguments and reads its cutoffs from `lib/retentionPolicyCore.ts`, so there
 * is no parameter through which a caller could widen what gets deleted. The
 * request schema stays `.strict()` so one cannot be added without a test
 * noticing (tests/adminSoleApprover.test.mjs).
 *
 * Pure. The caller supplies who is eligible and what the latest dry run was.
 */

/**
 * The only actions this exception may ever cover.
 *
 * A list rather than a predicate, and checked before anything else, so that
 * reaching the sole-approver path requires being named here.
 */
export const SOLE_APPROVER_ACTIONS = ["retention.cleanup.execute"] as const;

export type SoleApproverAction = (typeof SOLE_APPROVER_ACTIONS)[number];

/**
 * How long a dry run may stand behind an execution.
 *
 * Short because the preview is a count of live rows: the sweep runs every
 * fifteen minutes on its own, so a preview older than one cycle can describe
 * a queue that no longer exists. The operator would be confirming numbers that
 * were true when they looked and are not true when they act.
 */
export const DRY_RUN_BINDING_MAX_AGE_MS = 15 * 60 * 1000;

export type SoleApproverEligibility =
    | { allowed: true; approverIdentity: string }
    | {
          allowed: false;
          reason:
              | "action_not_eligible"
              | "no_eligible_approver"
              | "multiple_eligible_approvers"
              | "requester_is_not_the_sole_approver";
      };

export function decideSoleApproverEligibility(input: {
    action: string;
    /**
     * Identities that are configured, active, unexpired and hold the
     * permission the action requires. The caller does that filtering; this
     * only counts.
     */
    eligibleApproverIdentities: readonly string[];
    /** The requesting administrator's identity, in the same form. */
    requesterIdentity: string | null | undefined;
}): SoleApproverEligibility {
    if (
        !(SOLE_APPROVER_ACTIONS as readonly string[]).includes(input.action)
    ) {
        return { allowed: false, reason: "action_not_eligible" };
    }
    const eligible = Array.from(
        new Set(
            input.eligibleApproverIdentities
                .map((identity) => identity.trim().toLowerCase())
                .filter(Boolean)
        )
    );
    if (eligible.length === 0) {
        return { allowed: false, reason: "no_eligible_approver" };
    }
    // Condition 6. Two administrators can review each other, so the reason
    // this exception exists has gone away and the ordinary path applies again.
    if (eligible.length > 1) {
        return { allowed: false, reason: "multiple_eligible_approvers" };
    }
    const requester = input.requesterIdentity?.trim().toLowerCase();
    if (!requester || requester !== eligible[0]) {
        return { allowed: false, reason: "requester_is_not_the_sole_approver" };
    }
    return { allowed: true, approverIdentity: eligible[0] };
}

export type DryRunBinding =
    | { bound: true }
    | {
          bound: false;
          reason:
              | "preview_missing"
              | "preview_not_a_dry_run"
              | "preview_superseded"
              | "preview_digest_mismatch"
              | "preview_expired"
              | "preview_belongs_to_another_administrator";
      };

export function checkDryRunBinding(input: {
    /** What the execution request echoed back. */
    submittedRunId: string;
    submittedDigest: string;
    /**
     * The most recent retention run of any mode, and the digest of its stored
     * result computed server-side. Reading the *latest* run rather than the
     * submitted one is deliberate: it is what makes a superseded preview
     * detectable at all.
     */
    latestRun:
        | {
              id: string;
              mode: string;
              digest: string;
              createdAt: Date;
              createdById: string | null;
          }
        | null
        | undefined;
    requesterId: string;
    now: Date;
    maxAgeMs?: number;
}): DryRunBinding {
    // Nothing was confirmed. Reached when the sole-approver path is open and
    // the caller executed without running a preview first, which must refuse
    // here rather than fall through to an approval nobody can grant.
    if (!input.submittedRunId || !input.submittedDigest) {
        return { bound: false, reason: "preview_missing" };
    }
    const latest = input.latestRun;
    if (!latest) return { bound: false, reason: "preview_missing" };
    // A newer run exists, so the numbers the operator confirmed are not the
    // newest ones. Reported as superseded rather than "not found": the id they
    // sent may well exist, and saying so is what tells them to look again.
    if (latest.id !== input.submittedRunId) {
        return { bound: false, reason: "preview_superseded" };
    }
    if (latest.mode !== "dry-run") {
        return { bound: false, reason: "preview_not_a_dry_run" };
    }
    if (latest.createdById !== input.requesterId) {
        return {
            bound: false,
            reason: "preview_belongs_to_another_administrator",
        };
    }
    // Condition 3's re-confirmation. The digest is of the stored result, so
    // echoing it is only possible for someone who was shown that preview --
    // and it cannot be produced from the run id alone.
    if (latest.digest !== input.submittedDigest) {
        return { bound: false, reason: "preview_digest_mismatch" };
    }
    const maxAgeMs = input.maxAgeMs ?? DRY_RUN_BINDING_MAX_AGE_MS;
    if (input.now.getTime() - latest.createdAt.getTime() > maxAgeMs) {
        return { bound: false, reason: "preview_expired" };
    }
    return { bound: true };
}
