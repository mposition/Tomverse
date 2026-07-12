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
        language: z.enum(["en", "ko", "zh", "fr", "de", "es", "pt"]).optional(),
        defaultModel: z.string().max(100).refine(isEnabledModelId).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0);

const languageSchema = z.enum(["en", "ko", "zh", "fr", "de", "es", "pt"]);

export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        }
        const userId = session.user.id;
        await consumeApiRateLimit(req, userId, "settings-read", {
            minute: 60,
            day: 5_000,
        });

        const requestedLanguage = languageSchema.safeParse(new URL(req.url).searchParams.get("lang"));
        const initialLanguage = requestedLanguage.success
            ? requestedLanguage.data
            : APP_DEFAULTS.defaultLanguage;

        let settings = await prisma.userSettings.findUnique({ where: { userId } });
        if (!settings) {
            settings = await prisma.userSettings.create({
                data: {
                    userId,
                    language: initialLanguage,
                    defaultModel: APP_DEFAULTS.defaultModelId,
                }
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
            defaultModel: settings.defaultModel,
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;

        console.error("Failed to load user settings:", error);
        return NextResponse.json({ error: "Failed to load settings." }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json({ error: "Authentication required." }, { status: 401 });
        }
        const userId = session.user.id;
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
        console.error("Failed to save user settings:", error);
        return NextResponse.json({ error: "Failed to save settings." }, { status: 500 });
    }
}
