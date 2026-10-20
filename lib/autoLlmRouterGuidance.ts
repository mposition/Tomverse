import "server-only";

import type { Prisma } from "@prisma/client";
import {
    AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE,
    type AutoLlmRouterGuidanceKind,
} from "@/lib/autoLlmRouterCore";
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

/**
 * The rewrite guidance: the improvable sentence of the rewrite rule
 * (lib/autoLlmRouterCore.ts). Same record shape and the same parse, promote
 * and rollback helpers as the routing guidance; only the key and the default
 * differ. It is read only when rewriting is on.
 */
export const AUTO_LLM_ROUTER_REWRITE_GUIDANCE_SETTING_KEY = "auto.llmRouterRewriteGuidance";

export type RouterGuidanceKind = AutoLlmRouterGuidanceKind;

export const DEFAULT_ROUTER_GUIDANCE: ActiveRouterGuidance = {
    guidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    cycleId: null,
    history: [],
};

export const DEFAULT_ROUTER_REWRITE_GUIDANCE: ActiveRouterGuidance = {
    guidance: AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE,
    cycleId: null,
    history: [],
};

const SLOTS: Record<RouterGuidanceKind, { key: string; fallback: ActiveRouterGuidance }> = {
    routing: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY, fallback: DEFAULT_ROUTER_GUIDANCE },
    rewrite: { key: AUTO_LLM_ROUTER_REWRITE_GUIDANCE_SETTING_KEY, fallback: DEFAULT_ROUTER_REWRITE_GUIDANCE },
};

type Reader = Pick<Prisma.TransactionClient, "appSetting">;

/**
 * The guidance in force. Never throws: an unreadable or malformed row reads
 * as the default, so a broken setting costs the router its tuning, not a turn.
 */
export async function readActiveRouterGuidance(
    db: Reader = prisma,
    kind: RouterGuidanceKind = "routing"
): Promise<ActiveRouterGuidance> {
    const slot = SLOTS[kind];
    try {
        const row = await db.appSetting.findUnique({
            where: { key: slot.key },
            select: { value: true },
        });
        return parseActiveRouterGuidance(row?.value) ?? slot.fallback;
    } catch {
        return slot.fallback;
    }
}

/** Writes the guidance in force; the code default is stored as no row. */
export async function writeActiveRouterGuidance(
    tx: Prisma.TransactionClient,
    value: ActiveRouterGuidance,
    kind: RouterGuidanceKind = "routing"
): Promise<void> {
    const { key } = SLOTS[kind];
    if (value.cycleId === null) {
        await tx.appSetting.deleteMany({ where: { key } });
        return;
    }
    const stored = JSON.stringify(value);
    await tx.appSetting.upsert({
        where: { key },
        create: { key, value: stored },
        update: { value: stored },
    });
}
