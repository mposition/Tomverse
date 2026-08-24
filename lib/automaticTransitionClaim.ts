/**
 * Whether a retirement notice may promise an automatic change.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §13.3.
 *
 * There is one sentence this whole file exists for:
 *
 * > "Keep this as your default model until the retirement date and Tomverse
 * > will change it to <replacement> for you on <effectiveAt>."
 *
 * It is a promise made to thousands of people at once, and the audit lists
 * twelve conditions that all have to hold before it is true. Any one of them
 * false and the notice says the other thing instead -- "this model stops working
 * on <date>, please pick <replacement> yourself" -- which promises nothing and
 * is therefore always safe to send.
 *
 * ## Why a gate rather than a checklist in a runbook
 *
 * `effectiveAt` and `timezoneLabel` are columns now. A column that lets a
 * campaign name a date is a column that lets a campaign promise something on
 * that date, and the twelve conditions were prose in an audit nobody re-reads
 * at the moment of writing the copy. This is that prose as a function.
 *
 * ## Fail closed, and never on the caller's behalf
 *
 * Nine of the twelve are facts this repository holds -- a work item's status, a
 * registry row, whether an approval was consumed. Three are not:
 *
 *   - `differences_stated` -- whether the body actually names the capability
 *     and credit differences. Only a person who read it knows.
 *   - `reconciliation_ready` -- whether the migration script and the rollback
 *     were rehearsed.
 *   - `staging_verified` -- attested here rather than derived, because a
 *     `validationEvidence` blob being non-empty is not the same fact as
 *     somebody having checked it.
 *
 * Those arrive as explicit attestations, named so nobody mistakes them for
 * something the code worked out. An absent attestation is unmet -- the whole
 * point of a gate is that silence is not consent.
 */

export const TRANSITION_CONDITIONS = [
    "work_item_approved_retirement",
    "effective_at_fixed",
    "replacement_usable",
    "plan_compatible",
    "differences_stated",
    "retirement_ticket",
    "dry_run_counted",
    "staging_verified",
    "reconciliation_ready",
    "communication_approved",
    "owner_assigned",
    "completion_scheduled",
] as const;

export type TransitionCondition = (typeof TRANSITION_CONDITIONS)[number];

/**
 * What each unmet condition means, in the words an operator needs to fix it.
 *
 * Not a generic "condition 7 failed": the twelve are owed to different people
 * -- one is a registry edit, one is a staging session, one is somebody writing
 * a paragraph -- and a list of numbers sends the reader back to the audit.
 */
export const TRANSITION_CONDITION_REASONS: Readonly<
    Record<TransitionCondition, string>
> = {
    work_item_approved_retirement:
        "No approved `retire` work item covers this model. The promise describes a decision that has not been made.",
    effective_at_fixed:
        "The campaign has no effectiveAt and timezone label, so the sentence has no date to name.",
    replacement_usable:
        "The replacement is not enabled, publicly listed and present in the catalogue, so accounts moved onto it would land on a model that cannot answer.",
    plan_compatible:
        "Some accounts in the audience cannot reach the replacement on their plan. They would be promised a change that will not happen for them.",
    differences_stated:
        "Nobody has attested that the body names the capability and credit differences. A silent downgrade is still a downgrade.",
    retirement_ticket:
        "The work item carries no retirement ticket URL, so the decision cannot be traced back to anything.",
    dry_run_counted:
        "No dry run has counted this audience. The promise would be made to a number nobody has looked at.",
    staging_verified:
        "Nobody has attested to a staging verification of the migration.",
    reconciliation_ready:
        "Nobody has attested that the reconciliation script and its rollback are ready. The promise is the easy half; undoing it is the other one.",
    communication_approved:
        "The campaign's approval has not been consumed, so no one has approved the words that carry the promise.",
    owner_assigned:
        "The work item names no owner, so nobody is answerable for running the change on the day.",
    completion_scheduled:
        "No completion wave is scheduled. The promise ends with people never being told it was kept.",
};

/**
 * The facts the twelve conditions are judged against.
 *
 * Read by the caller, judged here, so this can be tested without a database
 * and so a reader can see all twelve in one place rather than spread across a
 * service, a registry lookup and a query.
 */
export type TransitionClaimInput = {
    workItem: {
        found: boolean;
        action: string;
        status: string;
        retirementTicketUrl: string | null;
        ownerEmail: string | null;
    } | null;
    effectiveAt: Date | null;
    timezoneLabel: string | null;
    replacement: {
        found: boolean;
        enabled: boolean;
        publiclyListed: boolean;
        catalogDeleted: boolean;
    } | null;
    /**
     * Audience members the replacement is out of plan reach for.
     *
     * A count rather than a boolean so the refusal can say how many people the
     * promise would be false for -- "some accounts" and "one account" call for
     * different decisions.
     */
    planIncompatibleCount: number;
    /** A dry-run wave has expanded and counted this audience. */
    dryRunRecipientCount: number | null;
    /** The campaign's approval has been consumed, not merely requested. */
    communicationApprovalConsumed: boolean;
    /** A `completion` wave exists with a time on it. */
    completionWaveScheduledAt: Date | null;
    /**
     * The three a person states, because no field holds them. Absent is unmet.
     */
    attestations: {
        differencesStated?: boolean;
        stagingVerified?: boolean;
        reconciliationReady?: boolean;
    };
};

export type TransitionClaim = {
    mayClaim: boolean;
    unmet: TransitionCondition[];
    /** One line per unmet condition, in the order the audit lists them. */
    reasons: string[];
};

/**
 * Which of the twelve are not satisfied. Empty means the sentence may be used.
 */
export const automaticTransitionClaim = (
    input: TransitionClaimInput
): TransitionClaim => {
    const unmet: TransitionCondition[] = [];
    const fail = (condition: TransitionCondition) => unmet.push(condition);

    const workItem = input.workItem;
    if (
        !workItem ||
        !workItem.found ||
        workItem.action !== "retire" ||
        workItem.status !== "approved"
    ) {
        fail("work_item_approved_retirement");
    }

    if (!input.effectiveAt || !input.timezoneLabel?.trim()) {
        // Both, not either. A UTC instant with no timezone label is a date
        // that reads differently to the person receiving it than to the person
        // who set it, and the sentence names a day.
        fail("effective_at_fixed");
    }

    const replacement = input.replacement;
    if (
        !replacement ||
        !replacement.found ||
        !replacement.enabled ||
        !replacement.publiclyListed ||
        replacement.catalogDeleted
    ) {
        fail("replacement_usable");
    }

    if (input.planIncompatibleCount > 0) fail("plan_compatible");

    if (input.attestations.differencesStated !== true) fail("differences_stated");

    if (!workItem?.retirementTicketUrl?.trim()) fail("retirement_ticket");

    // Zero is a count. `null` is nobody having looked, and those are not the
    // same answer -- an audience that really is empty has been measured.
    if (input.dryRunRecipientCount === null) fail("dry_run_counted");

    if (input.attestations.stagingVerified !== true) fail("staging_verified");

    if (input.attestations.reconciliationReady !== true) {
        fail("reconciliation_ready");
    }

    if (!input.communicationApprovalConsumed) fail("communication_approved");

    if (!workItem?.ownerEmail?.trim()) fail("owner_assigned");

    if (!input.completionWaveScheduledAt) fail("completion_scheduled");

    return {
        mayClaim: unmet.length === 0,
        unmet,
        reasons: unmet.map((condition) => TRANSITION_CONDITION_REASONS[condition]),
    };
};
