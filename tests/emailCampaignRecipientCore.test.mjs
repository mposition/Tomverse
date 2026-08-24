import assert from "node:assert/strict";
import { test } from "node:test";

import {
    CAMPAIGN_EXCLUDED_REASONS,
    COHORT_PRECEDENCE,
    excludedReasonFor,
    primaryCohort,
    recipientVerdict,
    RECOMPUTING_WAVE_KINDS,
    waveRecomputesCohorts,
} from "../lib/emailCampaignRecipientCore.ts";
import {
    AUDIENCE_EXCLUSIONS,
} from "../lib/modelRetirementAudienceCore.ts";

const verdict = (overrides = {}) =>
    recipientVerdict({
        cohorts: ["default_model"],
        exclusion: null,
        malformed: false,
        recomputesCohorts: false,
        ...overrides,
    });

test("the strongest link is the one recorded", () => {
    // Somebody whose default model is the retiring one usually has
    // conversations selecting it too, and section 12.2 gives the ledger one
    // reason rather than a set.
    assert.equal(
        primaryCohort([
            "conversation_selection",
            "new_conversation_lead",
            "default_model",
        ]),
        "default_model"
    );
    assert.equal(
        primaryCohort(["conversation_selection", "new_conversation_lead"]),
        "new_conversation_lead"
    );
    assert.equal(primaryCohort(["conversation_selection"]), "conversation_selection");
    assert.equal(primaryCohort([]), null);
});

test("precedence is the cohort order, not a second list", () => {
    // Two lists would drift, and the drift would be invisible: both would still
    // be lists of the same three strings.
    assert.deepEqual(
        [...COHORT_PRECEDENCE],
        ["default_model", "new_conversation_lead", "conversation_selection"]
    );
});

test("somebody affected and reachable is included", () => {
    assert.deepEqual(verdict(), {
        outcome: "include",
        cohort: "default_model",
        malformed: false,
    });
});

test("every audience exclusion is a ledger reason", () => {
    // The two lists are allowed to differ in one direction only. If an
    // exclusion is added to the calculator and not here, the ledger cannot
    // record why somebody was skipped -- which is the one thing it exists for.
    for (const exclusion of AUDIENCE_EXCLUSIONS) {
        assert.ok(
            CAMPAIGN_EXCLUDED_REASONS.includes(excludedReasonFor(exclusion)),
            exclusion
        );
    }
});

test("an exclusion is recorded with the cohort it applied to", () => {
    // Not just "excluded". A suppressed person whose default model is going
    // away is a different fact from a suppressed person who merely once picked
    // it in a conversation, and the campaign is asked to report both.
    assert.deepEqual(verdict({ exclusion: "suppressed" }), {
        outcome: "exclude",
        excludedReason: "suppressed",
        cohort: "default_model",
        malformed: false,
    });
});

test("malformed is carried, never treated as an exclusion", () => {
    // summariseAudience() counts malformed accounts inside the notice audience
    // and outside autoMigratable: they are told, and not migrated. Recording
    // `malformed` as a reason for receiving nothing would contradict the
    // calculator that the reminder and the migration both read.
    const included = verdict({ malformed: true });
    assert.equal(included.outcome, "include");
    assert.equal(included.malformed, true);
    assert.ok(!CAMPAIGN_EXCLUDED_REASONS.includes("malformed"));
});

test("a reminder to somebody who already changed is refused, not sent", () => {
    // The point of the first notice was to get people to change this setting.
    // Telling the ones who did that their model is going away is untrue, and
    // the fastest way to be reported as spam.
    assert.deepEqual(
        verdict({ cohorts: [], recomputesCohorts: true }),
        {
            outcome: "exclude",
            excludedReason: "already_changed",
            cohort: null,
            malformed: false,
        }
    );
});

test("already_changed wins over an exclusion, because there is nothing to exclude them from", () => {
    // A person who is both suppressed and no longer affected is not a
    // suppression story. Reporting them as suppressed would make the
    // suppression count answer a question nobody asked.
    assert.deepEqual(
        verdict({ cohorts: [], exclusion: "suppressed", recomputesCohorts: true }),
        {
            outcome: "exclude",
            excludedReason: "already_changed",
            cohort: null,
            malformed: false,
        }
    );
});

test("a near-miss on the prefilter is not in the campaign at all", () => {
    // `selectedModels` is a JSON array in a String column, so the only
    // condition the database can offer is a substring match: a search for
    // `gpt-5-4-mini` also returns rows that selected `gpt-5-4-mini-preview`.
    // Those people are read and then found not to be members.
    //
    // Folding this into `already_changed` would write a false record -- they
    // never changed anything, and a reader counting `already_changed` would
    // conclude the first notice worked on people it never reached.
    assert.deepEqual(verdict({ cohorts: [] }), { outcome: "not_in_audience" });
});

test("only the later waves re-ask who is still affected", () => {
    // The first notice's audience is the query that produced it; re-running the
    // query for it would be asking the same question twice.
    assert.equal(waveRecomputesCohorts("notice"), false);
    assert.equal(waveRecomputesCohorts("launch"), false);
    assert.equal(waveRecomputesCohorts("completion"), false);
    for (const kind of RECOMPUTING_WAVE_KINDS) {
        assert.equal(waveRecomputesCohorts(kind), true, kind);
    }
});

test("an unknown wave kind does not recompute", () => {
    // Fail towards the cheaper mistake: a wave that should have recomputed and
    // did not sends a reminder to somebody who already acted, which is wrong
    // but recoverable. The alternative reads a ledger that may not exist.
    assert.equal(waveRecomputesCohorts("something_new"), false);
});
