export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";

// 💡 1. 사용자 설정 불러오기 (GET)
export async function GET() {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user || !(session.user as any).id) {
            return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
        }
        const userId = (session.user as any).id;

        let settings = await prisma.userSettings.findUnique({ where: { userId } });
        if (!settings) {
            settings = await prisma.userSettings.create({
                data: { userId, defaultModel: "gpt-4o" }
            });
        }

        return NextResponse.json({
            theme: settings.theme,
            language: settings.language,
            defaultModel: settings.defaultModel, // 💡 전달
        });
    } catch (error) {
        console.error("설정 조회 에러:", error);
        return NextResponse.json({ error: "설정 조회 실패" }, { status: 500 });
    }
}

// 💡 2. 사용자 설정 저장하기 (POST)
export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user || !(session.user as any).id) {
            return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
        }
        const userId = (session.user as any).id;
        const body = await req.json();

        const { theme, language, defaultModel } = body;

        const updatedSettings = await prisma.userSettings.upsert({
            where: { userId },
            update: {
                theme: theme || "dark",
                language: language || "ko",
                defaultModel: defaultModel || "gpt-4o",
            },
            create: {
                userId,
                theme: theme || "dark",
                language: language || "ko",
                defaultModel: defaultModel || "gpt-4o",
            },
        });

        return NextResponse.json({ success: true, settings: updatedSettings });
    } catch (error) {
        console.error("설정 저장 에러:", error);
        return NextResponse.json({ error: "설정 저장 실패" }, { status: 500 });
    }
}