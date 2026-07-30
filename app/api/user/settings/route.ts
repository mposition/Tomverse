export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { isEnabledRuntimeModelId } from "@/lib/modelRegistry";
import { getUserChatUsageKey } from "@/lib/chatSecurity";
import { migrateCurrentDailyUsageBuckets } from "@/lib/userDailyUsage";
import {
    DEFAULT_USER_TIME_ZONE,
    getUserTimeZoneChangeAllowedAt,
    isValidIanaTimeZone,
    normalizeIanaTimeZone,
} from "@/lib/userTimeZone";
import { sendAccountWelcomeEmail } from "@/lib/accountEmails";
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
        defaultModel: z.string().min(1).max(120).optional(),
        timeZone: z
            .string()
            .trim()
            .min(1)
            .max(100)
            .refine(isValidIanaTimeZone, "Invalid IANA time zone.")
            .optional(),
        timeZoneSource: z.enum(["browser", "user"]).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0)
    .refine(
        (value) => value.timeZoneSource === undefined || value.timeZone !== undefined,
        "A time zone is required when its source is provided."
    );

const languageSchema = z.enum(["en", "ko", "zh", "fr", "de", "es", "pt"]);

class TimeZoneChangeCooldownError extends Error {
    readonly retryAt: Date;

    constructor(retryAt: Date) {
        super("The account time zone can only be changed once every 30 days.");
        this.name = "TimeZoneChangeCooldownError";
        this.retryAt = retryAt;
    }
}

const timeZonePayload = (settings: {
    timeZone: string;
    timeZoneInitializedAt: Date | null;
    timeZoneChangedAt: Date | null;
}) => {
    const allowedAt = getUserTimeZoneChangeAllowedAt(settings.timeZoneChangedAt);
    return {
        timeZone: normalizeIanaTimeZone(settings.timeZone),
        timeZoneInitializedAt:
            settings.timeZoneInitializedAt?.toISOString() || null,
        timeZoneChangedAt: settings.timeZoneChangedAt?.toISOString() || null,
        timeZoneChangeAllowedAt: allowedAt?.toISOString() || null,
    };
};

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
        // Only true for the exact request that creates the row -- the one
        // moment the server can tell "brand new account" apart from
        // "existing account whose default model happens to still be the
        // seeded one." Drives the client's first-load model-panel count.
        let isNewAccount = false;
        if (!settings) {
            settings = await prisma.userSettings.create({
                data: {
                    userId,
                    language: initialLanguage,
                    defaultModel: APP_DEFAULTS.defaultModelId,
                }
            });
            isNewAccount = true;
            await sendAccountWelcomeEmail({
                to: session.user.email,
                name: session.user.name,
                language: settings.language,
            }).catch((error) => {
                console.error("Account welcome email failed:", error);
            });
        } else if (!(await isEnabledRuntimeModelId(settings.defaultModel))) {
            settings = await prisma.userSettings.update({
                where: { userId },
                data: { defaultModel: APP_DEFAULTS.defaultModelId },
            });
        }

        return NextResponse.json({
            theme: settings.theme,
            language: settings.language,
            defaultModel: settings.defaultModel,
            defaultModelId: settings.defaultModel,
            isNewAccount,
            preferredTasks: settings.preferredTasks,
            preferredPriority: settings.preferredPriority,
            usesFilesFrequently: settings.usesFilesFrequently,
            modelFinderCompletedAt: settings.modelFinderCompletedAt?.toISOString() || null,
            modelFinderDismissedAt: settings.modelFinderDismissedAt?.toISOString() || null,
            ...timeZonePayload(settings),
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
        const { theme, language, defaultModel, timeZone, timeZoneSource } = await readLimitedJson(
            req,
            4 * 1024,
            settingsSchema
        );
        if (defaultModel && !(await isEnabledRuntimeModelId(defaultModel))) {
            return NextResponse.json({ error: "Unsupported default model." }, { status: 400 });
        }
        const requestedTimeZone =
            timeZone === undefined
                ? undefined
                : normalizeIanaTimeZone(timeZone);
        const now = new Date();
        const usageKey = getUserChatUsageKey(userId);

        const updatedSettings = await prisma.$transaction(async (tx) => {
            // Chat reservations use the same lock. A time-zone change therefore
            // cannot race a request into the old daily usage bucket.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${usageKey}))`;
            const current = await tx.userSettings.findUnique({
                where: { userId },
            });
            const currentTimeZone = normalizeIanaTimeZone(current?.timeZone);
            const effectiveRequestedTimeZone =
                timeZoneSource === "browser" && current?.timeZoneInitializedAt
                    ? currentTimeZone
                    : requestedTimeZone;
            const timeZoneChanged =
                effectiveRequestedTimeZone !== undefined &&
                effectiveRequestedTimeZone !== currentTimeZone;

            if (
                timeZoneSource !== "browser" &&
                timeZoneChanged &&
                current?.timeZoneChangedAt
            ) {
                const allowedAt = getUserTimeZoneChangeAllowedAt(
                    current.timeZoneChangedAt
                );
                if (allowedAt && allowedAt.getTime() > now.getTime()) {
                    throw new TimeZoneChangeCooldownError(allowedAt);
                }
            }

            if (timeZoneChanged && effectiveRequestedTimeZone) {
                await migrateCurrentDailyUsageBuckets(tx, {
                    key: usageKey,
                    previousTimeZone: currentTimeZone,
                    nextTimeZone: effectiveRequestedTimeZone,
                    now,
                });
            }

            return tx.userSettings.upsert({
                where: { userId },
                update: {
                    ...(theme !== undefined ? { theme } : {}),
                    ...(language !== undefined ? { language } : {}),
                    ...(defaultModel !== undefined ? { defaultModel } : {}),
                    ...(effectiveRequestedTimeZone !== undefined
                        ? {
                              timeZone: effectiveRequestedTimeZone,
                              ...(!current?.timeZoneInitializedAt
                                  ? { timeZoneInitializedAt: now }
                                  : {}),
                              ...(timeZoneSource !== "browser" && timeZoneChanged
                                  ? { timeZoneChangedAt: now }
                                  : {}),
                          }
                        : {}),
                },
                create: {
                    userId,
                    theme: theme || APP_DEFAULTS.defaultTheme,
                    language: language || APP_DEFAULTS.defaultLanguage,
                    defaultModel: defaultModel || APP_DEFAULTS.defaultModelId,
                    timeZone: effectiveRequestedTimeZone || DEFAULT_USER_TIME_ZONE,
                    timeZoneInitializedAt:
                        effectiveRequestedTimeZone !== undefined ? now : null,
                    timeZoneChangedAt: null,
                },
            });
        });

        return NextResponse.json({
            success: true,
            settings: {
                ...updatedSettings,
                ...timeZonePayload(updatedSettings),
            },
        });
    } catch (error) {
        if (error instanceof TimeZoneChangeCooldownError) {
            return NextResponse.json(
                {
                    error: error.message,
                    code: "TIME_ZONE_CHANGE_COOLDOWN",
                    retryAt: error.retryAt.toISOString(),
                },
                { status: 409 }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("Failed to save user settings:", error);
        return NextResponse.json({ error: "Failed to save settings." }, { status: 500 });
    }
}
