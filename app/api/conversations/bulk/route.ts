export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { setConversationsArchived } from "@/lib/conversationArchive";
import {
    CONVERSATION_SELECTION_ACTIONS,
    CONVERSATION_SELECTION_LIMIT,
    uniqueConversationIds,
    type ConversationSelectionResult,
} from "@/lib/conversationBulkActions";
import { deleteOwnedConversations } from "@/lib/conversationDeletion";
import { clearConversationUnlockCookie, hasConversationUnlockGrant } from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Delete, archive or restore several of the account's conversations at once.
 *
 * ## Delete is the single delete, applied to a list
 *
 * Every id is checked the way DELETE /api/conversations/[id] checks one --
 * ownership, then the unlock grant -- and audited with the same
 * `conversation.delete` event. The ids that pass go to
 * `deleteOwnedConversations` (lib/conversationDeletion.ts), the one deletion
 * path the single delete, delete-all and the temporary Chat sweep share: the
 * same attachment, generated-file and image tombstones, Deep Research jobs,
 * project-memory grounds, and the cascade that takes share links and messages.
 * Nothing about deleting is written here.
 *
 * ## What is refused, and what is skipped
 *
 * An id that belongs to another account refuses the whole request before
 * anything is written: a list is one decision, and part of it was not this
 * account's to make. A locked conversation this browser has not unlocked is
 * skipped and named in the answer, exactly as the single delete refuses it,
 * so the rest still go. An id that no longer exists is skipped too.
 *
 * ## Limits
 *
 * At most CONVERSATION_SELECTION_LIMIT ids per request, under a rate limit of
 * its own. Delete-all keeps its own limit: this path cannot delete more than
 * one selection per request, and its request budget is separate and small.
 *
 * Web only: the native and desktop bearer gates do not enrol this path.
 */

const bodySchema = z
    .object({
        action: z.enum(CONVERSATION_SELECTION_ACTIONS),
        conversationIds: z.array(z.string().min(1).max(128)).min(1).max(CONVERSATION_SELECTION_LIMIT),
    })
    .strict();

export async function POST(req: Request) {
    try {
        const authentication = await resolveChatRouteSession(req);
        if (authentication.response) return authentication.response;
        const userId = authentication.session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        }

        const body = await readLimitedJson(req, 16 * 1024, bodySchema);
        await consumeApiRateLimit(
            req,
            userId,
            body.action === "delete" ? "conversation-delete-bulk" : "conversation-archive",
            body.action === "delete" ? { minute: 3, day: 30 } : { minute: 30, day: 500 }
        );
        const ids = uniqueConversationIds(body.conversationIds);

        const rows = await prisma.conversation.findMany({
            where: { id: { in: ids } },
            select: { id: true, userId: true, password: true, passwordVersion: true },
        });
        if (rows.some((row) => row.userId !== userId)) {
            return NextResponse.json(
                { error: "You do not have access to one of these conversations.", code: "CONVERSATION_NOT_OWNED" },
                { status: 403 }
            );
        }
        const found = new Set(rows.map((row) => row.id));
        const skipped: ConversationSelectionResult["skipped"] = ids
            .filter((id) => !found.has(id))
            .map((id) => ({ id, reason: "not_found" as const }));

        if (body.action !== "delete") {
            const done = await setConversationsArchived(prisma, {
                userId,
                conversationIds: rows.map((row) => row.id),
                archived: body.action === "archive",
            });
            const applied = new Set(done);
            for (const row of rows) {
                // A temporary Chat: owned, but not a conversation the list shows.
                if (!applied.has(row.id)) skipped.push({ id: row.id, reason: "not_found" });
            }
            return NextResponse.json({ done, skipped } satisfies ConversationSelectionResult);
        }

        const allowed: string[] = [];
        for (const row of rows) {
            logSecurityAuditEvent("conversation.delete", {
                userId,
                resourceId: row.id,
                request: req,
                outcome: "attempt",
            });
            if (!hasConversationUnlockGrant(req, userId, row.id, row.password == null ? null : row.passwordVersion)) {
                logSecurityAuditEvent("conversation.delete", {
                    userId,
                    resourceId: row.id,
                    request: req,
                    outcome: "denied",
                    reason: "CONVERSATION_LOCKED",
                });
                skipped.push({ id: row.id, reason: "locked" });
                continue;
            }
            allowed.push(row.id);
        }

        const deleted = allowed.length
            ? await prisma.$transaction((tx) => deleteOwnedConversations(tx, { userId, conversationIds: allowed }))
            : { count: 0, conversationIds: [] as string[] };
        const removed = new Set(deleted.conversationIds);
        for (const id of allowed) {
            if (removed.has(id)) {
                logSecurityAuditEvent("conversation.delete", {
                    userId,
                    resourceId: id,
                    request: req,
                    outcome: "success",
                });
            } else {
                // Deleted elsewhere between the read and the transaction.
                skipped.push({ id, reason: "not_found" });
            }
        }

        const response = NextResponse.json({ done: deleted.conversationIds, skipped } satisfies ConversationSelectionResult);
        for (const row of rows) {
            // The unlock cookie exists only for a locked conversation.
            if (row.password && removed.has(row.id)) {
                response.headers.append("Set-Cookie", clearConversationUnlockCookie(row.id));
            }
        }
        return response;
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to update the selected conversations:", error);
        return NextResponse.json({ error: "Failed to update the selected conversations." }, { status: 500 });
    }
}
