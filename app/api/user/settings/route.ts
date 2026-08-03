export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { getUserBillingPlan } from "@/lib/billingEntitlements";
import {
    getRuntimeModels,
    isEnabledRuntimeModelId,
} from "@/lib/modelRegistry";
import {
    moveCombinationLead,
    normalizeNewConversationModelIdsForWrite,
    parseStoredNewConversationModelIds,
    resolveNewConversationModels,
    NEW_CONVERSATION_MODELS_MAX,
} from "@/lib/newConversationModels";
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
        newConversationModelIds: z
            .array(z.string().trim().min(1).max(120))
            .min(1)
            .max(NEW_CONVERSATION_MODELS_MAX)
            .optional(),
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
        }

        // Read path: never rewrite the stored default model or combination.
        // A stored model that is no longer selectable is resolved to an
        // effective state and reported; only an explicit user save or an
        // approved retirement reconciliation persists a change
        // (docs/policy/default-model-luna-migration.md §1.2).
        const [models, billingPlan] = await Promise.all([
            getRuntimeModels(),
            getUserBillingPlan(userId),
        ]);
        const resolved = resolveNewConversationModels({
            stored: settings.newConversationModelIds,
            defaultModel: settings.defaultModel,
            models,
            plan: billingPlan.tier,
        });
        if (resolved.reasons.length > 0) {
            console.warn(
                "user-settings.model-selection-drift",
                JSON.stringify({
                    userId,
                    storedDefaultModelId: settings.defaultModel,
                    storedModelIds: resolved.storedModelIds,
                    effectiveModelIds: resolved.effectiveModelIds,
                    reasons: resolved.reasons,
                    changed: resolved.changed,
                })
            );
        }

        return NextResponse.json({
            theme: settings.theme,
            language: settings.language,
            defaultModel: resolved.effectiveDefaultModelId,
            defaultModelId: resolved.effectiveDefaultModelId,
            newConversationModelIds: resolved.effectiveModelIds,
            modelSelectionNotice: resolved.changed
                ? {
                      reasons: resolved.reasons,
                      storedDefaultModelId: settings.defaultModel,
                      storedModelIds: resolved.storedModelIds,
                      effectiveModelIds: resolved.effectiveModelIds,
                  }
                : null,
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
        const {
            theme,
            language,
            defaultModel,
            newConversationModelIds,
            timeZone,
            timeZoneSource,
        } = await readLimitedJson(req, 4 * 1024, settingsSchema);

        // Explicit combination save: every model must be selectable right now
        // on this account's plan, and the representative model is always the
        // combination's first item. Both fields land in the same transaction.
        let normalizedCombination: string[] | null = null;
        if (newConversationModelIds !== undefined) {
            const [models, billingPlan] = await Promise.all([
                getRuntimeModels(),
                getUserBillingPlan(userId),
            ]);
            const normalized = normalizeNewConversationModelIdsForWrite({
                requested: newConversationModelIds,
                models,
                plan: billingPlan.tier,
            });
            if (!normalized.ok) {
                return NextResponse.json(
                    {
                        error: "The new conversation combination is not valid for this account.",
                        code: "NEW_CONVERSATION_MODELS_INVALID",
                        rejection: normalized.rejection,
                        ...(normalized.modelId ? { modelId: normalized.modelId } : {}),
                    },
                    { status: 400 }
                );
            }
            if (
                defaultModel !== undefined &&
                defaultModel !== normalized.modelIds[0]
            ) {
                return NextResponse.json(
                    {
                        error: "defaultModel must match the first model of the combination.",
                        code: "DEFAULT_MODEL_LEAD_MISMATCH",
                    },
                    { status: 400 }
                );
            }
            normalizedCombination = normalized.modelIds;
        } else if (defaultModel && !(await isEnabledRuntimeModelId(defaultModel))) {
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

            // Model fields always move together, in this transaction:
            //   * explicit combination -> lead becomes defaultModel;
            //   * legacy defaultModel-only -> the new lead moves to the front
            //     of the existing combination (order kept, deduped, at most
            //     the maximum, LAST item dropped on overflow), or [lead] when
            //     no combination was ever saved.
            const modelWrite = normalizedCombination
                ? {
                      defaultModel: normalizedCombination[0],
                      newConversationModelIds: normalizedCombination,
                  }
                : defaultModel !== undefined
                  ? {
                        defaultModel,
                        newConversationModelIds: moveCombinationLead(
                            parseStoredNewConversationModelIds(
                                current?.newConversationModelIds
                            ).modelIds,
                            defaultModel
                        ),
                    }
                  : {};

            return tx.userSettings.upsert({
                where: { userId },
                update: {
                    ...(theme !== undefined ? { theme } : {}),
                    ...(language !== undefined ? { language } : {}),
                    ...modelWrite,
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
                    defaultModel:
                        normalizedCombination?.[0] ||
                        defaultModel ||
                        APP_DEFAULTS.defaultModelId,
                    ...(normalizedCombination
                        ? { newConversationModelIds: normalizedCombination }
                        : defaultModel
                          ? { newConversationModelIds: [defaultModel] }
                          : {}),
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
