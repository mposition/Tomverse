/**
 * Who a retirement actually affects, counted once each.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §11, §13.
 *
 * Three cohorts overlap heavily -- somebody whose default model is the retiring
 * one usually has conversations selecting it too -- so the number that matters
 * is distinct people, not summed rows. The audit's own worked example had 10,963
 * rows across 3,012 users, and a notice sized from the rows would have been
 * three times too confident about its reach.
 *
 * Exclusions are ordered and a member counts against exactly one of them,
 * because a table where the reasons sum to more than the population cannot be
 * checked by adding it up.
 */

/**
 * Which version of these rules produced a stored estimate.
 *
 * Bumped by hand when the cohorts, the exclusions or their precedence change,
 * so an estimate taken under the old rules is recognisably old rather than
 * merely stale. `EmailCampaign.audienceVersion` has claimed to carry this since
 * the fourth slice and nothing ever wrote it, which left every stored estimate
 * saying it came from version 1 whether or not it had.
 */
export const AUDIENCE_DEFINITION_VERSION = 1;

export const AUDIENCE_COHORTS = [
    "default_model",
    "new_conversation_lead",
    "conversation_selection",
] as const;
export type AudienceCohort = (typeof AUDIENCE_COHORTS)[number];

/**
 * Why somebody in a cohort will not be written to. Ordered by precedence: the
 * first that applies is the one reported.
 *
 * `no_email` comes first because it is the only one that makes the others
 * unanswerable -- there is no address to check a suppression list against.
 */
export const AUDIENCE_EXCLUSIONS = [
    "no_email",
    "account_inactive",
    "suppressed",
    "plan_incompatible",
] as const;
export type AudienceExclusion = (typeof AUDIENCE_EXCLUSIONS)[number];

export type AudienceMember = {
    userId: string;
    cohorts: readonly AudienceCohort[];
    hasEmail: boolean;
    accountActive: boolean;
    suppressed: boolean;
    /** Whether the replacement is reachable on this account's plan. */
    planAllowsReplacement: boolean;
    /**
     * Whether any of this account's stored values could not be parsed. Such a
     * value is reported and left alone, so the account is told about the
     * retirement but is not counted as auto-migratable.
     */
    malformed: boolean;
};

export const audienceExclusion = (
    member: AudienceMember
): AudienceExclusion | null => {
    if (!member.hasEmail) return "no_email";
    if (!member.accountActive) return "account_inactive";
    if (member.suppressed) return "suppressed";
    if (!member.planAllowsReplacement) return "plan_incompatible";
    return null;
};

export type AudienceSummary = {
    /** Rows per cohort, before any de-duplication. */
    cohortRows: Record<AudienceCohort, number>;
    /** Distinct users per cohort. */
    cohortUsers: Record<AudienceCohort, number>;
    distinctUsers: number;
    excluded: Record<AudienceExclusion, number>;
    /** Who the initial notice goes to. */
    noticeAudience: number;
    /**
     * Whether the scan stopped before the audience did.
     *
     * A bounded read has to say it was bounded: every figure above is then a
     * floor rather than a total, and an operator sizing a send from a truncated
     * count would be sizing it from the first N people the cursor reached.
     */
    truncated: boolean;
    /**
     * Who an approved reconciliation would actually change.
     *
     * Never larger than the notice audience, and smaller whenever something is
     * malformed: a value the parser could not read is preserved rather than
     * rewritten, so promising that account an automatic change would be untrue.
     */
    autoMigratable: number;
    malformed: number;
};

export const summariseAudience = (
    members: readonly AudienceMember[],
    cohortRows: Record<AudienceCohort, number>,
    /** True when the caller stopped scanning before the audience ran out. */
    truncated = false
): AudienceSummary => {
    const cohortUsers = {
        default_model: 0,
        new_conversation_lead: 0,
        conversation_selection: 0,
    } as Record<AudienceCohort, number>;
    const excluded = {
        no_email: 0,
        account_inactive: 0,
        suppressed: 0,
        plan_incompatible: 0,
    } as Record<AudienceExclusion, number>;

    let noticeAudience = 0;
    let autoMigratable = 0;
    let malformed = 0;

    const seen = new Set<string>();
    for (const member of members) {
        // Defensive: the same user arriving twice would double every figure
        // below, and the query that feeds this joins three sources.
        if (seen.has(member.userId)) continue;
        seen.add(member.userId);

        for (const cohort of new Set(member.cohorts)) cohortUsers[cohort] += 1;
        if (member.malformed) malformed += 1;

        const exclusion = audienceExclusion(member);
        if (exclusion) {
            excluded[exclusion] += 1;
            continue;
        }
        noticeAudience += 1;
        if (!member.malformed) autoMigratable += 1;
    }

    return {
        cohortRows,
        cohortUsers,
        distinctUsers: seen.size,
        excluded,
        noticeAudience,
        autoMigratable,
        malformed,
        truncated,
    };
};

/**
 * Whether a reminder still applies to somebody the first notice reached.
 *
 * Recomputed immediately before the reminder wave rather than reused from the
 * first: a person who took the notice's advice and picked a different model has
 * stopped being affected, and telling them again that their model is going away
 * is both wrong and the fastest way to be marked as spam.
 */
export const stillAffected = (member: {
    cohorts: readonly AudienceCohort[];
}): boolean => member.cohorts.length > 0;
