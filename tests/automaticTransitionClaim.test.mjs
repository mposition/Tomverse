import assert from "node:assert/strict";
import { test } from "node:test";

import {
    automaticTransitionClaim,
    TRANSITION_CONDITIONS,
    TRANSITION_CONDITION_REASONS,
} from "../lib/automaticTransitionClaim.ts";

// The twelve conditions behind one sentence (EM-01 slice 4).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §13.3.
//
// > "Keep this as your default model until the retirement date and Tomverse
// > will change it to <replacement> for you on <effectiveAt>."
//
// A promise made to thousands of people at once. Any one of the twelve false
// and the notice says the other thing instead -- "this model stops working on
// <date>, please pick <replacement> yourself" -- which promises nothing.

const satisfied = (overrides = {}) => ({
    workItem: {
        found: true,
        action: "retire",
        status: "approved",
        retirementTicketUrl: "https://github.com/mposition/tomverse/issues/1",
        ownerEmail: "ops@example.test",
    },
    effectiveAt: new Date("2026-09-15T00:00:00Z"),
    timezoneLabel: "Asia/Seoul",
    replacement: {
        found: true,
        enabled: true,
        publiclyListed: true,
        catalogDeleted: false,
    },
    planIncompatibleCount: 0,
    dryRunRecipientCount: 2_928,
    communicationApprovalConsumed: true,
    completionWaveScheduledAt: new Date("2026-09-16T00:00:00Z"),
    attestations: {
        differencesStated: true,
        stagingVerified: true,
        reconciliationReady: true,
    },
    ...overrides,
});

test("all twelve satisfied is the only way to make the promise", () => {
    const claim = automaticTransitionClaim(satisfied());
    assert.equal(claim.mayClaim, true);
    assert.deepEqual(claim.unmet, []);
});

test("every condition has a sentence an operator can act on", () => {
    // Not "condition 7 failed". The twelve are owed to different people -- one
    // is a registry edit, one a staging session, one somebody writing a
    // paragraph -- and a list of numbers sends the reader back to the audit.
    for (const condition of TRANSITION_CONDITIONS) {
        const reason = TRANSITION_CONDITION_REASONS[condition];
        assert.ok(reason && reason.length > 20, condition);
    }
});

test("a retirement nobody approved cannot be promised", () => {
    for (const workItem of [
        null,
        { found: false, action: "retire", status: "approved", retirementTicketUrl: "t", ownerEmail: "o@e.test" },
        { found: true, action: "monitor", status: "approved", retirementTicketUrl: "t", ownerEmail: "o@e.test" },
        { found: true, action: "retire", status: "discovered", retirementTicketUrl: "t", ownerEmail: "o@e.test" },
    ]) {
        const claim = automaticTransitionClaim(satisfied({ workItem }));
        assert.ok(
            claim.unmet.includes("work_item_approved_retirement"),
            JSON.stringify(workItem)
        );
    }
});

test("a date needs the timezone it will be read in", () => {
    // Both or neither. A UTC instant with no label is a date that reads as a
    // different day to the person receiving the notice than to the person who
    // set it, and this sentence names a day.
    assert.ok(
        automaticTransitionClaim(satisfied({ timezoneLabel: null })).unmet.includes(
            "effective_at_fixed"
        )
    );
    assert.ok(
        automaticTransitionClaim(satisfied({ effectiveAt: null })).unmet.includes(
            "effective_at_fixed"
        )
    );
    assert.ok(
        automaticTransitionClaim(satisfied({ timezoneLabel: "   " })).unmet.includes(
            "effective_at_fixed"
        )
    );
});

test("the replacement has to be one people can actually reach", () => {
    for (const replacement of [
        null,
        { found: false, enabled: true, publiclyListed: true, catalogDeleted: false },
        { found: true, enabled: false, publiclyListed: true, catalogDeleted: false },
        { found: true, enabled: true, publiclyListed: false, catalogDeleted: false },
        { found: true, enabled: true, publiclyListed: true, catalogDeleted: true },
    ]) {
        assert.ok(
            automaticTransitionClaim(satisfied({ replacement })).unmet.includes(
                "replacement_usable"
            ),
            JSON.stringify(replacement)
        );
    }
});

test("one account out of plan reach is enough to withdraw the promise", () => {
    // The sentence is addressed to each reader individually. "Mostly true" is
    // a property of the audience, not of what any one person was told.
    assert.ok(
        automaticTransitionClaim(
            satisfied({ planIncompatibleCount: 1 })
        ).unmet.includes("plan_compatible")
    );
});

test("an audience nobody counted is not an audience", () => {
    assert.ok(
        automaticTransitionClaim(
            satisfied({ dryRunRecipientCount: null })
        ).unmet.includes("dry_run_counted")
    );
});

test("zero recipients counted is a count, not an absence", () => {
    // `null` is nobody having looked. Zero is somebody having looked and found
    // nobody, and only one of those is a missing condition.
    assert.ok(
        !automaticTransitionClaim(
            satisfied({ dryRunRecipientCount: 0 })
        ).unmet.includes("dry_run_counted")
    );
});

test("the three attestations are unmet until somebody states them", () => {
    // Silence is not consent. These are the ones no field holds -- whether the
    // body names the capability differences, whether staging was verified,
    // whether the rollback was rehearsed -- and an absent attestation must
    // never read as a satisfied one.
    const claim = automaticTransitionClaim(satisfied({ attestations: {} }));
    for (const condition of [
        "differences_stated",
        "staging_verified",
        "reconciliation_ready",
    ]) {
        assert.ok(claim.unmet.includes(condition), condition);
    }
});

test("an attestation that is not exactly true is not an attestation", () => {
    // Guards the truthy-value shortcut: a string, a 1, or an undefined coming
    // out of JSON must not pass for somebody having said yes.
    for (const value of [undefined, false, null, 0, "", "yes", 1]) {
        const claim = automaticTransitionClaim(
            satisfied({ attestations: { differencesStated: value } })
        );
        assert.ok(
            claim.unmet.includes("differences_stated"),
            JSON.stringify(value)
        );
    }
});

test("an approval that was requested is not one that was consumed", () => {
    assert.ok(
        automaticTransitionClaim(
            satisfied({ communicationApprovalConsumed: false })
        ).unmet.includes("communication_approved")
    );
});

test("a ticket and an owner are both the work item's to carry", () => {
    assert.ok(
        automaticTransitionClaim(
            satisfied({
                workItem: { ...satisfied().workItem, retirementTicketUrl: "  " },
            })
        ).unmet.includes("retirement_ticket")
    );
    assert.ok(
        automaticTransitionClaim(
            satisfied({ workItem: { ...satisfied().workItem, ownerEmail: null } })
        ).unmet.includes("owner_assigned")
    );
});

test("a promise with no completion notice ends in silence", () => {
    // People are told a change will happen to their account and then never
    // told it did.
    assert.ok(
        automaticTransitionClaim(
            satisfied({ completionWaveScheduledAt: null })
        ).unmet.includes("completion_scheduled")
    );
});

test("everything missing is reported at once, not one per attempt", () => {
    // An operator fixing these is doing twelve different errands. Reporting one
    // at a time turns that into twelve round trips.
    const claim = automaticTransitionClaim({
        workItem: null,
        effectiveAt: null,
        timezoneLabel: null,
        replacement: null,
        planIncompatibleCount: 3,
        dryRunRecipientCount: null,
        communicationApprovalConsumed: false,
        completionWaveScheduledAt: null,
        attestations: {},
    });
    assert.equal(claim.mayClaim, false);
    assert.deepEqual([...claim.unmet].sort(), [...TRANSITION_CONDITIONS].sort());
    assert.equal(claim.reasons.length, TRANSITION_CONDITIONS.length);
});
