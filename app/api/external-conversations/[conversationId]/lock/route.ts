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
    clearResourceUnlockCookie,
    consumeLockVerificationAttempt,
    createResourceUnlockCookie,
    hashConversationPassword,
    lockErrorResponse,
    verifyConversationPassword,
} from "@/lib/conversationLock";
import {
    previewExternalConversationLock,
    setExternalConversationLock,
} from "@/lib/externalConversationLockService";
import { prisma } from "@/lib/prisma";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Setting, changing and removing the lock on one imported snapshot
 * (policy §7, §7.1).
 *
 * The rules are the native conversation lock's, deliberately: changing or
 * removing a lock proves the current password, setting one on an unlocked
 * snapshot does not. Both proofs go through the same attempt limiter, so an
 * attacker with a live session cannot grind the password here at a different
 * rate than at the verify endpoint.
 *
 * Its own route rather than a PATCH on the snapshot, because a snapshot is
 * immutable (§4.2) — the lock is the only mutable thing about it, and a
 * general update route would invite the second one.
 */

const lockSchema = z
    .object({
        password: z.union([z.string().min(8).max(128), z.null()]),
        currentPassword: z.string().min(1).max(128).optional(),
    })
    .strict();

const RATE = { minute: 10, day: 100 } as const;

const notFound = () =>
    NextResponse.json({ error: "Conversation not found." }, { status: 404 });

/**
 * What locking this snapshot would cost the account's memory, so the
 * confirmation can state it before the user commits (§7.1, §13.1's pattern).
 */
export async function GET(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]/lock">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        const userId = session.user.id;
        await consumeApiRateLimit(req, userId, "external-lock-preview", {
            minute: 30,
            day: 500,
        });

        const params = await context.params;
        const row = await prisma.externalConversation.findFirst({
            where: { id: params.conversationId, userId, finalized: true },
            select: { password: true },
        });
        if (!row) return notFound();

        return NextResponse.json(
            {
                locked: row.password != null,
                memoryImpact: await previewExternalConversationLock(
                    userId,
                    params.conversationId
                ),
            },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external conversation lock preview failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}

export async function PUT(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]/lock">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        const userId = session.user.id;
        await consumeApiRateLimit(req, userId, "external-lock-write", RATE);
        const body = await readLimitedJson(req, 2 * 1024, lockSchema);
        const params = await context.params;
        const conversationId = params.conversationId;

        const row = await prisma.externalConversation.findUnique({
            where: { id: conversationId },
            select: { userId: true, finalized: true, password: true },
        });
        // One 404 for "does not exist", "not yours" and "not finalized", the
        // same answer every other snapshot surface gives.
        if (!row || row.userId !== userId || !row.finalized) return notFound();

        const event =
            body.password === null
                ? "external_conversation.lock.remove"
                : row.password
                  ? "external_conversation.lock.change"
                  : "external_conversation.lock.set";
        logSecurityAuditEvent(event, {
            userId,
            resourceId: conversationId,
            request: req,
            outcome: "attempt",
        });

        if (body.password === null && !row.password) {
            // Removing a lock that is not there is not an error worth a code:
            // the caller's intent already holds.
            return NextResponse.json(
                { locked: false, memoriesSuspended: 0, memoriesRestored: 0, memoriesExpired: 0 },
                { headers: { "Cache-Control": "no-store" } }
            );
        }

        // Changing or removing an existing lock proves the current password.
        // Without this, anyone who reached a signed-in device could strip the
        // lock, which is the one thing the lock is for.
        if (row.password) {
            if (body.currentPassword === undefined) {
                // Answered exactly like a wrong password, and answered before
                // the limiter runs: a caller that forgot the field has proved
                // nothing, but neither has it guessed, so it must not spend
                // one of the owner's five attempts.
                logSecurityAuditEvent(event, {
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
            const attempt = await consumeLockVerificationAttempt(
                req,
                userId,
                conversationId,
                "external_conversation"
            );
            const verification = await verifyConversationPassword(
                body.currentPassword,
                row.password
            );
            if (!verification.matches) {
                logSecurityAuditEvent(event, {
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
            await clearLockVerificationAttempts(attempt);
        }

        const passwordHash =
            body.password === null
                ? null
                : await hashConversationPassword(body.password);
        const result = await setExternalConversationLock({
            userId,
            conversationId,
            passwordHash,
            request: req,
        });

        const response = NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
        // Whoever just chose the password has proved it as directly as the
        // verify endpoint can, so the grant is issued here rather than making
        // them type it again on the very next read. Removing a lock clears
        // the grant instead: leaving a stale one behind would silently unlock
        // a snapshot re-locked with a different password within the TTL.
        response.headers.append(
            "Set-Cookie",
            passwordHash
                ? createResourceUnlockCookie(
                      "external_conversation",
                      userId,
                      conversationId,
                      passwordHash
                  )
                : clearResourceUnlockCookie(
                      "external_conversation",
                      conversationId
                  )
        );
        return response;
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        const lockError = lockErrorResponse(error);
        if (lockError) return lockError;
        console.error("external conversation lock write failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
