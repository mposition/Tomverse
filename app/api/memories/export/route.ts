export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
    assertRecentAdminAuthentication,
    isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { MEMORY_EXPORT_FORMAT } from "@/lib/memoryExportCore";
import { iterateMemoryExportItems } from "@/lib/memoryService";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Full memory export (policy §13.2).
 *
 * Three things make this different from the Release A imported-data export:
 * it is re-authentication gated, it is never written to disk, and it is
 * audited at both ends.
 *
 * Not gated on the rollout flag, and deliberately so — this is the same
 * §15 never-strand posture the list and delete already take. Turning the
 * feature off must not trap a user's reviewed memories inside an account
 * they can no longer get them out of.
 *
 * `assertRecentAdminAuthentication` reads session freshness, not an admin
 * role; account deletion already uses it as the account-holder step-up for a
 * sensitive action, and reusing it keeps one step-up contract (and one 428
 * client path) rather than inventing a second.
 */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "memory-export", {
            minute: 3,
            day: 30,
        });
        await assertRecentAdminAuthentication(session);

        const userId = session.user.id;
        logSecurityAuditEvent("memory.export.create", {
            userId,
            request: req,
            outcome: "success",
        });

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                let itemCount = 0;
                try {
                    controller.enqueue(
                        encoder.encode(
                            `{"format":${JSON.stringify(MEMORY_EXPORT_FORMAT)},` +
                                `"generatedAt":${JSON.stringify(new Date().toISOString())},` +
                                `"items":[`
                        )
                    );
                    for await (const item of iterateMemoryExportItems(userId)) {
                        controller.enqueue(
                            encoder.encode(
                                (itemCount === 0 ? "" : ",") +
                                    JSON.stringify(item)
                            )
                        );
                        itemCount += 1;
                    }
                    controller.enqueue(
                        encoder.encode(`],"itemCount":${itemCount}}`)
                    );
                    controller.close();
                    logSecurityAuditEvent("memory.export.download", {
                        userId,
                        outcome: "success",
                    });
                } catch (error) {
                    // The document is already partly on the wire, so there is
                    // no status code left to change: abort so the client sees
                    // a truncated transfer rather than a valid-looking export
                    // that silently stops early.
                    console.error("memory export stream failed", error);
                    logSecurityAuditEvent("memory.export.download", {
                        userId,
                        outcome: "failure",
                    });
                    controller.error(error);
                }
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Disposition":
                    'attachment; filename="tomverse-memories.json"',
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    } catch (error) {
        if (isAdminReauthenticationError(error)) {
            return NextResponse.json(
                {
                    error: "Sign in again before exporting your memories.",
                    code: "ACCOUNT_REAUTHENTICATION_REQUIRED",
                },
                { status: 428, headers: { "Cache-Control": "no-store" } }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory export failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
