import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
    clearLockVerificationAttempts,
    consumeLockVerificationAttempt,
    lockErrorResponse,
} from "@/lib/conversationLock";
import {
    createExternalUnlockCookie,
    verifyExternalConversationAccess,
} from "@/lib/externalConversationLock";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Proves the password and mints a read grant, WITHOUT removing the lock (§7).
 *
 * The attempt limiter is the native path's, not a second one: a per-resource
 * brute-force budget that only counted native conversations would leave the
 * imported ones unprotected, and two limiters drift.
 */

const verifySchema = z
    .object({ password: z.string().min(1).max(128) })
    .strict();

export async function POST(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]">
) {
    const params = await context.params;
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "external-lock-verify", {
            minute: 20,
            day: 300,
        });
        const attempt = await consumeLockVerificationAttempt(
            req,
            session.user.id,
            params.conversationId
        );
        const body = await readLimitedJson(req, 4 * 1024, verifySchema);
        const { storedPassword } = await verifyExternalConversationAccess({
            userId: session.user.id,
            conversationId: params.conversationId,
            password: body.password,
        });
        // Only a success clears the budget: a wrong password has to keep
        // costing an attempt, or the limiter protects nothing.
        await clearLockVerificationAttempts(attempt);
        logSecurityAuditEvent("conversation.lock.verify", {
            userId: session.user.id,
            resourceId: params.conversationId,
            request: req,
        });
        return NextResponse.json(
            { verified: true },
            {
                headers: {
                    "Cache-Control": "no-store",
                    "Set-Cookie": createExternalUnlockCookie(
                        session.user.id,
                        params.conversationId,
                        storedPassword
                    ),
                },
            }
        );
    } catch (error) {
        const lockResponse = lockErrorResponse(error);
        if (lockResponse) return lockResponse;
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external conversation verify failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
