import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function POST(req: Request, context: any) {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "권한 없음" }, { status: 401 });

    const { password } = await req.json();
    const params = await context.params;

    const conversation = await prisma.conversation.findUnique({
        where: { id: params.conversationId }
    });

    const userId = (session.user as any).id;

    if (!conversation || conversation.userId !== userId) {
        return NextResponse.json({ error: "접근 권한이 없습니다." }, { status: 403 });
    }

    if (conversation?.password === password) {
        return NextResponse.json({ success: true });
    } else {
        return NextResponse.json({ success: false, error: "비밀번호가 일치하지 않습니다." }, { status: 403 });
    }
}