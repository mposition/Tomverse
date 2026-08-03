import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { EXTERNAL_IMPORT_DIGEST_VERSION } from "@/lib/externalImportDigest";
import { iterateExternalExportConversations } from "@/lib/externalImportService";

export const dynamic = "force-dynamic";

/**
 * Downloads every finalized imported conversation with provenance (policy
 * §21) as one JSON document, streamed — the account may hold up to 50MB of
 * normalized text, which is never materialized whole.
 *
 * Not gated on the rollout flag, like DELETE: getting one's data back out is
 * part of the same never-strand-imported-data rollback contract (§15).
 * Distinct from the Release B memory export (§13.2), which has its own
 * re-authentication rules — nothing here is memory data.
 */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "external-import-export", {
            minute: 3,
            day: 30,
        });

        const userId = session.user.id;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                let conversationCount = 0;
                try {
                    controller.enqueue(
                        encoder.encode(
                            `{"format":"tomverse.external-conversations.v1",` +
                                `"digestVersion":${EXTERNAL_IMPORT_DIGEST_VERSION},` +
                                `"generatedAt":${JSON.stringify(new Date().toISOString())},` +
                                `"conversations":[`
                        )
                    );
                    for await (const conversation of iterateExternalExportConversations(
                        userId
                    )) {
                        controller.enqueue(
                            encoder.encode(
                                `${conversationCount > 0 ? "," : ""}${JSON.stringify(conversation)}`
                            )
                        );
                        conversationCount += 1;
                    }
                    controller.enqueue(encoder.encode(`]}`));
                    // Content-free by §22: a count, never a title or content.
                    console.info(
                        JSON.stringify({
                            event: "external_import_export",
                            conversations: conversationCount,
                        })
                    );
                    controller.close();
                } catch (error) {
                    console.error("external import export stream failed", {
                        errorName:
                            error instanceof Error
                                ? error.name
                                : "UnknownError",
                    });
                    controller.error(error);
                }
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Disposition":
                    'attachment; filename="tomverse-external-conversations.json"',
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external import export failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
