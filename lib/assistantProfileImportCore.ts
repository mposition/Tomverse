/**
 * The closed vocabularies and the two clocks an import runs on (Slice 5A).
 *
 * docs/policy/assistant-package-import.md §5.
 *
 * ## Why the lists are here rather than as string literals
 *
 * `mode` decides what cancelling an import deletes: a `create` import owns the
 * draft profile and takes it with it, a `merge` import must never touch the
 * profile it staged into. A typo in that word is a deleted profile somebody
 * built by hand. The database CHECK bounds the vocabulary and
 * `npm run check:enum-constraints` compares it against these arrays, so the two
 * cannot drift; what neither can do is decide whether the value is right for
 * the row, which is why the cleanup path re-tests its preconditions before it
 * deletes anything.
 *
 * ## Why the clocks are stored rather than derived
 *
 * Release A computes its expiries from `updatedAt`, and that works there
 * because nothing but the user writes to those rows. Here the extractor writes
 * to the import's files, a failed publish writes to the import, and internal
 * retries write again -- so an idle timer read from `updatedAt` would be
 * extended by exactly the events that mean nobody is present. The clocks are
 * columns, and only the events listed below move them.
 *
 * Pure: no Prisma, no R2, no clock of its own -- `now` is passed in.
 */

export const ASSISTANT_PROFILE_IMPORT_MODES = ["create", "merge"] as const;
export type AssistantProfileImportMode =
    (typeof ASSISTANT_PROFILE_IMPORT_MODES)[number];

export const ASSISTANT_PROFILE_IMPORT_STATUSES = ["staging", "published"] as const;
export type AssistantProfileImportStatus =
    (typeof ASSISTANT_PROFILE_IMPORT_STATUSES)[number];

export const ASSISTANT_KNOWLEDGE_RESERVATION_STATES = [
    "pending",
    "finalizing",
] as const;
export type AssistantKnowledgeReservationState =
    (typeof ASSISTANT_KNOWLEDGE_RESERVATION_STATES)[number];

export const ASSISTANT_PROFILE_IMPORT_LIMITS = {
    /**
     * Idle and absolute, the same two clocks Release A staging uses and
     * deliberately separate constants: these bound a wizard somebody is
     * standing in front of, not a conversation archive being uploaded, and
     * moving one must not move the other.
     */
    stagingIdleTtlMs: 24 * 60 * 60 * 1000,
    stagingAbsoluteTtlMs: 72 * 60 * 60 * 1000,
    /**
     * How long a finalize may hold a reservation before another attempt may
     * take it. The same role as `KNOWLEDGE_PROCESSING_STALE_MS` and a separate
     * number: that one bounds an extraction, this one bounds an HTTP request
     * that is writing a row.
     */
    reservationClaimStaleMs: 10 * 60 * 1000,
} as const;

/**
 * Which events move the idle clock.
 *
 * Written as a list rather than left to each call site, because the rule is
 * the one thing about the clocks that is easy to get wrong in a way nothing
 * notices: a stale publish that extended the deadline would keep an abandoned
 * import alive for as long as the client kept retrying.
 */
export const IMPORT_USER_ACTIVITY_EVENTS = [
    "import_created",
    "file_staged",
    "file_removed",
    "manifest_edited",
    "approved",
] as const;

export type ImportUserActivityEvent = (typeof IMPORT_USER_ACTIVITY_EVENTS)[number];

export type ImportExpiries = {
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
};

/**
 * The two deadlines for an import that has just been touched.
 *
 * The idle deadline never exceeds the absolute one. Without that clamp an
 * import touched an hour before its absolute expiry would report a deadline a
 * day away, and the sweep would then delete it while the screen still said it
 * had time.
 */
export function computeImportExpiries(input: {
    createdAt: Date;
    lastUserActivityAt: Date;
    limits?: typeof ASSISTANT_PROFILE_IMPORT_LIMITS;
}): ImportExpiries {
    const limits = input.limits ?? ASSISTANT_PROFILE_IMPORT_LIMITS;
    const absoluteExpiresAt = new Date(
        input.createdAt.getTime() + limits.stagingAbsoluteTtlMs
    );
    const idle = new Date(
        input.lastUserActivityAt.getTime() + limits.stagingIdleTtlMs
    );
    return {
        idleExpiresAt: idle < absoluteExpiresAt ? idle : absoluteExpiresAt,
        absoluteExpiresAt,
    };
}

/* ------------------------------------------------ deleting a draft safely */

/**
 * What the sweep must be able to see before it deletes a `create` import's
 * profile.
 *
 * The columns are named rather than passed as a row so the caller has to
 * fetch each one deliberately; a helper that took the whole record would be
 * one `select` away from deciding on fields it did not read.
 */
export type CreateCleanupFacts = {
    importStatus: string;
    importMode: string;
    importProfileId: string;
    profileId: string;
    profileCurrentVersionId: string | null;
    profileVersionCount: number;
    /** Imports other than this one pointing at the same profile. */
    otherImportsForProfile: number;
};

export type CreateCleanupVerdict =
    | { outcome: "delete_profile" }
    | { outcome: "refuse"; reasons: string[] };

/**
 * Whether a `create` import's profile may be deleted.
 *
 * Every condition has to hold, and a single mismatch refuses everything rather
 * than deleting what looks safe. Deleting a profile somebody built cannot be
 * undone; leaving a draft for a person to look at can. That asymmetry is the
 * whole rule, and it is the same posture the image-asset cleanup takes when it
 * exhausts its attempts.
 */
export function judgeCreateCleanup(facts: CreateCleanupFacts): CreateCleanupVerdict {
    const reasons: string[] = [];
    if (facts.importStatus !== "staging") reasons.push("import_not_staging");
    if (facts.importMode !== "create") reasons.push("import_not_create_mode");
    if (facts.importProfileId !== facts.profileId) reasons.push("profile_mismatch");
    if (facts.profileCurrentVersionId !== null) reasons.push("profile_is_published");
    if (facts.profileVersionCount !== 0) reasons.push("profile_has_versions");
    if (facts.otherImportsForProfile !== 0) reasons.push("profile_has_other_imports");
    return reasons.length === 0
        ? { outcome: "delete_profile" }
        : { outcome: "refuse", reasons };
}

/**
 * A `merge` import never deletes a profile. Stated as a function so the
 * cleanup path asks the same question for both modes and gets a different
 * answer, rather than branching on a string in the middle of a delete.
 */
export const mergeCleanupDeletesProfile = (): false => false;
