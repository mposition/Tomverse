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
    createResourceUnlockCookie,
    hashConversationPassword,
    lockErrorResponse,
    verifyConversationPassword,
} from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Unlocking one imported snapshot for this browser (policy §7).
 *
 * The native conversation verify route, applied to the other resource type:
 * same attempt limits, same grant TTL, same legacy-hash upgrade on a
 * successful check. It differs in exactly one argument — the resource type —
 * and that argument is what keeps the grant from opening a Conversation whose
 * id happens to match.
 */

const verifySchema = z
    .object({ password: z.string().min(1).max(128) })
    .strict();

export async function POST(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]/lock/verify">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        const userId = session.user.id;
        await consumeApiRateLimit(req, userId, "external-lock-verify", {
            minute: 10,
            day: 100,
        });
        const { password } = await readLimitedJson(req, 2 * 1024, verifySchema);
        const params = await context.params;
        const conversationId = params.conversationId;

        const row = await prisma.externalConversation.findUnique({
            where: { id: conversationId },
            select: { userId: true, finalized: true, password: true },
        });
        if (!row || row.userId !== userId || !row.finalized) {
            return NextResponse.json(
                { error: "Conversation not found." },
                { status: 404 }
            );
        }
        if (!row.password) {
            return NextResponse.json(
                { success: false, error: "This conversation is not locked." },
                { status: 400 }
            );
        }

        logSecurityAuditEvent("external_conversation.lock.verify", {
            userId,
            resourceId: conversationId,
            request: req,
            outcome: "attempt",
        });

        const attempt = await consumeLockVerificationAttempt(
            req,
            userId,
            conversationId,
            "external_conversation"
        );
        const verification = await verifyConversationPassword(
            password,
            row.password
        );
        if (!verification.matches) {
            logSecurityAuditEvent("external_conversation.lock.verify", {
                userId,
                resourceId: conversationId,
                request: req,
                outcome: "denied",
                reason: "INVALID_LOCK_PASSWORD",
            });
            return NextResponse.json(
                { success: false, error: "Invalid password." },
                { status: 403 }
            );
        }

        // No snapshot can hold a legacy plaintext password -- the column was
        // introduced already hashed -- but the branch is kept rather than
        // asserted away, so that if a future path ever writes one, unlocking
        // upgrades it instead of leaving it in place.
        let effectivePassword = row.password;
        if (verification.needsUpgrade) {
            const upgraded = await hashConversationPassword(password);
            await prisma.externalConversation.updateMany({
                where: { id: conversationId, password: row.password },
                data: { password: upgraded },
            });
            effectivePassword = upgraded;
        }

        await clearLockVerificationAttempts(attempt);
        logSecurityAuditEvent("external_conversation.lock.verify", {
            userId,
            resourceId: conversationId,
            request: req,
            outcome: "success",
        });

        const response = NextResponse.json(
            { success: true },
            { headers: { "Cache-Control": "no-store" } }
        );
        response.headers.append(
            "Set-Cookie",
            createResourceUnlockCookie(
                "external_conversation",
                userId,
                conversationId,
                effectivePassword
            )
        );
        return response;
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        const lockError = lockErrorResponse(error);
        if (lockError) return lockError;
        console.error("external conversation unlock failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
