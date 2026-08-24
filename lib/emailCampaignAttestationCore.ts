/**
 * The three conditions no field holds, recorded as somebody having said them.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §13.3.
 *
 * `lib/automaticTransitionClaim.ts` takes nine facts and three attestations.
 * The fourth slice named them and left them unstored: an attestation with
 * nowhere to live is a parameter a caller could pass `true` for. This is where
 * they live, and the shape carries what makes them worth anything -- who said
 * it and when.
 *
 * ## One of the three goes stale and the other two do not
 *
 * `differences_stated` is about **the body**: somebody read the copy and
 * confirmed it names the capability and credit differences. Change the copy and
 * that reading no longer describes what would be sent -- which is exactly the
 * failure EM-06 exists for, one layer up. So it carries the content digest it
 * was made against, and stops counting when the digest moves.
 *
 * `staging_verified` and `reconciliation_ready` are about the **migration** --
 * a rehearsal and a rollback. A copy edit does not undo either, and expiring
 * them on one would train an operator to re-attest without re-checking, which
 * is worse than not asking.
 */

export const ATTESTATION_KINDS = [
    "differences_stated",
    "staging_verified",
    "reconciliation_ready",
] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

/**
 * Kinds invalidated by a copy change. See the note above: this is a claim about
 * the words, and the words moved.
 */
export const CONTENT_BOUND_ATTESTATIONS: readonly AttestationKind[] = [
    "differences_stated",
];

export const isAttestationKind = (value: string): value is AttestationKind =>
    (ATTESTATION_KINDS as readonly string[]).includes(value);

export const isContentBound = (kind: AttestationKind) =>
    CONTENT_BOUND_ATTESTATIONS.includes(kind);

export type StoredAttestation = {
    kind: AttestationKind;
    attestedByEmail: string;
    attestedAt: Date;
    /** The body digest this was made against; null for kinds that are not about the body. */
    contentDigest: string | null;
};

export type AttestationState = {
    kind: AttestationKind;
    /** Whether it counts right now. */
    satisfied: boolean;
    attestedByEmail: string | null;
    attestedAt: Date | null;
    /**
     * Set when an attestation exists and no longer counts, so the screen can
     * say "this went stale" rather than "nobody has said this" -- different
     * sentences, and the second one is wrong about a person who did the work.
     */
    stale: boolean;
};

/**
 * What the stored rows mean, given what the campaign's copy hashes to now.
 *
 * `currentDigest` null means the digest could not be computed -- an unknown
 * template, a language with no version yet. A content-bound attestation is then
 * unsatisfied: not knowing whether the words moved is not the same as knowing
 * they did not.
 */
export const attestationStates = (input: {
    stored: readonly StoredAttestation[];
    currentDigest: string | null;
}): AttestationState[] =>
    ATTESTATION_KINDS.map((kind) => {
        const row = input.stored.find((entry) => entry.kind === kind);
        if (!row) {
            return {
                kind,
                satisfied: false,
                attestedByEmail: null,
                attestedAt: null,
                stale: false,
            };
        }
        const bound = isContentBound(kind);
        const satisfied = bound
            ? Boolean(
                  input.currentDigest &&
                      row.contentDigest &&
                      row.contentDigest === input.currentDigest
              )
            : true;
        return {
            kind,
            satisfied,
            attestedByEmail: row.attestedByEmail,
            attestedAt: row.attestedAt,
            stale: !satisfied,
        };
    });

/**
 * The three booleans `automaticTransitionClaim` takes.
 *
 * Built from the states above rather than from the rows, so a stale attestation
 * reaches the gate as absent -- which is what it is, for the purpose of
 * deciding whether the promise may be made.
 */
export const attestationsForClaim = (states: readonly AttestationState[]) => {
    const satisfied = (kind: AttestationKind) =>
        states.find((state) => state.kind === kind)?.satisfied === true;
    return {
        differencesStated: satisfied("differences_stated"),
        stagingVerified: satisfied("staging_verified"),
        reconciliationReady: satisfied("reconciliation_ready"),
    };
};

/**
 * One digest over every language's content hash.
 *
 * Sorted by language before joining, because a map's iteration order is not a
 * fact about the copy -- two campaigns with identical text must produce the
 * same digest, and adding a language must change it.
 */
export const campaignContentDigest = (
    hashes: Readonly<Record<string, string>>
): string | null => {
    const languages = Object.keys(hashes).sort();
    if (languages.length === 0) return null;
    return languages.map((language) => `${language}:${hashes[language]}`).join("|");
};
