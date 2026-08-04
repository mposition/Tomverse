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
import { sealExternalImport } from "@/lib/externalImportService";

/**
 * POST /api/imports/external/[importId]/seal
 *
 * docs/policy/external-conversation-import-and-memory.md §5.5.
 *
 * The client declares that its upload is finished — the last batch sequence
 * it sent, the staged conversation ids the batch responses gave it, and how
 * many duplicates it was told were skipped. The server does not take that on
 * trust: every declared value is compared against a row the server wrote
 * itself, and only an exact match moves the import to `preview_ready`.
 *
 * Seal fixes completeness, not selection. Finalize still accepts any subset
 * of the sealed staged set, and recomputes the import digest for whatever
 * subset it is given.
 */
const sealSchema = z
    .object({
        finalSequence: z.number().int().min(0).max(1_000_000),
        expectedStagedConversationIds: z
            .array(z.string().min(1).max(64))
            .max(2_000),
        expectedDuplicateCount: z.number().int().min(0).max(1_000_000),
    })
    .strict();

export async function POST(
    req: Request,
    context: RouteContext<"/api/imports/external/[importId]/seal">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertExternalImportEnabled();
        await consumeApiRateLimit(req, session.user.id, "external-import-seal", {
            minute: 10,
            day: 200,
        });

        const body = await readLimitedJson(
            req,
            EXTERNAL_IMPORT_MAX_CONTROL_REQUEST_BYTES,
            sealSchema
        );
        const params = await context.params;
        const result = await sealExternalImport({
            userId: session.user.id,
            importId: params.importId,
            finalSequence: body.finalSequence,
            expectedStagedConversationIds: body.expectedStagedConversationIds,
            expectedDuplicateCount: body.expectedDuplicateCount,
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
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external import seal failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
