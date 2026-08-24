import assert from "node:assert/strict";
import { test } from "node:test";

import {
    ATTESTATION_KINDS,
    attestationsForClaim,
    attestationStates,
    campaignContentDigest,
    CONTENT_BOUND_ATTESTATIONS,
    isAttestationKind,
    isContentBound,
} from "../lib/emailCampaignAttestationCore.ts";

// The three conditions no field holds (EM-01 slice 5).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §13.3.
//
// The fourth slice named them and left them unstored. An attestation with
// nowhere to live is a parameter a caller could pass `true` for.

const AT = new Date("2026-09-01T00:00:00Z");

const stored = (overrides = {}) => ({
    kind: "differences_stated",
    attestedByEmail: "ops@example.test",
    attestedAt: AT,
    contentDigest: "en:abc",
    ...overrides,
});

const states = (input) =>
    attestationStates({ stored: [], currentDigest: "en:abc", ...input });

const state = (list, kind) => list.find((entry) => entry.kind === kind);

test("nothing stored means nothing attested", () => {
    const result = states({});
    assert.equal(result.length, ATTESTATION_KINDS.length);
    for (const entry of result) {
        assert.equal(entry.satisfied, false, entry.kind);
        assert.equal(entry.attestedByEmail, null);
        assert.equal(entry.stale, false, "absent is not stale, it is absent");
    }
});

test("an attestation made against the current copy counts", () => {
    const result = states({ stored: [stored()] });
    assert.equal(state(result, "differences_stated").satisfied, true);
    assert.equal(
        state(result, "differences_stated").attestedByEmail,
        "ops@example.test"
    );
});

test("a copy change takes the body attestation with it", () => {
    // The claim was about the words, and the words moved. This is EM-06's
    // failure one layer in: an approval quietly coming to cover text nobody
    // read, except here it is a person's statement rather than an approval.
    const result = states({
        stored: [stored()],
        currentDigest: "en:def",
    });
    assert.equal(state(result, "differences_stated").satisfied, false);
    assert.equal(state(result, "differences_stated").stale, true);
    // And the person is still named, so the screen can say "this went stale"
    // rather than "nobody has said this" -- different sentences, and the second
    // is wrong about somebody who did the work.
    assert.equal(
        state(result, "differences_stated").attestedByEmail,
        "ops@example.test"
    );
});

test("the migration attestations survive a copy change", () => {
    // A rehearsal and a rollback are not undone by an edit to a paragraph.
    // Expiring them on one would train an operator to re-attest without
    // re-checking, which is worse than not asking.
    const result = attestationStates({
        stored: [
            stored({ kind: "staging_verified", contentDigest: null }),
            stored({ kind: "reconciliation_ready", contentDigest: null }),
        ],
        currentDigest: "en:completely-different",
    });
    assert.equal(state(result, "staging_verified").satisfied, true);
    assert.equal(state(result, "reconciliation_ready").satisfied, true);
});

test("an uncomputable digest leaves the body attestation unsatisfied", () => {
    // Not knowing whether the words moved is not the same as knowing they did
    // not.
    const result = states({ stored: [stored()], currentDigest: null });
    assert.equal(state(result, "differences_stated").satisfied, false);
});

test("a body attestation stored without a digest never counts", () => {
    // The database refuses this shape, and so does this: an attestation about
    // words nobody hashed is one nothing can ever invalidate.
    const result = states({ stored: [stored({ contentDigest: null })] });
    assert.equal(state(result, "differences_stated").satisfied, false);
});

test("only the body attestation is content-bound", () => {
    assert.deepEqual([...CONTENT_BOUND_ATTESTATIONS], ["differences_stated"]);
    assert.equal(isContentBound("differences_stated"), true);
    assert.equal(isContentBound("staging_verified"), false);
    assert.equal(isContentBound("reconciliation_ready"), false);
});

test("the kinds are a closed list", () => {
    assert.deepEqual([...ATTESTATION_KINDS], [
        "differences_stated",
        "staging_verified",
        "reconciliation_ready",
    ]);
    assert.equal(isAttestationKind("staging_verified"), true);
    assert.equal(isAttestationKind("looks_fine"), false);
});

test("the gate reads satisfaction, not existence", () => {
    // A stale attestation reaches the twelve-condition gate as absent, which is
    // what it is for the purpose of deciding whether the promise may be made.
    assert.deepEqual(
        attestationsForClaim(states({ stored: [stored()], currentDigest: "en:def" })),
        {
            differencesStated: false,
            stagingVerified: false,
            reconciliationReady: false,
        }
    );
    assert.deepEqual(
        attestationsForClaim(
            attestationStates({
                stored: [
                    stored(),
                    stored({ kind: "staging_verified", contentDigest: null }),
                    stored({ kind: "reconciliation_ready", contentDigest: null }),
                ],
                currentDigest: "en:abc",
            })
        ),
        {
            differencesStated: true,
            stagingVerified: true,
            reconciliationReady: true,
        }
    );
});

test("the digest does not depend on which order the languages came out", () => {
    // A map's iteration order is not a fact about the copy. Two campaigns with
    // identical text must digest the same.
    assert.equal(
        campaignContentDigest({ ko: "b", en: "a" }),
        campaignContentDigest({ en: "a", ko: "b" })
    );
});

test("adding a language changes the digest", () => {
    // A locale added after somebody read the copy is copy they did not read.
    assert.notEqual(
        campaignContentDigest({ en: "a" }),
        campaignContentDigest({ en: "a", ko: "b" })
    );
});

test("no languages digests to nothing, not to an empty string", () => {
    // An empty string would compare equal to itself and make a campaign with no
    // renderable copy look stable.
    assert.equal(campaignContentDigest({}), null);
});
