import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { formatConversationAsText } from "@/lib/exportConversation";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";

export async function GET(req: Request) {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string } | undefined)?.id;

    if (!userId) {
        return NextResponse.json({ error: "Login required" }, { status: 401 });
    }

    const conversations = await prisma.conversation.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
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

    const exportableConversations = conversations.filter((conversation) =>
        hasConversationUnlockGrant(
            req,
            userId,
            conversation.id,
            conversation.password
        )
    );
    const lockedCount = conversations.length - exportableConversations.length;
    const lockedNotice = lockedCount
        ? `Tomverse AI Export\n\n${lockedCount} locked conversation(s) were excluded. Unlock them before exporting to include their contents.\n\n`
        : "";
    const text = exportableConversations.length
        ? lockedNotice + exportableConversations
            .map((conversation) => formatConversationAsText(conversation))
            .join("\n\n\n##################################################\n\n\n")
        : lockedNotice || "Tomverse AI Export\n\nNo conversations found.\n";

    return new Response(text, {
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": 'attachment; filename="tomverse-all-conversations.txt"',
            "Cache-Control": "no-store",
        },
    });
}
