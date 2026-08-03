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
import { getExternalImportCapacity } from "@/lib/externalImportService";

// Remaining account quota, served BEFORE the client parses anything: the
// user must never learn about the 50MB cap only after a long local parse
// (policy §5.3 / §14 of the A-series contract). Server-authoritative — the
// client mirror of these numbers is display-only.
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertExternalImportEnabled();
        await consumeApiRateLimit(req, session.user.id, "external-import-capacity", {
            minute: 30,
            day: 500,
        });

        const capacity = await getExternalImportCapacity(session.user.id);
        return NextResponse.json(capacity, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (error instanceof ExternalImportDisabledError) {
            return NextResponse.json(
                { error: error.message, code: "EXTERNAL_IMPORT_DISABLED" },
                { status: 403 }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external import capacity failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
