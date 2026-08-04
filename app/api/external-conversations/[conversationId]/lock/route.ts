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
    clearExternalUnlockCookie,
    lockExternalConversation,
    unlockExternalConversation,
} from "@/lib/externalConversationLock";

/**
 * Sets or removes the password on an imported conversation (§7, §7.1).
 *
 * Two verbs, two intents:
 *
 *   POST   — lock it. Suspends the memories it alone grounded, in the same
 *            transaction, so the lock and what it silences can never disagree.
 *   DELETE — unlock it for good. Requires the password, and restores the
 *            memories the lock suspended.
 *
 * "Let me read this now" is a third intent and lives at ../verify: an endpoint
 * that both proved a password and removed the lock would disarm it every time
 * someone opened the conversation.
 *
 * Deliberately no rollout-flag gate. §15's rollback contract is that turning
 * the import feature off must never strand a user's data — and a lock they
 * cannot remove is exactly that.
 */

const lockSchema = z.object({ password: z.string().min(8).max(128) }).strict();
const unlockSchema = z
    .object({ password: z.string().min(1).max(128) })
    .strict();

export async function POST(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "external-lock-set", {
            minute: 10,
            day: 100,
        });
        const params = await context.params;
        const body = await readLimitedJson(req, 4 * 1024, lockSchema);
        const outcome = await lockExternalConversation({
            userId: session.user.id,
            conversationId: params.conversationId,
            password: body.password,
        });
        return NextResponse.json(
            { locked: true, suspendedMemories: outcome.suspendedMemories },
            {
                headers: {
                    "Cache-Control": "no-store",
                    // Any grant the browser held is for the previous password.
                    "Set-Cookie": clearExternalUnlockCookie(
                        params.conversationId
                    ),
                },
            }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external conversation lock failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}

export async function DELETE(
    req: Request,
    context: RouteContext<"/api/external-conversations/[conversationId]">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "external-lock-remove", {
            minute: 10,
            day: 100,
        });
        const params = await context.params;
        const body = await readLimitedJson(req, 4 * 1024, unlockSchema);
        const outcome = await unlockExternalConversation({
            userId: session.user.id,
            conversationId: params.conversationId,
            password: body.password,
        });
        return NextResponse.json(
            { locked: false, restoredMemories: outcome.restoredMemories },
            {
                headers: {
                    "Cache-Control": "no-store",
                    "Set-Cookie": clearExternalUnlockCookie(
                        params.conversationId
                    ),
                },
            }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external conversation unlock failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
