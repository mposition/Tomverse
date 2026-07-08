import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { formatConversationAsText } from "@/lib/exportConversation";

export async function GET() {
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

    const text = conversations.length
        ? conversations
            .map((conversation) => formatConversationAsText(conversation))
            .join("\n\n\n##################################################\n\n\n")
        : "Tomverse AI Export\n\nNo conversations found.\n";

    return new Response(text, {
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": 'attachment; filename="tomverse-all-conversations.txt"',
            "Cache-Control": "no-store",
        },
    });
}
