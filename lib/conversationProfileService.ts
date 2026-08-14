import "server-only";

import { isAssistantProfilesEnabled } from "@/lib/appSettings";
import {
    planProfileBinding,
    profileBindingStatus,
    PROFILE_BINDING_REFUSALS,
    type ProfileBindingPlan,
} from "@/lib/conversationProfileBinding";
import { prisma } from "@/lib/prisma";

/**
 * The read and write halves of §14's version pinning (C4).
 *
 * `lib/conversationProfileBinding.ts` decides what should happen; this reads
 * the rows that decision needs and turns the answer into columns. The division
 * is the one `lib/assistantProfileService.ts` already draws, and for the same
 * reason: nothing here re-derives a revision or re-implements the rule.
 *
 * Both chat entry points that can change a binding — creating a conversation
 * and patching one — go through `resolveProfileBinding`, so "bind to the
 * profile's *current* version" has exactly one implementation.
 */

export class ConversationProfileError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "ConversationProfileError";
    }
}

const storedModelIds = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];

/**
 * What a create or patch request should write, or a refusal to throw.
 *
 * Returns the plan rather than performing the write: the conversation routes
 * build one `updateData` and one transaction, and a service that wrote its own
 * row would make the profile change a second, separately-failing write.
 */
export async function resolveProfileBinding(input: {
    userId: string;
    /** `undefined` leaves the binding alone; `null` detaches. */
    requestedProfileId: string | null | undefined;
    /** The conversation's current binding. Null for one being created. */
    boundProfileId: string | null;
}): Promise<ProfileBindingPlan> {
    if (input.requestedProfileId === undefined) return { outcome: "unchanged" };

    // Read before deciding, and only when a profile was actually named: a
    // detach needs neither the flag nor the row.
    const flagEnabled =
        input.requestedProfileId === null
            ? true
            : await isAssistantProfilesEnabled();
    const profile =
        typeof input.requestedProfileId === "string"
            ? await prisma.assistantProfile.findFirst({
                  where: { id: input.requestedProfileId, userId: input.userId },
                  select: {
                      id: true,
                      currentVersionId: true,
                      currentVersion: {
                          select: { revision: true, models: true },
                      },
                  },
              })
            : null;

    const plan = planProfileBinding({
        requested: input.requestedProfileId,
        flagEnabled,
        boundProfileId: input.boundProfileId,
        profile: profile
            ? {
                  id: profile.id,
                  currentVersionId: profile.currentVersionId,
                  currentRevision: profile.currentVersion?.revision ?? null,
                  modelIds: storedModelIds(profile.currentVersion?.models),
              }
            : null,
    });

    if (plan.outcome === "refused") {
        const refusal = PROFILE_BINDING_REFUSALS[plan.reason];
        throw new ConversationProfileError(
            refusal.status,
            refusal.code,
            refusal.message
        );
    }
    return plan;
}

export type ConversationProfileSummary = {
    profileId: string;
    profileVersionId: string;
    name: string;
    icon: string | null;
    revision: number;
    latestRevision: number;
    status: "current" | "superseded";
    /** The version's own starters, for an empty conversation's suggestions. */
    starters: string[];
};

const storedStarters = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];

/**
 * What a conversation screen needs to say about its binding.
 *
 * Returns null when the conversation has none, and also when the pinned
 * version has been deleted out from under it — the column is `SetNull` on
 * delete, so that second case is already a null id rather than a dangling one.
 *
 * The latest revision is read here rather than inferred from the pinned one,
 * because "this conversation is on revision 3 and the profile is now on 5" is
 * the whole content of the offer to move (§14), and a screen cannot compute it
 * from the binding alone.
 */
export async function readConversationProfile(input: {
    userId: string;
    profileVersionId: string | null;
}): Promise<ConversationProfileSummary | null> {
    if (!input.profileVersionId) return null;
    const version = await prisma.assistantProfileVersion.findFirst({
        where: { id: input.profileVersionId, userId: input.userId },
        select: {
            id: true,
            revision: true,
            starters: true,
            profile: {
                select: {
                    id: true,
                    name: true,
                    icon: true,
                    currentVersion: { select: { revision: true } },
                },
            },
        },
    });
    if (!version) return null;
    const latestRevision = version.profile.currentVersion?.revision ?? version.revision;
    return {
        profileId: version.profile.id,
        profileVersionId: version.id,
        name: version.profile.name,
        icon: version.profile.icon,
        revision: version.revision,
        latestRevision,
        status: profileBindingStatus({
            pinnedRevision: version.revision,
            latestRevision,
        }),
        starters: storedStarters(version.starters),
    };
}
