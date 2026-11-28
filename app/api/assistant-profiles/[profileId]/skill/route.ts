export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
    AssistantProfilesDisabledError,
    isAssistantPackageImportEnabled,
    isAssistantProfilesEnabled,
} from "@/lib/appSettings";
import { importErrorResponse } from "@/lib/assistantProfileImportHttp";
import {
    AssistantProfileError,
    readAssistantProfile,
} from "@/lib/assistantProfileService";
import {
    SKILL_DOCUMENT_FILENAME,
    buildSkillDocument,
} from "@/lib/assistantSkillDocument";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";

/**
 * Downloading an assistant as an Agent Skills `SKILL.md`.
 *
 * docs/policy/assistant-package-import.md §6.
 *
 * Read-only, and behind the same two flags as the import it mirrors: a file
 * nothing can open is a file people keep and later find means nothing. It
 * carries the published version's instructions only. Knowledge documents,
 * models, tool and memory policy have no place in `SKILL.md`, so they stay out;
 * the full package download is the route that carries documents.
 */
export async function GET(
    req: Request,
    { params }: { params: Promise<{ profileId: string }> }
) {
    try {
        const authentication = await resolveChatRouteSession(req);
        if (authentication.response) return authentication.response;
        const userId = authentication.session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const [profilesEnabled, importEnabled] = await Promise.all([
            isAssistantProfilesEnabled(),
            isAssistantPackageImportEnabled(),
        ]);
        if (!profilesEnabled || !importEnabled) {
            throw new AssistantProfilesDisabledError();
        }
        await consumeApiRateLimit(req, userId, "assistant-skill-export", {
            minute: 10,
            day: 100,
        });

        const { profileId } = await params;
        const profile = await readAssistantProfile(userId, profileId);
        if (!profile.currentVersion) {
            // A draft has no published instructions to write.
            throw new AssistantProfileError(
                409,
                "ASSISTANT_PROFILE_NO_ACTIVE_VERSION",
                "This assistant has no published version to export."
            );
        }

        const document = buildSkillDocument({
            name: profile.name,
            description: profile.description,
            instructions: profile.currentVersion.instructions,
        });
        return new NextResponse(document, {
            headers: {
                "Content-Type": "text/markdown; charset=utf-8",
                // A constant name, so nothing the owner typed reaches a header.
                "Content-Disposition": `attachment; filename="${SKILL_DOCUMENT_FILENAME}"`,
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        const known = importErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to export an assistant as SKILL.md:", error);
        return NextResponse.json(
            { error: "Failed to export the assistant." },
            { status: 500 }
        );
    }
}
