import { NextResponse } from "next/server";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    assertExternalImportEnabled,
    ExternalImportDisabledError,
} from "@/lib/appSettings";
import {
    PERPLEXITY_SPLIT_MAX_REQUEST_BYTES,
    perplexitySplitEnabled,
    perplexitySplitRequestSchema,
    requestPerplexitySplitHints,
} from "@/lib/perplexitySplitHints";

/**
 * POST /api/imports/external/perplexity-split
 *
 * Answers the split questions a Perplexity Markdown export leaves open
 * (lib/perplexitySplitHints.ts). Called by the import worker with excerpts
 * only; nothing here is stored. Every refusal is a signal for the browser to
 * keep the file's own split, never a failure of the import.
 */
export async function POST(req: Request) {
    try {
        const authentication = await resolveChatRouteSession(req);
        if (authentication.response) return authentication.response;
        const session = authentication.session;
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertExternalImportEnabled();
        if (!perplexitySplitEnabled()) {
            return NextResponse.json(
                { error: "Perplexity split hints are off.", code: "PERPLEXITY_SPLIT_DISABLED" },
                { status: 404 }
            );
        }
        await consumeApiRateLimit(req, session.user.id, "external-import-perplexity-split", {
            minute: 10,
            day: 200,
        });

        const questions = await readLimitedJson(
            req,
            PERPLEXITY_SPLIT_MAX_REQUEST_BYTES,
            perplexitySplitRequestSchema
        );
        const outcome = await requestPerplexitySplitHints(questions);
        if (!outcome.ok) {
            return NextResponse.json(
                { error: "No split hints.", code: `PERPLEXITY_SPLIT_${outcome.reason.toUpperCase()}` },
                { status: outcome.reason === "budget" ? 429 : 503, headers: { "Cache-Control": "no-store" } }
            );
        }
        return NextResponse.json(
            { hints: outcome.hints },
            { headers: { "Cache-Control": "no-store" } }
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
        console.error("perplexity split hints failed", error instanceof Error ? error.name : "unknown");
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
