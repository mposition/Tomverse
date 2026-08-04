import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import {
    assertExternalImportEnabled,
    ExternalImportDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import {
    deleteExternalImport,
    getExternalImportStatus,
    previewExternalSourceDeletion,
} from "@/lib/externalImportService";
import {
    readSourceDeletionDispositions,
    wantsMemoryImpact,
} from "@/lib/externalSourceDeletionRequest";

const disabledResponse = (error: ExternalImportDisabledError) =>
    NextResponse.json(
        { error: error.message, code: "EXTERNAL_IMPORT_DISABLED" },
        { status: 403 }
    );

export async function GET(
    req: Request,
    context: RouteContext<"/api/imports/external/[importId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertExternalImportEnabled();
        await consumeApiRateLimit(req, session.user.id, "external-import-status", {
            minute: 60,
            day: 2000,
        });

        const params = await context.params;
        const status = await getExternalImportStatus(
            session.user.id,
            params.importId
        );
        // Only when asked for: the delete confirmation needs it, an ordinary
        // status poll does not, and it costs a second query (§13.1).
        const memoryImpact = wantsMemoryImpact(new URL(req.url))
            ? await previewExternalSourceDeletion(session.user.id, {
                  importId: params.importId,
              })
            : undefined;
        return NextResponse.json({ ...status, memoryImpact }, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (error instanceof ExternalImportDisabledError) {
            return disabledResponse(error);
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external import status failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}

export async function DELETE(
    req: Request,
    context: RouteContext<"/api/imports/external/[importId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        // Deletion stays available while the feature flag is off: turning the
        // rollout off must never strand a user's already-imported data
        // (policy §15 rollback contract).
        await consumeApiRateLimit(req, session.user.id, "external-import-delete", {
            minute: 10,
            day: 100,
        });

        const params = await context.params;
        const result = await deleteExternalImport(
            session.user.id,
            params.importId,
            readSourceDeletionDispositions(new URL(req.url))
        );
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external import delete failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
