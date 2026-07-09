import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    clearLockVerificationAttempts,
    consumeLockVerificationAttempt,
    createConversationUnlockCookie,
    hashConversationPassword,
    lockErrorResponse,
    verifyConversationPassword,
} from "@/lib/conversationLock";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

const verifyConversationSchema = z
    .object({
        password: z.string().min(1).max(128),
    })
    .strict();

export async function POST(req: Request, context: any) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }

        const userId = (session.user as any).id;
        await consumeApiRateLimit(req, userId, "conversation-lock-verify", {
            minute: 10,
            day: 100,
        });
        const { password } = await readLimitedJson(
            req,
            2 * 1024,
            verifyConversationSchema
        );
        const params = await context.params;
        const conversationId = params.conversationId;

        const conversation = await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { id: true, userId: true, password: true },
        });

        if (!conversation || conversation.userId !== userId) {
            return NextResponse.json(
                { error: "접근 권한이 없습니다." },
                { status: 403 }
            );
        }
        if (!conversation.password) {
            return NextResponse.json(
                { success: false, error: "잠금이 설정되지 않은 대화방입니다." },
                { status: 400 }
            );
        }
        logSecurityAuditEvent("conversation.lock.verify", {
            userId,
            resourceId: conversationId,
            request: req,
            outcome: "attempt",
        });

        const attempt = await consumeLockVerificationAttempt(
            req,
            userId,
            conversationId
        );
        const verification = await verifyConversationPassword(
            password,
            conversation.password
        );

        if (!verification.matches) {
            logSecurityAuditEvent("conversation.lock.verify", {
                userId,
                resourceId: conversationId,
                request: req,
                outcome: "denied",
                reason: "INVALID_LOCK_PASSWORD",
            });
            return NextResponse.json(
                { success: false, error: "비밀번호가 일치하지 않습니다." },
                { status: 403 }
            );
        }

        let effectivePassword = conversation.password;
        if (verification.needsUpgrade) {
            const upgradedPassword = await hashConversationPassword(password);
            await prisma.conversation.updateMany({
                where: {
                    id: conversationId,
                    password: conversation.password,
                },
                data: { password: upgradedPassword },
            });
            effectivePassword = upgradedPassword;
        }
        await clearLockVerificationAttempts(attempt);
        logSecurityAuditEvent("conversation.lock.verify", {
            userId,
            resourceId: conversationId,
            request: req,
            outcome: "success",
        });
        const response = NextResponse.json({ success: true });
        response.headers.append(
            "Set-Cookie",
            createConversationUnlockCookie(
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

        console.error("Conversation lock verification failed:", error);
        return NextResponse.json(
            { success: false, error: "비밀번호 확인에 실패했습니다." },
            { status: 500 }
        );
    }
}
