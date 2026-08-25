/**
 * Policy: docs/policy/external-conversation-import-and-memory.md.
 * The owner's assistant profiles (Release C, C3a; policy §14, §21).
 *
 * List and create. A profile's *behaviour* is a version, and later edits are
 * published through `[profileId]/versions`; create additionally accepts the
 * first one so a profile never exists without a revision to pin to. That was
 * previously enforced by refusing behaviour here, which produced the same
 * unusable state from the other direction — an identity row with no version,
 * listed and pickable and unable to start a conversation.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    AssistantProfilesDisabledError,
    isAssistantPackageImportEnabled,
    isAssistantProfilesEnabled,
} from "@/lib/appSettings";
import {
    AssistantProfileError,
    createAssistantProfile,
    listAssistantProfiles,
} from "@/lib/assistantProfileService";
// The account-wide profile ceiling is a §14.1 figure and lives with the other
// approved ones in the knowledge limits module; the per-field limits are the
// profile's own.
import { ASSISTANT_KNOWLEDGE_LIMITS } from "@/lib/assistantKnowledgeLimits";
import {
    ASSISTANT_PROFILE_LIMITS,
    ASSISTANT_PROFILE_MODEL_UNAVAILABLE,
} from "@/lib/assistantProfileVersioning";
import {
    clampSelectedModelsAgainstRuntime,
    getRuntimeModels,
} from "@/lib/modelRegistry";
import { authOptions } from "@/lib/auth";

const createSchema = z
    .object({
        name: z.string().trim().min(1).max(ASSISTANT_PROFILE_LIMITS.maxNameCharacters),
        icon: z
            .string()
            .trim()
            .max(ASSISTANT_PROFILE_LIMITS.maxIconCharacters)
            .nullish(),
        description: z
            .string()
            .trim()
            .max(ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters)
            .nullish(),
        /**
         * The first version, published with the identity in one transaction.
         *
         * `instructions` is required here and not by
         * `profileVersionProblems`: a *published* profile may legitimately
         * carry none — it is then a model preset — but a profile created from
         * the minimal form is created because the user has something to say,
         * and an empty box submitted by accident should be refused at the
         * field rather than saved as an assistant that does nothing.
         */
        instructions: z
            .string()
            .trim()
            .min(1)
            .max(ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters)
            .optional(),
        // No floor, for the reason `modelIds` has none when publishing: an
        // empty list is a profile that names no model, and refusing it here
        // would make the same state a payload error on one route and the
        // ordinary case on the other.
        modelIds: z
            .array(z.string().trim().min(1))
            .max(ASSISTANT_PROFILE_LIMITS.maxModels)
            .optional(),
    })
    .strict()
    .refine((value) => value.modelIds === undefined || value.instructions !== undefined, {
        // Models without instructions would publish a first version the form
        // never asked for. The pair travels together or not at all.
        path: ["instructions"],
        message: "instructions is required when modelIds is supplied",
    });

export const assistantProfileErrorResponse = (error: unknown) => {
    if (error instanceof AssistantProfileError) {
        return NextResponse.json(
            {
                error: error.message,
                code: error.code,
                ...(error.problems ? { problems: error.problems } : {}),
            },
            { status: error.status, headers: { "Cache-Control": "no-store" } }
        );
    }
    if (error instanceof AssistantProfilesDisabledError) {
        return NextResponse.json(
            {
                error: "Assistant profiles are not enabled.",
                code: "ASSISTANT_PROFILES_DISABLED",
            },
            { status: 403, headers: { "Cache-Control": "no-store" } }
        );
    }
    return null;
};

const requireOwner = async () => {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) return null;
    // Guests are excluded outright (§8.1's shape, applied to profiles): a
    // profile carries instructions, a model choice and knowledge that all
    // belong to an account.
    if (!(await isAssistantProfilesEnabled())) {
        throw new AssistantProfilesDisabledError();
    }
    return userId;
};

export async function GET(req: Request) {
    try {
        const userId = await requireOwner();
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await consumeApiRateLimit(req, userId, "assistant-profiles-read", {
            minute: 60,
            day: 1_000,
        });
        const [profiles, packageImport] = await Promise.all([
            listAssistantProfiles(userId),
            // The list is this screen's availability probe already, so the
            // import entry point asks it the same question rather than the
            // page reading a second flag server-side and giving the screen two
            // places that decide what is available.
            //
            // Deliberately the import flag alone, which is what
            // `/settings/assistants/import` answers 404 on. `assertImportEnabled()`
            // additionally requires knowledge to be on, but a button that
            // matched *that* would hide while the page it points at still
            // rendered. The invariant worth keeping is the narrower one: the
            // entry point is offered exactly when the destination is not a 404.
            isAssistantPackageImportEnabled(),
        ]);
        return NextResponse.json(
            {
                profiles,
                limits: {
                    maxProfilesPerAccount:
                        ASSISTANT_KNOWLEDGE_LIMITS.maxProfilesPerAccount,
                },
                features: { packageImport },
            },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const known = assistantProfileErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to list assistant profiles:", error);
        return NextResponse.json(
            { error: "Failed to load profiles." },
            { status: 500 }
        );
    }
}

/**
 * The models a created profile is published with, checked against the
 * catalogue the server actually serves.
 *
 * `clampSelectedModelsAgainstRuntime` *drops* what it cannot resolve, which is
 * right for restoring a stored conversation and wrong here: a create naming a
 * model that does not exist would silently become a create naming fewer, and
 * the owner would find a profile running something they did not choose. So the
 * clamp is used as the check and a shortfall is a refusal.
 *
 * Naming none stays none (§14.0a). Filling in the account's default here was
 * the older behaviour and it pinned a model nobody chose: the profile went on
 * starting conversations on whatever the account's default was on the day it
 * was created, and changing that default later left every existing assistant
 * behind. An empty list means the profile names no model, and
 * `POST /api/conversations` resolves the account's own new-conversation
 * selection at the moment a conversation is actually started.
 */
const resolveCreateModelIds = async (
    requested: string[] | undefined
): Promise<string[]> => {
    if (requested === undefined || requested.length === 0) return [];
    const models = await getRuntimeModels();
    const resolved = clampSelectedModelsAgainstRuntime(
        requested,
        models,
        ASSISTANT_PROFILE_LIMITS.maxModels
    );
    if (resolved.length !== new Set(requested).size) {
        throw new AssistantProfileError(
            422,
            ASSISTANT_PROFILE_MODEL_UNAVAILABLE,
            "One of those models is not available."
        );
    }
    return resolved;
};

export async function POST(req: Request) {
    try {
        const userId = await requireOwner();
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await consumeApiRateLimit(req, userId, "assistant-profiles-write", {
            minute: 20,
            day: 200,
        });
        const body = await readLimitedJson(req, 8 * 1024, createSchema);
        const profile = await createAssistantProfile({
            userId,
            identity: {
                name: body.name,
                icon: body.icon ?? null,
                description: body.description ?? null,
            },
            firstVersion:
                body.instructions === undefined
                    ? undefined
                    : {
                          instructions: body.instructions,
                          modelIds: await resolveCreateModelIds(body.modelIds),
                          // The narrow-only defaults (§14). A profile created
                          // from the minimal form asks for nothing beyond
                          // instructions, and a tool it never requested must
                          // not arrive switched on. Widening happens in the
                          // editor, explicitly, and still cannot exceed what
                          // the account's plan allows at runtime.
                          toolPolicy: { webSearch: false, deepResearch: false },
                          memoryPolicy: { useAccountMemory: false },
                          starters: [],
                          knowledgeManifest: [],
                      },
        });
        return NextResponse.json(
            { profile },
            { status: 201, headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const known = assistantProfileErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to create an assistant profile:", error);
        return NextResponse.json(
            { error: "Failed to create the profile." },
            { status: 500 }
        );
    }
}
