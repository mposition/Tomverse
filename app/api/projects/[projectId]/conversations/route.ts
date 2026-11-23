export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadOwnedProject } from "@/lib/projectWorkspaceService";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

/** The project's conversations, newest first, for the workspace's Conversations tab. */
export async function GET(req: Request, context: { params: Promise<{ projectId: string }> }) {
    try {
        const auth = await projectRouteUser(req, "project-read", { minute: 120, day: 10_000 });
        if (auth.response) return auth.response;
        const { projectId } = await context.params;
        await loadOwnedProject(auth.userId, projectId);
        const rows = await prisma.conversation.findMany({
            where: { userId: auth.userId, projectId },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
            take: 200,
            select: {
                id: true, title: true, productKey: true, kind: true, updatedAt: true, password: true,
                continuationBridge: { select: { provider: true } },
                _count: { select: { messages: true } },
            },
        });
        return NextResponse.json({
            conversations: rows.map((row) => ({
                id: row.id,
                title: row.password ? null : row.title,
                productKey: row.productKey,
                kind: row.kind,
                locked: row.password !== null,
                continuation: row.continuationBridge ? { provider: row.continuationBridge.provider } : null,
                messageCount: row._count.messages,
                updatedAt: row.updatedAt.toISOString(),
            })),
        }, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.conversations");
    }
}
