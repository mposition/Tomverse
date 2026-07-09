export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { isEnabledModelId } from "@/lib/models";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";

const settingsSchema = z
    .object({
        theme: z.enum(["dark", "light", "system"]).optional(),
        language: z.enum(["en", "ko", "zh"]).optional(),
        defaultModel: z.string().max(100).refine(isEnabledModelId).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0);

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
                data: { userId, defaultModel: APP_DEFAULTS.defaultModelId }
            });
        } else if (!isEnabledModelId(settings.defaultModel)) {
            settings = await prisma.userSettings.update({
                where: { userId },
                data: { defaultModel: APP_DEFAULTS.defaultModelId },
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
        await consumeApiRateLimit(req, userId, "settings-save", {
            minute: 10,
            day: 100,
        });
        const { theme, language, defaultModel } = await readLimitedJson(
            req,
            4 * 1024,
            settingsSchema
        );

        const updatedSettings = await prisma.userSettings.upsert({
            where: { userId },
            update: {
                ...(theme !== undefined ? { theme } : {}),
                ...(language !== undefined ? { language } : {}),
                ...(defaultModel !== undefined ? { defaultModel } : {}),
            },
            create: {
                userId,
                theme: theme || APP_DEFAULTS.defaultTheme,
                language: language || APP_DEFAULTS.defaultLanguage,
                defaultModel: defaultModel || APP_DEFAULTS.defaultModelId,
            },
        });

        return NextResponse.json({ success: true, settings: updatedSettings });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("설정 저장 에러:", error);
        return NextResponse.json({ error: "설정 저장 실패" }, { status: 500 });
    }
}
