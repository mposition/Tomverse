/**
 * Policy: docs/policy/external-conversation-import-and-memory.md.
 * The owner's assistant profiles (Release C, C3a; policy §14, §21).
 *
 * List and create only. A profile's *behaviour* is a version, published
 * through `[profileId]/versions`, and keeping creation here identity-only is
 * what stops a profile existing with instructions nobody published — a state
 * that would have no revision number and so nothing for a conversation to pin
 * to.
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
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
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
    })
    .strict();

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
        return NextResponse.json(
            {
                profiles: await listAssistantProfiles(userId),
                limits: {
                    maxProfilesPerAccount:
                        ASSISTANT_KNOWLEDGE_LIMITS.maxProfilesPerAccount,
                },
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
