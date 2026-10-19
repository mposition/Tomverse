import "server-only";

import type { Prisma } from "@prisma/client";
import { AUTO_LLM_ROUTER_DEFAULT_GUIDANCE } from "@/lib/autoLlmRouterCore";
import {
    parseActiveRouterGuidance,
    type ActiveRouterGuidance,
} from "@/lib/autoRouterOptimizerCore";
import { prisma } from "@/lib/prisma";

/**
 * The router guidance promoted from an optimizer cycle (Admin › Routing).
 *
 * No row is the code default. Kept out of lib/appSettings.ts for the same
 * reason as lib/autoLlmRouterSettings.ts: that file is inside the Prompt
 * Refiner runtime source closure.
 */
export const AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY = "auto.llmRouterGuidance";

export const DEFAULT_ROUTER_GUIDANCE: ActiveRouterGuidance = {
    guidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    cycleId: null,
    history: [],
};

type Reader = Pick<Prisma.TransactionClient, "appSetting">;

/**
 * The guidance in force. Never throws: an unreadable or malformed row reads
 * as the default, so a broken setting costs the router its tuning, not a turn.
 */
export async function readActiveRouterGuidance(
    db: Reader = prisma
): Promise<ActiveRouterGuidance> {
    try {
        const row = await db.appSetting.findUnique({
            where: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY },
            select: { value: true },
        });
        return parseActiveRouterGuidance(row?.value) ?? DEFAULT_ROUTER_GUIDANCE;
    } catch {
        return DEFAULT_ROUTER_GUIDANCE;
    }
}

/** Writes the guidance in force; the code default is stored as no row. */
export async function writeActiveRouterGuidance(
    tx: Prisma.TransactionClient,
    value: ActiveRouterGuidance
): Promise<void> {
    if (value.cycleId === null) {
        await tx.appSetting.deleteMany({ where: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY } });
        return;
    }
    const stored = JSON.stringify(value);
    await tx.appSetting.upsert({
        where: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY },
        create: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY, value: stored },
        update: { value: stored },
    });
}
