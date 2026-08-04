import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import {
    assertRecentAdminAuthentication,
    isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { deleteAllMemories } from "@/lib/memoryService";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Delete every memory in the account (policy §13.1).
 *
 * Re-authentication gated like the export, and like every other destructive
 * account action in this repo it also wants an explicit typed confirmation
 * rather than a single click.
 *
 * Not rollout-flag gated (§15): a user must always be able to empty their own
 * memory store, most of all while the feature is being turned off.
 *
 * Imported conversations are NOT touched here. They are a separate resource
 * with a separate confirmation, and the service keeps that boundary.
 */

const deleteAllSchema = z
    .object({
        confirm: z.literal(true),
        confirmationText: z.literal("DELETE ALL MEMORIES"),
    })
    .strict();

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await consumeApiRateLimit(req, session.user.id, "memory-delete-all", {
            minute: 2,
            day: 10,
        });
        await assertRecentAdminAuthentication(session);
        await readLimitedJson(req, 1024, deleteAllSchema);

        const result = await deleteAllMemories(session.user.id);
        // Counts only: how many rows went away is operational, what they said
        // is not recorded anywhere (§13.1 "content 없는 최소 audit").
        logSecurityAuditEvent("memory.delete_all", {
            userId: session.user.id,
            request: req,
            outcome: "success",
        });
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (isAdminReauthenticationError(error)) {
            return NextResponse.json(
                {
                    error: "Sign in again before deleting all memories.",
                    code: "ACCOUNT_REAUTHENTICATION_REQUIRED",
                },
                { status: 428, headers: { "Cache-Control": "no-store" } }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory delete-all failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
