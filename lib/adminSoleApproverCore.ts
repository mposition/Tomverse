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
 *
 * ## 2026-09-15: every two-person action, not two of them
 *
 * The scoping above was revisited and widened by an organisational decision
 * (docs/policy/admin-sole-approver.md). In a one-administrator organisation the
 * two-person rule is unsatisfiable for *every* action, not only for campaigns:
 * a manual plan adjustment, a refund above the threshold or an account
 * deletion queued a request nobody could ever grant. The control the second
 * reviewer provided is replaced by the audit record, which the decision
 * accepts as sufficient while one person is accountable for all of it.
 *
 * Two things did not change in 2026-09-15, and one of them changed on
 * 2026-09-24. The bound confirmations on `SOLE_APPROVER_ACTIONS` (dry-run
 * digest, copy digest) stay: they are stronger than the general path, so the
 * general path refuses to stand in for them (`decideGeneralSoleApproval`).
 * The queue that used to return when a second administrator existed does not.
 * The audit record is the control at every count.
 */

/**
 * The only actions this exception may ever cover.
 *
 * A list rather than a predicate, and checked before anything else, so that
 * reaching the sole-approver path requires being named here.
 *
 * ## Two actions, two different arguments
 *
 * `retention.cleanup.execute` is here for the reason above: a schedule already
 * performs the same deletions unattended, so the exception opens nothing new.
 *
 * **`email_campaign.approve` is here for a different reason, and the first
 * argument does not apply to it.** Nothing approves campaign copy unattended;
 * approval *is* the act of a person reading the words, which is what EM-06
 * pins in place. What carries it instead is that in a one-administrator
 * organisation the two-person rule is not strict but **unsatisfiable**: no
 * campaign could ever be approved, so the whole fan-out could never send
 * anything at all. That is the same reasoning the release-gate registry
 * records as `approvalPolicy.soleApproverAllowed`, and it was decided as D5
 * (.github/audits/model-lifecycle-email-2026-08-22.md §21) rather than assumed
 * here.
 *
 * The distinction is written down because the two arguments justify different
 * things. The retention one would extend to any action a schedule already
 * performs; the campaign one was written for an organisation that could not
 * satisfy a second reader. Since 2026-09-24 a second administrator does not
 * close either path. The binding (dry-run digest, copy digest) stays.
 *
 * Neither argument reaches `user.delete` or the refund actions, and when this
 * list was written they stayed two-person. Since 2026-09-15 they reach the
 * sole-administrator path through a third argument instead -- the audit record
 * in place of the second reviewer -- which is `decideGeneralSoleApproval`, not
 * this list. This list now means "actions whose sole approval is bound to a
 * confirmation", and adding an action here still requires such a binding.
 */
export const SOLE_APPROVER_ACTIONS = [
    "retention.cleanup.execute",
    "email_campaign.approve",
] as const;

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
              | "requester_is_not_the_sole_approver";
      };

type SoleApproverCandidates = {
    action: string;
    /**
     * Identities that are configured, active, unexpired and hold the
     * permission the action requires. The caller does that filtering; this
     * only counts.
     */
    eligibleApproverIdentities: readonly string[];
    /** The requesting administrator's identity, in the same form. */
    requesterIdentity: string | null | undefined;
};

export function decideSoleApproverEligibility(
    input: SoleApproverCandidates
): SoleApproverEligibility {
    if (
        !(SOLE_APPROVER_ACTIONS as readonly string[]).includes(input.action)
    ) {
        return { allowed: false, reason: "action_not_eligible" };
    }
    return countSoleApprover(input);
}

export type GeneralSoleApproval =
    | { allowed: true; approverIdentity: string }
    | {
          allowed: false;
          reason:
              | "action_has_bound_path"
              | "no_eligible_approver"
              | "requester_is_not_the_sole_approver";
      };

/**
 * Whether one administrator may execute any other two-person action alone
 * (docs/policy/admin-sole-approver.md).
 *
 * The same count as `decideSoleApproverEligibility`, so condition 6 holds for
 * every action. What it does not do is cover `SOLE_APPROVER_ACTIONS`: those
 * have a bound confirmation that proves the administrator saw what they are
 * approving, and a path without that proof must not become a way around it.
 */
export function decideGeneralSoleApproval(
    input: SoleApproverCandidates
): GeneralSoleApproval {
    if ((SOLE_APPROVER_ACTIONS as readonly string[]).includes(input.action)) {
        return { allowed: false, reason: "action_has_bound_path" };
    }
    return countSoleApprover(input);
}

function countSoleApprover(
    input: SoleApproverCandidates
):
    | { allowed: true; approverIdentity: string }
    | {
          allowed: false;
          reason:
              | "no_eligible_approver"
              | "requester_is_not_the_sole_approver";
      } {
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
    // A second eligible administrator does not restore a queue. The audit
    // record is the control at every count (docs/policy/admin-sole-approver.md).
    const requester = input.requesterIdentity?.trim().toLowerCase();
    if (!requester || !eligible.includes(requester)) {
        return { allowed: false, reason: "requester_is_not_the_sole_approver" };
    }
    return { allowed: true, approverIdentity: requester };
}

/**
 * Why the sole-approver path did not open, in a sentence.
 *
 * The fallback used to be silent: an operator was told an approval was pending
 * and nothing distinguished "two administrators are configured, so the usual
 * path applies" from a misconfiguration. Working that out from the outside
 * took three rounds of screenshots on 2026-08-23, and the answer was in
 * configuration the operator could have read in five seconds if anything had
 * pointed at it.
 *
 * These are statements of fact, not instructions. Two administrators is the
 * ordinary, correct state for most organisations; the sentence says what is
 * true, and leaves whether to change it to the person reading.
 *
 * Kept beside the decision rather than in the panel so a new reason cannot be
 * added without a sentence for it (tests/adminSoleApprover.test.mjs).
 */
export const SOLE_APPROVER_UNAVAILABLE_SENTENCES: Record<
    Exclude<SoleApproverEligibility, { allowed: true }>["reason"],
    string
> = {
    action_not_eligible:
        "This action is confirmed against what was just shown.",
    no_eligible_approver:
        "No active administrator holds the permission this action needs.",
    requester_is_not_the_sole_approver:
        "This session is not an administrator who can run this action.",
};

export const soleApproverUnavailableSentence = (
    reason: string | null | undefined
): string | null =>
    reason && reason in SOLE_APPROVER_UNAVAILABLE_SENTENCES
        ? SOLE_APPROVER_UNAVAILABLE_SENTENCES[
              reason as keyof typeof SOLE_APPROVER_UNAVAILABLE_SENTENCES
          ]
        : null;

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

export type CampaignCopyBinding =
    | { bound: true }
    | {
          bound: false;
          reason: "copy_digest_missing" | "copy_digest_mismatch" | "copy_unreadable";
      };

/**
 * The campaign equivalent of the dry-run binding: the approver echoes the
 * digest of the copy they read, and the server compares it with what the
 * campaign renders now.
 *
 * The retention binding proves *you were shown this preview and it has not
 * been superseded*. This proves *you read this copy and it has not changed* —
 * which is the same guarantee against the same failure, and the one EM-06
 * exists for. Without it a sole approver approves "the campaign", and the
 * campaign is whatever the template says at the moment the send runs.
 *
 * Three differences from the retention binding, each because the thing being
 * confirmed is different:
 *
 *   - **No expiry.** A retention preview is a count of live rows and goes
 *     stale on its own; copy does not change unless somebody edits it, and a
 *     mismatch is then the whole signal. A clock here would refuse a correct
 *     approval for no reason.
 *   - **No owner check.** A digest is a property of the copy, not a stored
 *     preview belonging to an administrator, so "somebody else ran it" has no
 *     meaning.
 *   - **A null current digest is a refusal, not a pass.** It means the copy
 *     could not be rendered to compare against, and approving words nobody
 *     could read is the failure this whole path is built around.
 */
export function checkCampaignCopyBinding(input: {
    /** What the approver echoed back. */
    submittedDigest: string | null | undefined;
    /** What the campaign's copy hashes to right now, per `campaignDigest()`. */
    currentDigest: string | null | undefined;
}): CampaignCopyBinding {
    const submitted = input.submittedDigest?.trim();
    if (!submitted) return { bound: false, reason: "copy_digest_missing" };
    const current = input.currentDigest?.trim();
    if (!current) return { bound: false, reason: "copy_unreadable" };
    if (submitted !== current) {
        return { bound: false, reason: "copy_digest_mismatch" };
    }
    return { bound: true };
}
