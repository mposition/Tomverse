/**
 * Deleting one knowledge file (Release C, C2; policy §14.2, §21).
 *
 * The rows go here and the bytes go on the next sweep. That order is the
 * contract: R2 is never deleted ahead of the database, so a partial failure
 * retries from the tombstone rather than leaving a chunk that points at bytes
 * which are gone.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
    AssistantProfilesDisabledError,
    isAssistantKnowledgeEnabled,
    isAssistantProfilesEnabled,
} from "@/lib/appSettings";
import {
    AssistantKnowledgeError,
    deleteKnowledgeFile,
} from "@/lib/assistantKnowledgeService";
import { authOptions } from "@/lib/auth";

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ profileId: string; fileId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        // Deletion stays available when the flag is off, deliberately. §15's
        // rollback says turning a flag off closes the feature; it does not say
        // an owner loses the ability to remove data they already stored.
        if (
            !(await isAssistantKnowledgeEnabled()) &&
            // Still gated on profiles existing at all: with the whole release
            // off there is nothing here to manage.
            !(await isAssistantProfilesEnabled())
        ) {
            throw new AssistantProfilesDisabledError();
        }
        await consumeApiRateLimit(req, userId, "assistant-knowledge-delete", {
            minute: 30,
            day: 300,
        });

        const { profileId, fileId } = await params;
        const result = await deleteKnowledgeFile({ userId, profileId, fileId });
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (error instanceof AssistantKnowledgeError) {
            return NextResponse.json(
                { error: error.message, code: error.code },
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
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Assistant knowledge deletion failed:", error);
        return NextResponse.json(
            { error: "Failed to delete the knowledge file." },
            { status: 500 }
        );
    }
}
