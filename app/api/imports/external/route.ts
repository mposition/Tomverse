import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    assertExternalImportEnabled,
    ExternalImportDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { EXTERNAL_IMPORT_MAX_CONTROL_REQUEST_BYTES } from "@/lib/externalImportLimits";
import { createExternalImport } from "@/lib/externalImportService";

const createImportSchema = z
    .object({
        provider: z.enum(["chatgpt", "claude"]),
        parserVersion: z.string().trim().min(1).max(64),
        // A hint for duplicate-candidate UX only; never an authoritative
        // dedup input (policy §4.1) and never logged.
        clientFingerprint: z.string().trim().min(1).max(128).optional(),
    })
    .strict();

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertExternalImportEnabled();
        await consumeApiRateLimit(req, session.user.id, "external-import-create", {
            minute: 5,
            day: 50,
        });

        const body = await readLimitedJson(
            req,
            EXTERNAL_IMPORT_MAX_CONTROL_REQUEST_BYTES,
            createImportSchema
        );
        const row = await createExternalImport({
            userId: session.user.id,
            provider: body.provider,
            parserVersion: body.parserVersion,
            clientFingerprint: body.clientFingerprint ?? null,
        });
        return NextResponse.json(
            {
                importId: row.id,
                status: row.status,
                digestVersion: row.digestVersion,
            },
            { status: 201, headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        if (error instanceof ExternalImportDisabledError) {
            return NextResponse.json(
                { error: error.message, code: "EXTERNAL_IMPORT_DISABLED" },
                { status: 403 }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external import create failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
