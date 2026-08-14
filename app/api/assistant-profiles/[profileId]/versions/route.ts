/**
 * Publishing and listing profile versions (Release C, C3a; policy §14).
 *
 * POST is the only way a profile's behaviour changes, and it always produces a
 * new revision or nothing — never an edit to an existing one. The editor sends
 * the revision it started from; a mismatch is `ASSISTANT_PROFILE_VERSION_STALE`
 * and the user re-reads before republishing, which is what stops two tabs from
 * silently overwriting each other.
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
import { assistantProfileErrorResponse } from "@/app/api/assistant-profiles/route";
import {
    publishAssistantProfileVersion,
    readAssistantProfile,
} from "@/lib/assistantProfileService";
import { ASSISTANT_KNOWLEDGE_LIMITS } from "@/lib/assistantKnowledgeLimits";
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import { authOptions } from "@/lib/auth";

const publishSchema = z
    .object({
        // Null means "this profile has no version yet". Sending a number for a
        // profile that has none is stale, not a first publish -- the editor
        // saw something that is not there.
        expectedRevision: z.number().int().min(1).nullable(),
        instructions: z
            .string()
            .max(ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters),
        modelIds: z
            .array(z.string().trim().min(1).max(120))
            .min(1)
            .max(ASSISTANT_PROFILE_LIMITS.maxModels),
        toolPolicy: z
            .object({ webSearch: z.boolean(), deepResearch: z.boolean() })
            .strict(),
        memoryPolicy: z.object({ useAccountMemory: z.boolean() }).strict(),
        starters: z
            .array(
                z.string().trim().max(ASSISTANT_PROFILE_LIMITS.maxStarterCharacters)
            )
            .max(ASSISTANT_PROFILE_LIMITS.maxStarters),
        // Ids only. The name and the digest are read from the rows on the
        // server, because the digest is what a past version is compared
        // against and a client-supplied one would let a caller decide what a
        // past version is said to have contained.
        knowledgeFileIds: z
            .array(z.string().trim().min(1).max(64))
            .max(ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerProfile),
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
        const profile = await readAssistantProfile(userId, profileId);
        return NextResponse.json(
            {
                versions: profile.versions,
                currentVersionId: profile.currentVersionId,
            },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const known = assistantProfileErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to list profile versions:", error);
        return NextResponse.json(
            { error: "Failed to load the version history." },
            { status: 500 }
        );
    }
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ profileId: string }> }
) {
    try {
        const userId = await requireOwner();
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await consumeApiRateLimit(req, userId, "assistant-profiles-publish", {
            minute: 20,
            day: 200,
        });
        const { profileId } = await params;
        const body = await readLimitedJson(req, 64 * 1024, publishSchema);

        const result = await publishAssistantProfileVersion({
            userId,
            profileId,
            expectedRevision: body.expectedRevision,
            draft: {
                instructions: body.instructions,
                modelIds: body.modelIds,
                toolPolicy: body.toolPolicy,
                memoryPolicy: body.memoryPolicy,
                starters: body.starters,
                // The planner's draft shape carries entries; only the id is
                // load-bearing here, and the service replaces the rest from
                // the rows before anything is stored.
                knowledgeManifest: body.knowledgeFileIds.map((fileId) => ({
                    fileId,
                    name: "",
                    digest: "",
                })),
            },
        });

        // 200 for "nothing changed" and 201 for a new revision, so a client can
        // tell whether its Save produced history without comparing numbers.
        return NextResponse.json(result, {
            status: result.outcome === "published" ? 201 : 200,
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const known = assistantProfileErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to publish a profile version:", error);
        return NextResponse.json(
            { error: "Failed to publish the profile." },
            { status: 500 }
        );
    }
}
