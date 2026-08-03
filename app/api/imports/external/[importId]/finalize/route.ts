import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import {
    ApiSecurityError,
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
import { recordExternalImportCounter } from "@/lib/externalImportMetrics";
import { finalizeExternalImport } from "@/lib/externalImportService";

const finalizeSchema = z
    .object({
        idempotencyKey: z.string().min(1).max(100),
        selectedConversationIds: z
            .array(z.string().min(1).max(64))
            .min(1)
            .max(2_000),
        expectedImportDigest: z.string().length(64).optional(),
    })
    .strict();

export async function POST(
    req: Request,
    context: RouteContext<"/api/imports/external/[importId]/finalize">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertExternalImportEnabled();
        await consumeApiRateLimit(req, session.user.id, "external-import-finalize", {
            minute: 5,
            day: 100,
        });

        const body = await readLimitedJson(
            req,
            EXTERNAL_IMPORT_MAX_CONTROL_REQUEST_BYTES,
            finalizeSchema
        );
        const params = await context.params;
        const result = await finalizeExternalImport({
            userId: session.user.id,
            importId: params.importId,
            idempotencyKey: body.idempotencyKey,
            selectedConversationIds: body.selectedConversationIds,
            expectedImportDigest: body.expectedImportDigest ?? null,
        });
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (error instanceof ExternalImportDisabledError) {
            return NextResponse.json(
                { error: error.message, code: "EXTERNAL_IMPORT_DISABLED" },
                { status: 403 }
            );
        }
        if (
            error instanceof ApiSecurityError &&
            error.code === "EXTERNAL_IMPORT_QUOTA_EXCEEDED"
        ) {
            // Quota refusals leave no terminal row to aggregate (§22): the
            // import stays in staging, so the rejection is a day counter.
            await recordExternalImportCounter("quota_rejected");
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external import finalize failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
