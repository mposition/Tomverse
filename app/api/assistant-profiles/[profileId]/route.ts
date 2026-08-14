/**
 * One assistant profile (Release C, C3a; policy §14, §21, §43).
 *
 * PATCH is identity only — name, icon, description. Instructions, models,
 * tools, memory policy and starters are a *version*, and editing them has to
 * publish a revision so the conversations pinned to the old one keep saying
 * what they actually ran under. A PATCH that could reach them would be the
 * retroactive edit the version table exists to prevent, so the schema for it
 * simply has no field for one.
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
    deleteAssistantProfile,
    readAssistantProfile,
    updateAssistantProfileIdentity,
} from "@/lib/assistantProfileService";
import { assistantProfileErrorResponse } from "@/app/api/assistant-profiles/route";
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import { authOptions } from "@/lib/auth";

const patchSchema = z
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

const requireOwner = async () => {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) return null;
    if (!(await isAssistantProfilesEnabled())) {
        throw new AssistantProfilesDisabledError();
    }
    return userId;
};

export async function GET(
    req: Request,
    { params }: { params: Promise<{ profileId: string }> }
) {
    try {
        const userId = await requireOwner();
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await consumeApiRateLimit(req, userId, "assistant-profiles-read", {
            minute: 60,
            day: 1_000,
        });
        const { profileId } = await params;
        return NextResponse.json(
            { profile: await readAssistantProfile(userId, profileId) },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const known = assistantProfileErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to read an assistant profile:", error);
        return NextResponse.json(
            { error: "Failed to load the profile." },
            { status: 500 }
        );
    }
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ profileId: string }> }
) {
    try {
        const userId = await requireOwner();
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await consumeApiRateLimit(req, userId, "assistant-profiles-write", {
            minute: 20,
            day: 200,
        });
        const { profileId } = await params;
        const body = await readLimitedJson(req, 8 * 1024, patchSchema);
        const profile = await updateAssistantProfileIdentity({
            userId,
            profileId,
            identity: {
                name: body.name,
                icon: body.icon ?? null,
                description: body.description ?? null,
            },
        });
        return NextResponse.json(
            { profile },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const known = assistantProfileErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to update an assistant profile:", error);
        return NextResponse.json(
            { error: "Failed to save the profile." },
            { status: 500 }
        );
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ profileId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        // Deletion stays available with the flag off, as knowledge deletion
        // does: §15's rollback closes the feature, it does not take away an
        // owner's ability to remove what they already stored.
        await consumeApiRateLimit(req, userId, "assistant-profiles-delete", {
            minute: 20,
            day: 100,
        });
        const { profileId } = await params;
        return NextResponse.json(
            await deleteAssistantProfile({ userId, profileId }),
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const known = assistantProfileErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to delete an assistant profile:", error);
        return NextResponse.json(
            { error: "Failed to delete the profile." },
            { status: 500 }
        );
    }
}
