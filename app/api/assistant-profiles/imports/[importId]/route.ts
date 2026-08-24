export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
    assertImportEnabled,
    importErrorResponse,
} from "@/lib/assistantProfileImportHttp";
import {
    cancelProfileImport,
    readProfileImport,
} from "@/lib/assistantProfileImportService";
import { authOptions } from "@/lib/auth";

/**
 * One import: what it is doing, and taking it back.
 *
 * docs/policy/assistant-package-import.md §5.6.
 *
 * GET is what step 7 watches while documents are processed. It answers with
 * per-file status and no content -- the wizard needs to know that a file is
 * ready, not what is in it.
 *
 * DELETE is the cancellation. What it removes depends on the mode, and the
 * service decides that: `create` takes its draft profile, `merge` takes only
 * the files this import staged. Neither is expressible as "delete the row and
 * let the cascade sort it out", because in `merge` the cascade would be
 * pointed at somebody's existing assistant.
 */

export async function GET(
    req: Request,
    { params }: { params: Promise<{ importId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await assertImportEnabled();
        // Read limits are looser than write limits because this is a poll: the
        // wizard asks every few seconds while extraction runs.
        await consumeApiRateLimit(req, userId, "assistant-package-import-read", {
            minute: 120,
            day: 2_000,
        });

        const { importId } = await params;
        const found = await readProfileImport({ userId, importId });
        return NextResponse.json(found, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const known = importErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to read an assistant package import:", error);
        return NextResponse.json(
            { error: "Failed to load the import." },
            { status: 500 }
        );
    }
}

export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ importId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await assertImportEnabled();
        await consumeApiRateLimit(req, userId, "assistant-package-import", {
            minute: 10,
            day: 100,
        });

        const { importId } = await params;
        const outcome = await cancelProfileImport({ userId, importId });
        return NextResponse.json(outcome, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const known = importErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to cancel an assistant package import:", error);
        return NextResponse.json(
            { error: "Failed to cancel the import." },
            { status: 500 }
        );
    }
}
