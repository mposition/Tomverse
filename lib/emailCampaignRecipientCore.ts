/**
 * The campaign's own record of who it reached and who it did not.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §11, §12.2, §13.
 *
 * `EmailDelivery` records what was sent. A campaign is asked the opposite
 * question -- who was in the audience and got nothing, and why -- and there is
 * no row anywhere that answers it, because the reasons a person is skipped are
 * exactly the reasons no delivery row is written for them.
 *
 * Pure so the precedence rules can be tested without a database.
 */

import {
    AUDIENCE_COHORTS,
    type AudienceCohort,
    type AudienceExclusion,
} from "@/lib/modelRetirementAudienceCore";

/**
 * Which cohort a recipient is filed under when several apply.
 *
 * §12.2 gives the ledger one `eligibilityReason`, not a set, and somebody whose
 * default model is the retiring one usually has conversations selecting it too.
 * Ordered strongest-link-first: the default model is a standing choice about
 * every new conversation, a stored combination is a standing choice about the
 * next one, and a conversation selection is a choice already made in the past.
 *
 * Reported per person rather than per row for the reason §11 gives: three
 * cohorts overlapping meant the audit's own worked example had 10,963 rows for
 * 3,012 people, and a notice sized from the rows is three times too confident.
 */
export const COHORT_PRECEDENCE = AUDIENCE_COHORTS;

export const primaryCohort = (
    cohorts: readonly AudienceCohort[]
): AudienceCohort | null => {
    for (const cohort of COHORT_PRECEDENCE) {
        if (cohorts.includes(cohort)) return cohort;
    }
    return null;
};

/**
 * Why a person in the audience received nothing.
 *
 * A superset of `AudienceExclusion`, and deliberately so: that list answers
 * "who can be written to right now", which is what sizing a send needs. This
 * one also has to carry reasons decided *later* -- `already_changed` is only
 * knowable at the reminder, after the first notice has had time to work.
 *
 * `no_consent` is here even though `model_lifecycle` defaults to on, because
 * the purpose is not locked (§11.3 answer 6) and a person may turn it off
 * between the notice and the reminder. Recording it as an exclusion is what
 * makes that visible instead of looking like a disappearance.
 *
 * `malformed` is deliberately **not** here. A value the parser could not read
 * means the account cannot be migrated automatically, not that it should be
 * left uninformed -- `summariseAudience` counts malformed accounts inside the
 * notice audience and outside `autoMigratable`, and an exclusion reason would
 * contradict the calculator that the reminder and the migration both read. It
 * is a column of its own below.
 */
export const CAMPAIGN_EXCLUDED_REASONS = [
    "no_email",
    "account_inactive",
    "suppressed",
    "no_consent",
    "plan_incompatible",
    "already_changed",
] as const;
export type CampaignExcludedReason = (typeof CAMPAIGN_EXCLUDED_REASONS)[number];

/**
 * Every `AudienceExclusion` is a `CampaignExcludedReason`; the reverse is not
 * true. Stated as a function rather than a cast so the compiler fails when the
 * two lists drift apart.
 */
export const excludedReasonFor = (
    exclusion: AudienceExclusion
): CampaignExcludedReason => exclusion;

/**
 * What the ledger does about one person.
 *
 * Three outcomes, not two. `not_in_audience` exists because the audience query
 * cannot be exact: `Conversation.selectedModels` is a JSON array inside a
 * `String` column, so the database can only prefilter on a substring, and a
 * search for `gpt-5-4-mini` also returns rows that selected
 * `gpt-5-4-mini-preview`. Those people are read and then found not to be
 * members.
 *
 * Folding that into `already_changed` would write a false record: they never
 * changed anything, and a reader counting `already_changed` would conclude the
 * first notice worked on people it never reached.
 */
export type RecipientVerdict =
    | { outcome: "include"; cohort: AudienceCohort; malformed: boolean }
    | {
          outcome: "exclude";
          excludedReason: CampaignExcludedReason;
          cohort: AudienceCohort | null;
          malformed: boolean;
      }
    | { outcome: "not_in_audience" };

/**
 * What the ledger records for one person, given what the audience calculator
 * decided about them.
 *
 * `cohorts` empty means the person is not affected. Which of the two "not
 * affected" answers that is depends on whether this wave is re-asking: at a
 * reminder it means they took the first notice's advice, and telling them again
 * that their model is going away is both untrue and the fastest way to be
 * reported as spam (§12.3). Anywhere else it means the prefilter was loose, and
 * the honest record is no record.
 */
export const recipientVerdict = (input: {
    cohorts: readonly AudienceCohort[];
    exclusion: AudienceExclusion | null;
    malformed: boolean;
    /** Whether this wave re-asks the audience question. */
    recomputesCohorts: boolean;
}): RecipientVerdict => {
    const cohort = primaryCohort(input.cohorts);

    if (cohort === null) {
        return input.recomputesCohorts
            ? {
                  outcome: "exclude",
                  excludedReason: "already_changed",
                  cohort: null,
                  malformed: input.malformed,
              }
            : { outcome: "not_in_audience" };
    }

    if (input.exclusion) {
        return {
            outcome: "exclude",
            excludedReason: excludedReasonFor(input.exclusion),
            cohort,
            malformed: input.malformed,
        };
    }

    return { outcome: "include", cohort, malformed: input.malformed };
};

/**
 * Waves that re-ask who is still affected.
 *
 * The first notice does not: its audience is the query that produced it. Every
 * later wave does, because the whole point of the first one was to get people
 * to change the setting it was about.
 */
export const RECOMPUTING_WAVE_KINDS = [
    "reminder",
    "final_reminder",
] as const;

export const waveRecomputesCohorts = (kind: string): boolean =>
    (RECOMPUTING_WAVE_KINDS as readonly string[]).includes(kind);
