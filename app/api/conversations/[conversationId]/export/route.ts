import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { formatConversationAsText, sanitizeFileName } from "@/lib/exportConversation";

export async function GET(
    _req: Request,
    context: { params: Promise<{ conversationId: string }> }
) {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string } | undefined)?.id;

    if (!userId) {
        return NextResponse.json({ error: "Login required" }, { status: 401 });
    }

    const { conversationId } = await context.params;

    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId },
        include: {
            messages: {
                orderBy: { createdAt: "asc" },
                select: {
                    role: true,
                    content: true,
                    modelId: true,
                    createdAt: true,
                },
            },
        },
    });

    if (!conversation) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const text = formatConversationAsText(conversation);
    const fileName = `${sanitizeFileName(conversation.title)}.txt`;

    return new Response(text, {
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
            "Cache-Control": "no-store",
        },
    });
}