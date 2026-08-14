/**
 * Assistant profile version snapshots (Release C, slice C1).
 *
 * docs/policy/external-conversation-import-and-memory.md §14.1, §20
 * (릴리스 C), §18 (릴리스 C 오류 코드).
 *
 * Pure and dependency-free: no Prisma, no clock, no R2. Everything here is a
 * decision about *what the next snapshot should be*, taken before any row is
 * written, so the rules can be tested without a database and so the write path
 * has nothing left to decide.
 *
 * ## The three things this module exists to hold
 *
 * 1. **A published version is never edited.** Editing a profile publishes a
 *    new revision. `planProfileVersionPublish()` is the only way to get one,
 *    and it produces a revision number, never an update to an existing row.
 *
 * 2. **A stale editor loses.** Two tabs open on revision 4 must not both
 *    publish "revision 5" with different content and have the later one win
 *    silently. The editor states the revision it started from; a mismatch is
 *    `ASSISTANT_PROFILE_VERSION_STALE` (409, §18) and the user re-reads before
 *    republishing. The database's `(profileId, revision)` unique index is the
 *    second half of this — the check here gives a useful error, the index
 *    makes the guarantee.
 *
 * 3. **A knowledge manifest cannot resurrect a deleted file.** §14 makes the
 *    manifest audit metadata: it can prove a file was listed when the version
 *    was published, and that is all. `resolveKnowledgeManifest()` answers
 *    against what exists *now* and reports the rest as unavailable, so a past
 *    version reads as "this file is gone" rather than quietly retrieving
 *    something else or appearing complete.
 */

/** §18 릴리스 C. Held here so the route layer cannot invent a variant. */
export const ASSISTANT_PROFILE_VERSION_STALE = "ASSISTANT_PROFILE_VERSION_STALE";
export const ASSISTANT_PROFILE_MODEL_UNAVAILABLE =
    "ASSISTANT_PROFILE_MODEL_UNAVAILABLE";

/**
 * The prompt shape a version was authored for. A version published under an
 * older format is refused at runtime rather than reinterpreted (§14), so this
 * is a stored fact and not a derived one.
 */
export const ASSISTANT_PROMPT_FORMAT_VERSION = "assistant-profile-v1";

/**
 * Retrieval v1 is lexical — searchTerms plus deterministic scoring, no
 * embeddings (§9). Bumping this is a retrieval change, and old versions keep
 * the number they were built for.
 */
export const ASSISTANT_RETRIEVAL_VERSION = 1;

/* -------------------------------------------------------------- limits */

/**
 * Field limits for one version.
 *
 * These bound a request body, not storage cost — the quota numbers §14.1
 * settles are about knowledge files and live with the knowledge slice. They
 * are here so a single oversized instructions field is refused at the edge
 * with a message naming the field, rather than at insert time as a database
 * error nobody can act on.
 */
export const ASSISTANT_PROFILE_LIMITS = {
    maxNameCharacters: 60,
    maxDescriptionCharacters: 300,
    /**
     * Long enough for a genuinely detailed persona, short enough that it
     * cannot dominate a model's context window on its own: §9.1 puts profile
     * instructions second in the prompt, above memory and conversation
     * context, so an unbounded field here would crowd out the conversation
     * the user is actually having.
     */
    maxInstructionsCharacters: 8_000,
    maxStarters: 8,
    maxStarterCharacters: 200,
    /**
     * §14 gives a profile a default model, and the picker allows a small set
     * so a profile-started comparison stays within the same admission
     * contract every other comparison uses.
     */
    maxModels: 4,
    /** An emoji or short token — never a URL (see the schema comment). */
    maxIconCharacters: 8,
} as const;

/* ----------------------------------------------------------- the draft */

/** What the user's memory policy on a profile can say (§14). */
export type AssistantMemoryPolicy = {
    /**
     * Whether this profile *asks* to use account memory. It can only ever
     * narrow: the account master toggle, the conversation memory mode, the
     * injection flag and source locks all still apply, and a profile saying
     * `true` does not override any of them (§14). Resolving that AND is the
     * runtime slice's job — this field is one input to it, never the answer.
     */
    useAccountMemory: boolean;
};

export type AssistantToolPolicy = {
    webSearch: boolean;
    deepResearch: boolean;
};

/** One file as listed at publish time. Audit metadata (§14). */
export type AssistantKnowledgeManifestEntry = {
    fileId: string;
    /** The name as it was at publish time, kept so a deleted file can still be named. */
    name: string;
    digest: string;
};

/** A profile version as the user composed it, before it becomes a row. */
export type AssistantProfileVersionDraft = {
    instructions: string;
    modelIds: readonly string[];
    toolPolicy: AssistantToolPolicy;
    memoryPolicy: AssistantMemoryPolicy;
    starters: readonly string[];
    knowledgeManifest: readonly AssistantKnowledgeManifestEntry[];
};

/** The identity fields, which are not part of a version snapshot (§14). */
export type AssistantProfileIdentityDraft = {
    name: string;
    icon: string | null;
    description: string | null;
};

export type AssistantProfileProblem = {
    field: string;
    reason: string;
};

/* ------------------------------------------------------- normalisation */

/**
 * Collapses the whitespace a paste brings with it and trims the ends.
 *
 * Applied to every short single-line field. Not applied to `instructions`:
 * an instruction block's line structure is content the user wrote on purpose,
 * and flattening it would change what the profile says.
 */
const normalizeLine = (value: string): string =>
    value.replace(/\s+/gu, " ").trim();

/**
 * Trims the ends and normalises line endings, leaving interior structure.
 *
 * `\r\n` becomes `\n` so the same text pasted from two editors produces the
 * same stored bytes — otherwise "did this edit change anything" (below)
 * answers yes for a change of keyboard.
 */
const normalizeBlock = (value: string): string =>
    value.replace(/\r\n?/gu, "\n").trim();

export function normalizeProfileIdentity(
    draft: AssistantProfileIdentityDraft
): AssistantProfileIdentityDraft {
    const description =
        draft.description == null ? null : normalizeLine(draft.description);
    const icon = draft.icon == null ? null : normalizeLine(draft.icon);
    return {
        name: normalizeLine(draft.name),
        icon: icon === "" ? null : icon,
        description: description === "" ? null : description,
    };
}

export function normalizeProfileVersionDraft(
    draft: AssistantProfileVersionDraft
): AssistantProfileVersionDraft {
    return {
        instructions: normalizeBlock(draft.instructions),
        // Order is the user's choice (the first model is the default), so it
        // is preserved; only exact repeats are dropped.
        modelIds: [...new Set(draft.modelIds.map((id) => id.trim()))].filter(
            (id) => id !== ""
        ),
        toolPolicy: { ...draft.toolPolicy },
        memoryPolicy: { ...draft.memoryPolicy },
        starters: draft.starters
            .map(normalizeLine)
            .filter((starter) => starter !== ""),
        knowledgeManifest: [...draft.knowledgeManifest]
            .map((entry) => ({
                fileId: entry.fileId.trim(),
                name: normalizeLine(entry.name),
                digest: entry.digest.trim(),
            }))
            // Sorted by fileId so a manifest is comparable between revisions:
            // reordering the file list in the UI is not an edit to the profile.
            .sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0)),
    };
}

/* --------------------------------------------------------- validation */

export function profileIdentityProblems(
    draft: AssistantProfileIdentityDraft
): AssistantProfileProblem[] {
    const problems: AssistantProfileProblem[] = [];
    const { maxNameCharacters, maxDescriptionCharacters, maxIconCharacters } =
        ASSISTANT_PROFILE_LIMITS;
    if (draft.name === "") {
        problems.push({ field: "name", reason: "must not be empty" });
    } else if ([...draft.name].length > maxNameCharacters) {
        problems.push({
            field: "name",
            reason: `must be at most ${maxNameCharacters} characters`,
        });
    }
    if (
        draft.description != null &&
        [...draft.description].length > maxDescriptionCharacters
    ) {
        problems.push({
            field: "description",
            reason: `must be at most ${maxDescriptionCharacters} characters`,
        });
    }
    if (draft.icon != null) {
        if ([...draft.icon].length > maxIconCharacters) {
            problems.push({
                field: "icon",
                reason: `must be at most ${maxIconCharacters} characters`,
            });
        }
        // A URL here would make rendering a profile list a request to whatever
        // host the icon names. §14 keeps profiles private and offline; an
        // avatar is an emoji or a short token, never a fetch.
        if (/[:/]|^\s*data\b/iu.test(draft.icon)) {
            problems.push({
                field: "icon",
                reason: "must not contain a URL or a data reference",
            });
        }
    }
    return problems;
}

export function profileVersionProblems(
    draft: AssistantProfileVersionDraft
): AssistantProfileProblem[] {
    const problems: AssistantProfileProblem[] = [];
    const {
        maxInstructionsCharacters,
        maxStarters,
        maxStarterCharacters,
        maxModels,
    } = ASSISTANT_PROFILE_LIMITS;

    if ([...draft.instructions].length > maxInstructionsCharacters) {
        problems.push({
            field: "instructions",
            reason: `must be at most ${maxInstructionsCharacters} characters`,
        });
    }
    if (draft.modelIds.length === 0) {
        problems.push({ field: "modelIds", reason: "must name at least one model" });
    } else if (draft.modelIds.length > maxModels) {
        problems.push({
            field: "modelIds",
            reason: `must name at most ${maxModels} models`,
        });
    }
    if (draft.starters.length > maxStarters) {
        problems.push({
            field: "starters",
            reason: `must be at most ${maxStarters} starters`,
        });
    }
    draft.starters.forEach((starter, index) => {
        if ([...starter].length > maxStarterCharacters) {
            problems.push({
                field: `starters[${index}]`,
                reason: `must be at most ${maxStarterCharacters} characters`,
            });
        }
    });
    const seenFileIds = new Set<string>();
    draft.knowledgeManifest.forEach((entry, index) => {
        if (entry.fileId === "") {
            problems.push({
                field: `knowledgeManifest[${index}].fileId`,
                reason: "must not be empty",
            });
            return;
        }
        if (seenFileIds.has(entry.fileId)) {
            problems.push({
                field: `knowledgeManifest[${index}].fileId`,
                reason: "is listed twice",
            });
        }
        seenFileIds.add(entry.fileId);
    });
    return problems;
}

/* ------------------------------------------------------------ publish */

/** What the caller knows about the profile as it stands right now. */
export type AssistantProfileVersionState = {
    /** The published revision, or null for a profile with no version yet. */
    currentRevision: number | null;
    /** The current version's content, or null when there is none. */
    currentDraft: AssistantProfileVersionDraft | null;
};

export type ProfileVersionPublishPlan =
    | { outcome: "publish"; revision: number; draft: AssistantProfileVersionDraft }
    /**
     * The draft is byte-identical to what is already published. Publishing
     * anyway would fill the version history with revisions that changed
     * nothing, and every one of them is a snapshot some conversation could
     * pin to — history a user reading it cannot tell apart.
     */
    | { outcome: "unchanged"; revision: number }
    | { outcome: "stale"; code: typeof ASSISTANT_PROFILE_VERSION_STALE; currentRevision: number }
    | { outcome: "invalid"; problems: AssistantProfileProblem[] };

/** Structural equality of two drafts, on normalised values. */
const draftsEqual = (
    a: AssistantProfileVersionDraft,
    b: AssistantProfileVersionDraft
): boolean =>
    a.instructions === b.instructions &&
    a.modelIds.length === b.modelIds.length &&
    a.modelIds.every((id, index) => id === b.modelIds[index]) &&
    a.toolPolicy.webSearch === b.toolPolicy.webSearch &&
    a.toolPolicy.deepResearch === b.toolPolicy.deepResearch &&
    a.memoryPolicy.useAccountMemory === b.memoryPolicy.useAccountMemory &&
    a.starters.length === b.starters.length &&
    a.starters.every((starter, index) => starter === b.starters[index]) &&
    a.knowledgeManifest.length === b.knowledgeManifest.length &&
    a.knowledgeManifest.every((entry, index) => {
        const other = b.knowledgeManifest[index];
        return (
            other != null &&
            entry.fileId === other.fileId &&
            entry.digest === other.digest
        );
    });

/**
 * Decides what publishing this draft should do.
 *
 * `expectedRevision` is the revision the editor started from — null when the
 * editor is creating a profile's first version. The three refusals are
 * ordered deliberately: staleness first, because a stale editor's content is
 * not worth validating, and "unchanged" last, because a draft that fails
 * validation is not unchanged, it is wrong.
 */
export function planProfileVersionPublish(input: {
    state: AssistantProfileVersionState;
    draft: AssistantProfileVersionDraft;
    expectedRevision: number | null;
}): ProfileVersionPublishPlan {
    const { state, expectedRevision } = input;
    if (expectedRevision !== state.currentRevision) {
        return {
            outcome: "stale",
            code: ASSISTANT_PROFILE_VERSION_STALE,
            // Reported so the client can re-read exactly one thing rather
            // than refetching the profile to discover what it missed.
            currentRevision: state.currentRevision ?? 0,
        };
    }

    const draft = normalizeProfileVersionDraft(input.draft);
    const problems = profileVersionProblems(draft);
    if (problems.length > 0) return { outcome: "invalid", problems };

    if (state.currentDraft != null && state.currentRevision != null) {
        // The stored draft is normalised too: a version written before a
        // normalisation rule changed would otherwise read as "different" and
        // publish a revision on the first save that touched nothing.
        const current = normalizeProfileVersionDraft(state.currentDraft);
        if (draftsEqual(current, draft)) {
            return { outcome: "unchanged", revision: state.currentRevision };
        }
    }

    return {
        outcome: "publish",
        revision: (state.currentRevision ?? 0) + 1,
        draft,
    };
}

/* -------------------------------------------------- knowledge manifest */

export type ResolvedManifestEntry = AssistantKnowledgeManifestEntry & {
    /**
     * True only when a file with this id exists now, is owned by the same
     * account, has finished processing, and still has the digest the manifest
     * recorded. Anything else is unavailable — including a re-upload of the
     * same bytes under a new id, which is a different file (§14).
     */
    available: boolean;
};

/** One currently existing knowledge file, as the caller found it. */
export type AvailableKnowledgeFile = {
    fileId: string;
    digest: string;
    /** Only a fully processed file has chunks to retrieve from (§14). */
    processed: boolean;
};

/**
 * Answers a stored manifest against what exists today.
 *
 * Deliberately never returns a substitute. A file whose digest changed is
 * unavailable rather than "updated": the version recorded what it recorded,
 * and quietly retrieving different bytes under the same entry would make the
 * snapshot a lie. Retrieval reads only the entries this marks available.
 */
export function resolveKnowledgeManifest(
    manifest: readonly AssistantKnowledgeManifestEntry[],
    availableFiles: readonly AvailableKnowledgeFile[]
): { entries: ResolvedManifestEntry[]; availableCount: number; unavailableCount: number } {
    const byId = new Map(availableFiles.map((file) => [file.fileId, file]));
    const entries = manifest.map((entry) => {
        const file = byId.get(entry.fileId);
        return {
            ...entry,
            available:
                file != null && file.processed && file.digest === entry.digest,
        };
    });
    const availableCount = entries.filter((entry) => entry.available).length;
    return {
        entries,
        availableCount,
        unavailableCount: entries.length - availableCount,
    };
}
