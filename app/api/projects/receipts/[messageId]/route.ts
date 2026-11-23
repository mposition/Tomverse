export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { NO_STORE, projectErrorResponse, projectRouteUser } from "@/lib/projectRouteSupport";

/**
 * The owner-only list of project sources an answer was given. A receipt is
 * a record of what was sent, not proof the model used it, and not a grant:
 * opening an entry goes through /api/projects/[projectId]/sources, which
 * re-checks access.
 */
export async function GET(req: Request, context: { params: Promise<{ messageId: string }> }) {
    try {
        const auth = await projectRouteUser(req, "project-read", { minute: 120, day: 10_000 });
        if (auth.response) return auth.response;
        const { messageId } = await context.params;
        const receipt = await prisma.projectAnswerReceipt.findFirst({
            where: { messageId, userId: auth.userId },
            select: { projectId: true, sources: true, createdAt: true },
        });
        if (!receipt) return NextResponse.json({ receipt: null }, { headers: NO_STORE });
        return NextResponse.json({ receipt: { ...receipt, createdAt: receipt.createdAt.toISOString() } }, { headers: NO_STORE });
    } catch (error) {
        return projectErrorResponse(error, "projects.receipts");
    }
}
