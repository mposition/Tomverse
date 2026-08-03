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
} from "@/lib/externalImportService";

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
        return NextResponse.json(status, {
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
            params.importId
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
