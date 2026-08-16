/**
 * Binding a conversation to an assistant profile (C4).
 *
 * docs/policy/external-conversation-import-and-memory.md §14 ("버전 고정"),
 * §14.
 *
 * §14 fixes the rule in one sentence: a new conversation pins to the latest
 * active version, an existing conversation keeps the version it started with,
 * nothing is applied retroactively, and moving to a newer version is an
 * explicit user action. Everything here exists to make that structural rather
 * than remembered.
 *
 * ## Why the client names a profile and never a version
 *
 * The same rule C2b settled for knowledge files. A version id supplied by a
 * client is a claim about which snapshot to run, and the server is the only
 * party that knows which snapshot is current — so the request says "this
 * profile" and the server writes down which revision that was at the moment
 * it bound. A client that could name a revision could pin a conversation to a
 * draft, or to a revision the owner has since replaced.
 *
 * ## Superseded is a state, not a problem to fix
 *
 * When the owner publishes revision 4, every conversation still pinned to
 * revision 3 keeps answering under revision 3. That is the point of pinning:
 * an assistant that silently changed its instructions mid-conversation would
 * make its own past answers unexplainable. `profileBindingStatus` names the
 * state so a screen can offer the move; nothing here performs one.
 */

export type ProfileBindingStatus = "current" | "superseded";

/**
 * Whether the pinned revision is still the profile's newest.
 *
 * `superseded` is deliberately not called "stale". Stale implies something
 * that ought to be refreshed, and a conversation that keeps answering under
 * the revision it started with is behaving correctly — the label is for a
 * screen that offers a move, not for a system that performs one.
 */
export function profileBindingStatus(input: {
    pinnedRevision: number;
    latestRevision: number;
}): ProfileBindingStatus {
    return input.pinnedRevision >= input.latestRevision
        ? "current"
        : "superseded";
}

/**
 * What a chat screen knows about the assistant a conversation runs under.
 *
 * Declared here rather than in a component because three layers pass it
 * through — the page, both shells and the composer — and a shape re-declared
 * per layer is a shape that drifts. Server-computed: the revision and the
 * status are `readConversationProfile`'s answers, never a client's arithmetic.
 */
export type ChatAssistantProfile = {
    profileId: string;
    name: string;
    icon: string | null;
    revision: number;
    latestRevision: number;
    status: ProfileBindingStatus;
};

/** One selectable profile in the picker. Only published profiles appear. */
export type ChatAssistantProfileOption = {
    id: string;
    name: string;
    icon: string | null;
    description: string | null;
    revision: number;
};

export type ProfileBindingRefusal =
    | "flag_off"
    | "not_found"
    | "no_active_version";

export type ProfileBindingPlan =
    | {
          outcome: "bind";
          profileId: string;
          profileVersionId: string;
          revision: number;
          /**
           * The version's own model list. **Only a conversation being created
           * adopts it; binding to an existing conversation does not.**
           *
           * A profile that names a model and then answers on a different one
           * is a profile whose model choice does nothing -- so a new
           * conversation starts from the profile's models (`POST
           * /api/conversations` reads this field). Copied rather than
           * referenced: the selection is the user's to change afterwards, and
           * changing it does not edit the profile.
           *
           * `PATCH /api/conversations/:id` deliberately ignores this field and
           * writes only the profile version. Swapping an existing
           * conversation's models changes its per-turn credit cost, its answer
           * characteristics and its panel layout at once, and a user who
           * picked an assistant did not ask for any of that. Replacing them is
           * a separate, explicit action -- see #643 -- and if it is ever
           * built it belongs in this plan and one atomic write, never in a
           * client response handler (that is what produced #632).
           */
          modelIds: readonly string[];
      }
    | { outcome: "detach" }
    | { outcome: "unchanged" }
    | { outcome: "refused"; reason: ProfileBindingRefusal };

/**
 * What a request to change a conversation's profile should do.
 *
 * Pure: the caller has already read the profile and the flag. `requested`
 * carries the three-way distinction the API needs — `undefined` is "this
 * request is not about the profile at all", `null` is "detach", and a string
 * is "bind to this one".
 */
export function planProfileBinding(input: {
    requested: string | null | undefined;
    flagEnabled: boolean;
    /** The conversation's current binding, or null when it has none. */
    boundProfileId: string | null;
    /**
     * The requested profile as the database has it, or null when the account
     * owns no such profile. Ignored when `requested` is not a string.
     */
    profile: {
        id: string;
        currentVersionId: string | null;
        currentRevision: number | null;
        modelIds: readonly string[];
    } | null;
}): ProfileBindingPlan {
    if (input.requested === undefined) return { outcome: "unchanged" };

    if (input.requested === null) {
        // Detaching is allowed with the flag off, and on purpose: a flag is a
        // rollout control, and an account left holding a conversation it
        // cannot detach because the feature was switched off would have no
        // way back to an ordinary chat.
        return input.boundProfileId === null
            ? { outcome: "unchanged" }
            : { outcome: "detach" };
    }

    if (!input.flagEnabled) return { outcome: "refused", reason: "flag_off" };
    if (!input.profile) return { outcome: "refused", reason: "not_found" };
    if (
        input.profile.currentVersionId === null ||
        input.profile.currentRevision === null
    ) {
        // A profile with no published version is a draft. Binding to one
        // would leave a conversation pointing at nothing, which the runtime
        // would then refuse on every turn — so it is refused here, once,
        // where the user can still do something about it.
        return { outcome: "refused", reason: "no_active_version" };
    }

    // Re-binding the same profile is not a no-op: it is how an explicit move
    // to a newer revision is expressed (§14). The conversation's stored
    // version id is what decides whether anything actually changes, and that
    // comparison belongs to the caller, which knows it.
    return {
        outcome: "bind",
        profileId: input.profile.id,
        profileVersionId: input.profile.currentVersionId,
        revision: input.profile.currentRevision,
        modelIds: input.profile.modelIds,
    };
}

export const PROFILE_BINDING_REFUSALS: Record<
    ProfileBindingRefusal,
    { status: number; code: string; message: string }
> = {
    flag_off: {
        status: 403,
        code: "ASSISTANT_PROFILES_DISABLED",
        message: "Assistant profiles are not available.",
    },
    // 404 rather than 403, the same reading the profile API takes: a profile
    // the caller does not own is, as far as they are entitled to know, a
    // profile that does not exist.
    not_found: {
        status: 404,
        code: "ASSISTANT_PROFILE_NOT_FOUND",
        message: "No such profile.",
    },
    no_active_version: {
        status: 409,
        code: "ASSISTANT_PROFILE_NO_ACTIVE_VERSION",
        message: "This profile has no published version yet.",
    },
};
