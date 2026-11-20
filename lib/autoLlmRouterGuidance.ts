import "server-only";

import type { Prisma } from "@prisma/client";
import {
    AUTO_LLM_ROUTER_CODING_GUIDANCE,
    AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE,
    type AutoLlmRouterGuidanceKind,
} from "@/lib/autoLlmRouterCore";
import { CHAT_IMAGE_ROUTING_CRITERIA } from "@/lib/chatImageIntentCore";
import { IMAGE_CRITERIA_MAX_CHARS } from "@/lib/imageRoutingOptimizerCore";
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

/**
 * The coding guidance: what the external API's Smart Adaptive router follows
 * for coding requests. Its code default is AUTO_LLM_ROUTER_CODING_GUIDANCE;
 * only a coding optimizer cycle promotes into it.
 */
export const AUTO_LLM_ROUTER_CODING_GUIDANCE_SETTING_KEY = "auto.llmRouterCodingGuidance";

/**
 * The image guidance: the criteria Chat's image routing call follows -- when a
 * message is an image request, and which image model and preset make it
 * (CHAT_IMAGE_ROUTING_CRITERIA is its code default). Only an image optimizer
 * cycle (lib/imageRoutingOptimizer.ts) promotes into it.
 */
export const AUTO_LLM_ROUTER_IMAGE_GUIDANCE_SETTING_KEY = "auto.llmRouterImageGuidance";

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

export const DEFAULT_ROUTER_CODING_GUIDANCE: ActiveRouterGuidance = {
    guidance: AUTO_LLM_ROUTER_CODING_GUIDANCE,
    cycleId: null,
    history: [],
};

export const DEFAULT_ROUTER_IMAGE_GUIDANCE: ActiveRouterGuidance = {
    guidance: CHAT_IMAGE_ROUTING_CRITERIA,
    cycleId: null,
    history: [],
};

/** The image criteria are many lines long; a stored one is admitted within its own cap. */
const admitImageGuidance = (raw: unknown): string | null => {
    if (typeof raw !== "string") return null;
    const text = raw.replace(/\r\n?/g, "\n").trim();
    return text && text.length <= IMAGE_CRITERIA_MAX_CHARS ? text : null;
};

const SLOTS: Record<RouterGuidanceKind, { key: string; fallback: ActiveRouterGuidance; admit?: (raw: unknown) => string | null }> = {
    routing: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY, fallback: DEFAULT_ROUTER_GUIDANCE },
    rewrite: { key: AUTO_LLM_ROUTER_REWRITE_GUIDANCE_SETTING_KEY, fallback: DEFAULT_ROUTER_REWRITE_GUIDANCE },
    coding: { key: AUTO_LLM_ROUTER_CODING_GUIDANCE_SETTING_KEY, fallback: DEFAULT_ROUTER_CODING_GUIDANCE },
    image: { key: AUTO_LLM_ROUTER_IMAGE_GUIDANCE_SETTING_KEY, fallback: DEFAULT_ROUTER_IMAGE_GUIDANCE, admit: admitImageGuidance },
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
        return parseActiveRouterGuidance(row?.value, slot.admit) ?? slot.fallback;
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
