export const maxDuration = 120;
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
    assertImportEnabled,
    importErrorResponse,
} from "@/lib/assistantProfileImportHttp";
import { exportAssistantProfilePackage } from "@/lib/assistantProfileExportService";
import { authOptions } from "@/lib/auth";

/**
 * Downloading an assistant as a package.
 *
 * docs/policy/assistant-package-import.md §6.
 *
 * Read-only: it creates nothing and changes nothing, which is why it is a GET
 * and why turning it off is the whole of its rollback.
 *
 * Behind the same flag as the import, deliberately. The format exists to be
 * read back, so a download nothing can open would be a file people keep and
 * later find out means nothing. The two move together.
 *
 * The archive is built in memory and sent whole rather than streamed. It is
 * bounded by the same ceiling the reader applies -- a package this app would
 * refuse to open is one it has no business producing -- and a streamed ZIP
 * would have to decide its own size before it knew it.
 */
export async function GET(
    req: Request,
    { params }: { params: Promise<{ profileId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await assertImportEnabled();
        // Tighter than the import's own limits: each call reads every document
        // this profile holds out of object storage.
        await consumeApiRateLimit(req, userId, "assistant-package-export", {
            minute: 5,
            day: 50,
        });

        const { profileId } = await params;
        const exported = await exportAssistantProfilePackage({ userId, profileId });

        return new NextResponse(exported.zip as unknown as BodyInit, {
            headers: {
                "Content-Type": "application/zip",
                // The filename is built from the profile's name and reduced to
                // path-safe characters before it gets here, because this header
                // is a place where a quote or a newline is not cosmetic.
                "Content-Disposition": `attachment; filename="${exported.filename}"`,
                "Content-Length": String(exported.zip.byteLength),
                // How many documents the version named and the profile no
                // longer holds. A header rather than a field in the archive:
                // the archive describes what it carries, and this describes
                // what it could not.
                "X-Assistant-Package-Omitted-Documents": String(
                    exported.omittedDocuments
                ),
                "Cache-Control": "no-store",
            },
        });
    } catch (error) {
        const known = importErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to export an assistant package:", error);
        return NextResponse.json(
            { error: "Failed to export the assistant." },
            { status: 500 }
        );
    }
}
