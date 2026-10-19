import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Which model makes Auto's per-prompt choice (lib/autoLlmRouter.ts), set from
 * Admin Console › Routing.
 *
 * No row means off: Auto keeps its deterministic choice and makes no extra
 * call. Kept out of lib/appSettings.ts on purpose -- that file is inside the
 * Prompt Refiner runtime source closure, where a new import or function moves
 * a pinned inventory.
 */
export const AUTO_LLM_ROUTER_MODEL_SETTING_KEY = "auto.llmRouterModelId";

/** The configured model id, or null when off or unreadable. Never throws. */
export async function readAutoLlmRouterModelId(): Promise<string | null> {
    try {
        const row = await prisma.appSetting.findUnique({
            where: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY },
            select: { value: true },
        });
        const value = row?.value.trim();
        return value ? value : null;
    } catch {
        // A routing aid must not fail the turn; unreadable reads as off.
        return null;
    }
}

/** Null turns the LLM pick off by removing the row. */
export async function writeAutoLlmRouterModelId(
    modelId: string | null
): Promise<void> {
    if (modelId === null) {
        await prisma.appSetting.deleteMany({
            where: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY },
        });
        return;
    }
    await prisma.appSetting.upsert({
        where: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY },
        create: { key: AUTO_LLM_ROUTER_MODEL_SETTING_KEY, value: modelId },
        update: { value: modelId },
    });
}
